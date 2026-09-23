//! "Uninstall Tasma…": the command, the daemon, the application's own files
//! and the bundle, in that order. `~/.tasma` stays.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use objc2_foundation::{NSFileManager, NSString, NSURL, NSUserDefaults};
use tauri::{AppHandle, Manager as _};

use crate::alert::{self, Button, Key};
use crate::command::{
    LINK, LinkState, account_home, bundle_of, cli_beside, installed_executable, link_state,
};
use crate::daemon::Daemon;
use crate::elevate::{self, Outcome, Step};
use crate::{log, menu};

const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/// The CLI's own waits are ten seconds each.
const STOP_LIMIT: Duration = Duration::from_secs(30);
const STOP_TICK: Duration = Duration::from_millis(100);

const TREE: &str = ".tasma";

const CONFIRM_TITLE: &str = "Uninstall Tasma?";
const CONFIRM_TEXT: &str = "Tasma stops its daemon, removes the tasma command, deletes its settings and logs, and moves itself to the Trash. The window closes while Tasma uninstalls. This can take up to a minute. Your projects and tasks in ~/.tasma are kept.";
const CANCEL: Button = Button {
    title: "Cancel",
    key: Key::Escape,
    destructive: false,
};
const UNINSTALL: Button = Button {
    title: "Uninstall",
    key: Key::None,
    destructive: true,
};

const NOT_REMOVED: &str = "Tasma could not remove the tasma command.";

const DONE_TITLE: &str = "Tasma is uninstalled.";
const KEPT: &str = "Your projects and tasks in ~/.tasma are kept.";

/// Whether Uninstall removes what stands at the link. A link to another
/// existing copy belongs to that copy.
fn removes_link(state: &LinkState) -> bool {
    matches!(
        state,
        LinkState::Installed | LinkState::Stale { dangling: true }
    )
}

/// The application's files, each resolved from the home its writer resolves.
#[derive(Debug, PartialEq, Eq)]
struct Files {
    early: Vec<PathBuf>,
    /// AppKit writes these until the application quits.
    late: Vec<PathBuf>,
}

fn files(
    home: Option<&Path>,
    config: Option<PathBuf>,
    account: Option<&Path>,
    identifier: &str,
) -> Files {
    let logs = home.and_then(|home| log::path(home).parent().map(Path::to_path_buf));
    let library = |folder: &str, name: String| {
        account.map(|account| account.join("Library").join(folder).join(name))
    };

    Files {
        early: [
            logs,
            config,
            library("Caches", identifier.to_string()),
            library("WebKit", identifier.to_string()),
            library("HTTPStorages", identifier.to_string()),
        ]
        .into_iter()
        .flatten()
        .collect(),
        late: [
            library(
                "Saved Application State",
                format!("{identifier}.savedState"),
            ),
            library("Preferences", format!("{identifier}.plist")),
        ]
        .into_iter()
        .flatten()
        .collect(),
    }
}

/// The trees no deletion may reach.
fn protected(home: Option<&Path>, account: Option<&Path>) -> Vec<PathBuf> {
    [account, home]
        .into_iter()
        .flatten()
        .map(|home| home.join(TREE))
        .collect()
}

/// Whether deleting `item` could reach a protected tree: the item is inside
/// one, or one is inside the item. The item itself is not resolved, because
/// that would follow a link at its path.
fn reaches_protected(item: &Path, protected: &[PathBuf]) -> std::io::Result<bool> {
    let (Some(parent), Some(name)) = (item.parent(), item.file_name()) else {
        return Ok(true);
    };
    let item = std::fs::canonicalize(parent)?.join(name);

    Ok(protected
        .iter()
        .filter_map(|tree| std::fs::canonicalize(tree).ok())
        .any(|tree| item.starts_with(&tree) || tree.starts_with(&item)))
}

fn delete_one(item: &Path, protected: &[PathBuf]) -> std::io::Result<()> {
    let stats = match std::fs::symlink_metadata(item) {
        Ok(stats) => stats,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };

    if reaches_protected(item, protected)? {
        return Err(std::io::Error::other("it would reach ~/.tasma"));
    }

    if stats.is_dir() {
        std::fs::remove_dir_all(item)
    } else {
        std::fs::remove_file(item)
    }
}

/// Deletes each present item, and answers the ones that could not be deleted.
fn delete(items: &[PathBuf], protected: &[PathBuf]) -> Vec<PathBuf> {
    items
        .iter()
        .filter(|item| delete_one(item, protected).is_err())
        .cloned()
        .collect()
}

/// Runs `<cli> daemon stop`, and answers whether it reported success within
/// the limit. At the limit the child is killed.
fn stop_daemon(cli: &Path, limit: Duration, tick: Duration) -> bool {
    let Ok(mut child) = Command::new(cli)
        .args(["daemon", "stop"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let started = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() < limit => std::thread::sleep(tick),
            _ => {
                let _ = child.kill();
                let _ = child.wait();

                return false;
            }
        }
    }
}

/// Removes the bundle from LaunchServices, so `tasma://` does not start the
/// copy in the Trash.
fn unregister(lsregister: &Path, bundle: &Path) -> bool {
    Command::new(lsregister)
        .arg("-u")
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn trash(bundle: &Path) -> bool {
    let Some(path) = bundle.to_str() else {
        return false;
    };
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));

    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .is_ok()
}

fn forget_defaults(identifier: &str) {
    NSUserDefaults::standardUserDefaults()
        .removePersistentDomainForName(&NSString::from_str(identifier));
}

/// What the daemon stop, the deletion and the move to the Trash could not do.
#[derive(Default)]
struct Failures {
    daemon: bool,
    files: Vec<PathBuf>,
    unregister: bool,
    trash: bool,
}

impl Failures {
    /// No step can be taken as done, with `files` the ones it was to delete.
    fn all(files: Vec<PathBuf>) -> Self {
        Self {
            daemon: true,
            files,
            unregister: true,
            trash: true,
        }
    }
}

/// Steps 4 to 6: the daemon, the early files, LaunchServices and the Trash. A
/// failure does not stop the later steps.
fn tear_down(
    cli: &Path,
    early: &[PathBuf],
    protected: &[PathBuf],
    bundle: Option<&Path>,
) -> Failures {
    Failures {
        daemon: !stop_daemon(cli, STOP_LIMIT, STOP_TICK),
        files: delete(early, protected),
        unregister: !bundle.is_some_and(|bundle| unregister(Path::new(LSREGISTER), bundle)),
        trash: !bundle.is_some_and(trash),
    }
}

fn final_text(failures: &Failures) -> String {
    let mut lines = vec![KEPT.to_string()];

    if failures.daemon {
        lines.push("The daemon could not be stopped. It stops when you restart the Mac.".into());
    }

    if !failures.files.is_empty() {
        let paths: Vec<String> = failures
            .files
            .iter()
            .map(|path| path.display().to_string())
            .collect();

        lines.push(format!(
            "Some files could not be deleted: {}.",
            paths.join(", ")
        ));
    }

    if failures.unregister {
        lines.push(
            "Links that start with tasma:// may still open the copy of Tasma in the Trash.".into(),
        );
    }

    if failures.trash {
        lines.push("Tasma could not move itself to the Trash. In the Applications folder, select Tasma and choose File › Move to Trash.".into());
    }

    lines.join("\n")
}

/// Enables both menu items again and, when given, shows one alert.
async fn stop_here(app: &AppHandle, notice: Option<(&'static str, String)>) {
    let handle = app.clone();

    alert::on_main(app, move |marker| {
        menu::enable(&handle, true);

        if let Some((title, text)) = notice {
            alert::show(marker, title, &text, &[alert::OK], None);
        }
    })
    .await;
}

/// The whole sequence, from the menu item.
pub(crate) async fn run(app: AppHandle, daemon: Arc<Daemon>, uninstalling: Arc<AtomicBool>) {
    let account = account_home();
    let Some(executable) = installed_executable(account.as_deref()) else {
        alert::move_to_applications(&app).await;
        return;
    };

    // Held until the link is removed, so no install can open a second password
    // dialog.
    let Some(running) = elevate::begin() else {
        alert::waiting_for_password(&app).await;
        return;
    };

    let handle = app.clone();
    let confirmed = alert::on_main(&app, move |marker| {
        menu::enable(&handle, false);

        alert::show(
            marker,
            CONFIRM_TITLE,
            CONFIRM_TEXT,
            &[CANCEL, UNINSTALL],
            Some(0),
        ) == 1
    })
    .await
    .unwrap_or(false);

    if !confirmed {
        stop_here(&app, None).await;
        return;
    }

    let cli = cli_beside(&executable);

    if removes_link(&link_state(Path::new(LINK), &cli)) {
        let text = match elevate::perform(executable.clone(), Step::Remove, &running).await {
            Outcome::Done => None,
            Outcome::Cancelled => return stop_here(&app, None).await,
            Outcome::Occupied => Some(format!("{LINK} is not a link.")),
            Outcome::Failed(line) => Some(format!("macOS reported this error: {line}")),
        };

        if let Some(text) = text {
            return stop_here(&app, Some((NOT_REMOVED, text))).await;
        }
    }

    drop(running);

    // Set before the window goes and before `retire`, which can take seconds:
    // closing the last window would otherwise quit part-way.
    uninstalling.store(true, Ordering::SeqCst);

    if let Some(window) = app.get_webview_window(crate::WINDOW) {
        let _ = window.destroy();
    }

    daemon.retire().await;

    let home = std::env::home_dir();
    let identifier = app.config().identifier.clone();
    let files = files(
        home.as_deref(),
        app.path().app_config_dir().ok(),
        account.as_deref(),
        &identifier,
    );
    let protected = protected(home.as_deref(), account.as_deref());
    let bundle = bundle_of(&executable).map(Path::to_path_buf);

    let failures = tauri::async_runtime::spawn_blocking({
        let early = files.early.clone();
        let protected = protected.clone();

        move || tear_down(&cli, &early, &protected, bundle.as_deref())
    })
    .await
    .unwrap_or_else(|_| Failures::all(files.early.clone()));

    let handle = app.clone();

    alert::on_main(&app, move |marker| {
        alert::show(
            marker,
            DONE_TITLE,
            &final_text(&failures),
            &[alert::OK],
            None,
        );

        // Nothing can report a failure from here on.
        forget_defaults(&identifier);
        let _ = delete(&files.late, &protected);
        handle.exit(0);
    })
    .await;
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{PermissionsExt as _, symlink};

    use super::*;
    use crate::testing::{directory, script_file};

    #[test]
    fn uninstall_removes_only_a_link_of_its_own_or_to_nothing() {
        assert!(removes_link(&LinkState::Installed));
        assert!(removes_link(&LinkState::Stale { dangling: true }));
        assert!(!removes_link(&LinkState::Stale { dangling: false }));
        assert!(!removes_link(&LinkState::Missing));
        assert!(!removes_link(&LinkState::Foreign));
        assert!(!removes_link(&LinkState::Unreadable("denied".into())));
    }

    #[test]
    fn each_file_is_resolved_from_the_home_its_writer_uses() {
        let listed = files(
            Some(Path::new("/tmp/dev-home")),
            Some(PathBuf::from(
                "/tmp/dev-home/Library/Application Support/org.example.app",
            )),
            Some(Path::new("/Users/someone")),
            "org.example.app",
        );

        assert_eq!(
            listed,
            Files {
                early: [
                    "/tmp/dev-home/Library/Logs/Tasma",
                    "/tmp/dev-home/Library/Application Support/org.example.app",
                    "/Users/someone/Library/Caches/org.example.app",
                    "/Users/someone/Library/WebKit/org.example.app",
                    "/Users/someone/Library/HTTPStorages/org.example.app",
                ]
                .map(PathBuf::from)
                .to_vec(),
                late: [
                    "/Users/someone/Library/Saved Application State/org.example.app.savedState",
                    "/Users/someone/Library/Preferences/org.example.app.plist",
                ]
                .map(PathBuf::from)
                .to_vec(),
            },
        );
    }

    #[test]
    fn a_home_that_is_not_known_lists_nothing_under_it() {
        assert_eq!(
            files(None, None, None, "org.example.app"),
            Files {
                early: Vec::new(),
                late: Vec::new()
            },
        );
    }

    #[test]
    fn both_trees_are_protected() {
        assert_eq!(
            protected(
                Some(Path::new("/tmp/dev-home")),
                Some(Path::new("/Users/someone"))
            ),
            [
                PathBuf::from("/Users/someone/.tasma"),
                PathBuf::from("/tmp/dev-home/.tasma"),
            ],
        );
    }

    /// A home with a tree and the application's folders, all with a file in.
    fn home(test: &str) -> PathBuf {
        let home = directory(test);

        for folder in [
            ".tasma",
            "Library/Logs/Sample",
            "Library/Caches/org.example.app",
        ] {
            std::fs::create_dir_all(home.join(folder)).unwrap();
            std::fs::write(home.join(folder).join("kept"), "").unwrap();
        }

        home
    }

    #[test]
    fn present_items_are_deleted_and_absent_ones_skipped() {
        let home = home("delete-present");
        let plist = home.join("Library/org.example.app.plist");
        std::fs::write(&plist, "").unwrap();
        let items = [
            home.join("Library/Logs/Sample"),
            home.join("Library/Caches/org.example.app"),
            plist.clone(),
            home.join("Library/WebKit/org.example.app"),
        ];

        let failed = delete(&items, &[home.join(".tasma")]);

        assert!(failed.is_empty(), "{failed:?}");
        assert!(items.iter().all(|item| !item.exists()));
        assert!(home.join(".tasma/kept").exists());
    }

    #[test]
    fn a_link_at_an_item_is_removed_and_not_followed() {
        let home = home("delete-link");
        let item = home.join("Library/Caches/linked");
        symlink(home.join("Library/Logs/Sample"), &item).unwrap();

        assert!(delete(std::slice::from_ref(&item), &[]).is_empty());

        assert!(std::fs::symlink_metadata(&item).is_err());
        assert!(home.join("Library/Logs/Sample/kept").exists());
    }

    #[test]
    fn an_item_inside_the_tree_through_a_linked_parent_is_refused() {
        let home = home("delete-inside");
        let parent = home.join("Library/Linked");
        symlink(home.join(".tasma"), &parent).unwrap();
        let item = parent.join("kept");

        assert_eq!(
            delete(std::slice::from_ref(&item), &[home.join(".tasma")]),
            [item]
        );
        assert!(home.join(".tasma/kept").exists());
    }

    #[test]
    fn an_item_that_holds_the_tree_is_refused() {
        let home = home("delete-holds");
        let item = home.join("Library/Caches/org.example.app");
        std::fs::create_dir(item.join("data")).unwrap();
        // The tree is a link into the item, so a recursive delete would reach it.
        let linked_home = directory("delete-holds-home");
        symlink(item.join("data"), linked_home.join(".tasma")).unwrap();

        assert_eq!(
            delete(std::slice::from_ref(&item), &[linked_home.join(".tasma")]),
            std::slice::from_ref(&item)
        );
        assert!(item.join("kept").exists());
    }

    #[test]
    fn a_tree_that_does_not_exist_protects_nothing() {
        let home = home("delete-no-tree");
        let item = home.join("Library/Logs/Sample");

        assert!(delete(std::slice::from_ref(&item), &[home.join("absent/.tasma")]).is_empty());
        assert!(!item.exists());
    }

    #[test]
    fn a_failure_is_reported_with_its_path() {
        let home = home("delete-failure");
        let locked = home.join("Library/Logs");
        let item = locked.join("Sample");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();

        let failed = delete(std::slice::from_ref(&item), &[]);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(failed, [item]);
    }

    #[test]
    fn an_item_that_cannot_be_read_or_resolved_is_a_failure() {
        let home = home("delete-unresolved");
        // `ENOTDIR` from the read, not `ENOENT`.
        let under_a_file = home.join(".tasma/kept/item");

        assert_eq!(
            delete(std::slice::from_ref(&under_a_file), &[]),
            [under_a_file]
        );
        assert_eq!(
            reaches_protected(Path::new("/"), &[]).ok(),
            Some(true),
            "a path with no parent is never deleted"
        );
    }

    fn stub(test: &str, body: &str) -> PathBuf {
        script_file(&directory(test).join("tool"), body)
    }

    const TICK: Duration = Duration::from_millis(10);

    #[test]
    fn the_daemon_stop_reports_its_exit() {
        let stops = stub("stop-ok", r#"[ "$1 $2" = "daemon stop" ] || exit 9"#);
        let fails = stub("stop-fails", "exit 3");

        assert!(stop_daemon(&stops, STOP_LIMIT, TICK));
        assert!(!stop_daemon(&fails, STOP_LIMIT, TICK));
        assert!(!stop_daemon(
            Path::new("/nonexistent/cli"),
            STOP_LIMIT,
            TICK
        ));
    }

    #[test]
    fn a_daemon_stop_past_the_limit_is_killed_and_fails() {
        let slow = stub("stop-slow", "sleep 30");
        let started = Instant::now();

        assert!(!stop_daemon(&slow, Duration::from_millis(200), TICK));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn unregister_passes_the_bundle_as_one_argument() {
        let tool = stub(
            "unregister",
            r#"[ "$1" = -u ] && [ "$2" = "/Applications/A B.app" ]"#,
        );

        assert!(unregister(&tool, Path::new("/Applications/A B.app")));
        assert!(!unregister(&tool, Path::new("/Applications/Other.app")));
        assert!(!unregister(
            Path::new("/nonexistent/lsregister"),
            Path::new("/x.app")
        ));
    }

    #[test]
    fn a_bundle_that_is_not_there_is_not_trashed() {
        let absent = directory("trash-absent").join("Sample.app");

        assert!(!trash(&absent));
    }

    #[test]
    fn forgetting_an_unknown_domain_changes_nothing() {
        forget_defaults("org.example.unused-domain");
    }

    #[test]
    fn tear_down_runs_each_step_and_reports_what_failed() {
        let home = home("tear-down");
        let cli = stub("tear-down-cli", "exit 0");
        let item = home.join("Library/Caches/org.example.app");

        let failures = tear_down(&cli, std::slice::from_ref(&item), &[], None);

        assert!(!failures.daemon);
        assert!(failures.files.is_empty());
        assert!(!item.exists());
        assert!(failures.unregister, "no bundle is never unregistered");
        assert!(failures.trash, "no bundle is never trashed");
    }

    #[test]
    fn the_final_alert_names_each_failure() {
        assert_eq!(final_text(&Failures::default()), KEPT);

        let text = final_text(&Failures::all(vec![
            PathBuf::from("/a/one"),
            PathBuf::from("/a/two"),
        ]));

        assert_eq!(
            text.lines().collect::<Vec<_>>(),
            [
                KEPT,
                "The daemon could not be stopped. It stops when you restart the Mac.",
                "Some files could not be deleted: /a/one, /a/two.",
                "Links that start with tasma:// may still open the copy of Tasma in the Trash.",
                "Tasma could not move itself to the Trash. In the Applications folder, select Tasma and choose File › Move to Trash.",
            ],
        );
    }
}
