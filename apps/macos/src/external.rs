//! Links that a document opens outside the window: a web link in the browser
//! that the link settings choose, a mail link in the default mail app and an
//! editor link in its editor. Also `POST /app/open`, which opens a web link in a
//! named browser.

use std::cell::Cell;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::mpsc::{self, Sender};

use block2::RcBlock;
use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_foundation::{NSArray, NSError, NSString, NSURL};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde_json::Value;
use tauri::http::{Method, Response, StatusCode};
use tauri::{AppHandle, Runtime, Url};

use crate::accounts::{ADMINISTRATORS, ROOT};
use crate::browsers::{self, Browser};
use crate::links;
use crate::log;
use crate::update::plain;

/// The route under `/app`. Held to `OPEN_URL_ROUTE` in `apps/web` by a repo
/// test.
pub(crate) const PATH: &str = "/open";

/// `LINK_SCHEMES` in `apps/web/src/lib/link-kind.ts`, without the colon.
const SCHEMES: [&str; 3] = ["http", "https", "mailto"];

const WEB_SCHEMES: [&str; 2] = ["http", "https"];

const NOT_OPENED: &str = "a link could not be opened";
const NO_APP: &str = "macOS could not find the app or read the link";

/// `EDITOR_SCHEMES` in `apps/web/src/lib/link-kind.ts`, without the colon.
const EDITOR_SCHEMES: [&str; 5] = ["vscode", "vscode-insiders", "cursor", "vscodium", "zed"];

const NO_FILE: &str = "an editor link names no file";
const UNGUARDED: &str = "an editor link names a file that another account can replace";

/// The bytes an editor link encodes in its path.
const EDITOR_PATH: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b'-')
    .remove(b'_')
    .remove(b'.');

/// Whether a link goes to the system rather than to the window.
pub fn opens_outside(url: &Url) -> bool {
    SCHEMES.contains(&url.scheme()) || is_editor_link(url)
}

/// An editor link in the file form. The other forms of these schemes clone a
/// repository, install an extension or run extension code. The editors compare
/// the host case-sensitively.
fn is_editor_link(url: &Url) -> bool {
    EDITOR_SCHEMES.contains(&url.scheme())
        && url.host_str() == Some("file")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

/// The editor link `open` hands to Launch Services, or why it holds the link
/// back.
///
/// The link is rebuilt on the real path of the regular file it names. A folder
/// or a `.code-workspace` file can run tasks with no prompt. The real path
/// holds no symbolic link, no other account can replace an entry on it, and
/// the position stays only where the editor cannot read it as part of a name,
/// so the file checked here is the file the editor opens.
fn editor_target(url: &Url) -> Result<Url, &'static str> {
    let path = percent_decode_str(url.path())
        .decode_utf8()
        .map_err(|_| NO_FILE)?;
    let (file, position) = split_position(&path);
    if !is_editor_link(url) || !is_editor_path(file) {
        return Err(NO_FILE);
    }

    let real = std::fs::canonicalize(file).map_err(|_| NO_FILE)?;
    let real = real
        .to_str()
        .filter(|real| is_editor_path(real) && is_regular_file(real))
        .ok_or(NO_FILE)?;
    // Safety: `getuid` reads the calling process and changes nothing.
    let me = unsafe { libc::getuid() };
    if !is_guarded(Path::new(real), me) {
        return Err(UNGUARDED);
    }

    let encoded = utf8_percent_encode(real, EDITOR_PATH);
    let position = kept_position(real, position, me);
    Url::parse(&format!("{}://file{encoded}{position}", url.scheme())).map_err(|_| NO_FILE)
}

/// The position the rebuilt link keeps. Zed opens the entry `<real><position>`
/// whenever one exists, so the position stays only where no such entry exists
/// and no other account can create one.
fn kept_position<'a>(real: &str, position: &'a str, me: u32) -> &'a str {
    let free = std::fs::symlink_metadata(format!("{real}{position}")).is_err()
        && Path::new(real).parent().is_some_and(|folder| {
            std::fs::symlink_metadata(folder)
                .is_ok_and(|folder| closed(folder.uid(), folder.gid(), folder.mode(), me))
        });

    if free { position } else { "" }
}

/// The path split before one `:<line>:<column>` or `:<line>` suffix.
fn split_position(path: &str) -> (&str, &str) {
    let file = before_number(path).map_or(path, |rest| before_number(rest).unwrap_or(rest));

    path.split_at(file.len())
}

/// The text before a last `:<digits>`, or `None` when it does not end in one.
fn before_number(text: &str) -> Option<&str> {
    let (rest, number) = text.rsplit_once(':')?;

    (!number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())).then_some(rest)
}

/// `isEditorPath` in `link-kind.ts`, for a decoded path with no position. The
/// editors read more position forms than `split_position`, so the rule refuses
/// each path that one of them can read as another path.
fn is_editor_path(file: &str) -> bool {
    file.strip_prefix('/').is_some_and(|rest| {
        rest.split('/')
            .all(|segment| !matches!(segment, "" | "." | ".."))
    }) && !file.contains(':')
        && !file.ends_with(char::is_whitespace)
        && !file.ends_with(')')
        && !file.to_lowercase().ends_with(".code-workspace")
}

fn is_regular_file(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|stats| stats.is_file())
}

/// Whether only `me`, root and the administrators can replace the entry of
/// `real` or of a folder above it.
fn is_guarded(real: &Path, me: u32) -> bool {
    real.ancestors()
        .zip(real.ancestors().skip(1))
        .all(|(entry, folder)| {
            match (
                std::fs::symlink_metadata(folder),
                std::fs::symlink_metadata(entry),
            ) {
                (Ok(folder), Ok(entry)) => {
                    entry_guarded(folder.uid(), folder.gid(), folder.mode(), entry.uid(), me)
                }
                _ => false,
            }
        })
}

/// Whether only `me`, root and the administrators can replace an entry owned by
/// `entry_uid` in a folder. The sticky bit leaves the entries of a writable
/// folder to their owners.
fn entry_guarded(
    folder_uid: u32,
    folder_gid: u32,
    folder_mode: u32,
    entry_uid: u32,
    me: u32,
) -> bool {
    let trusted = |uid| uid == me || uid == ROOT;
    let sticky = folder_mode & 0o1000 != 0;

    closed(folder_uid, folder_gid, folder_mode, me)
        || (trusted(folder_uid) && sticky && trusted(entry_uid))
}

/// Whether only `me`, root and the administrators can add an entry to a folder.
/// The owner of a folder can change its mode, and the sticky bit does not stop
/// a new name.
fn closed(folder_uid: u32, folder_gid: u32, folder_mode: u32, me: u32) -> bool {
    (folder_uid == me || folder_uid == ROOT)
        && folder_mode & 0o002 == 0
        && (folder_mode & 0o020 == 0 || ADMINISTRATORS.contains(&folder_gid))
}

/// Why a link did not open, or `None` once `launch` opened it. An editor link
/// goes as `editor_target` rebuilds it.
fn failure(url: &Url, launch: impl FnOnce(&Url) -> bool) -> Option<&'static str> {
    let opened = if EDITOR_SCHEMES.contains(&url.scheme()) {
        match editor_target(url) {
            Ok(target) => launch(&target),
            Err(reason) => return Some(reason),
        }
    } else {
        launch(url)
    };

    (!opened).then_some(NOT_OPENED)
}

fn is_web(url: &Url) -> bool {
    WEB_SCHEMES.contains(&url.scheme())
}

/// The browser of the link settings that a link opens in, or `None` for the
/// default app of its scheme.
fn browser_for<R: Runtime>(app: &AppHandle<R>, url: &Url) -> Option<Browser> {
    if !is_web(url) {
        return None;
    }

    let settings = links::settings(app);
    // Spares a click the Launch Services query on the main thread.
    if settings.browser.is_empty() && settings.dev_browser.is_empty() {
        return None;
    }

    browsers::choose(url, &settings, &browsers::installed()).cloned()
}

/// The log line of a link that `open_with` did not open in the app `id`.
fn not_opened_in(id: &str, url: &Url, cause: &str) -> String {
    format!(
        "{NOT_OPENED} in {}: {}: {}",
        log::quoted(id),
        log::quoted(url.as_str()),
        log::quoted(cause)
    )
}

fn note(line: &str) {
    let file = log::open(std::env::home_dir().as_deref()).ok();
    log::note(file.as_ref(), line);
}

/// The result of an open, from the error that its completion handler gets.
fn opened(error: Option<&NSError>) -> Result<(), String> {
    match error {
        None => Ok(()),
        Some(error) => Err(error.localizedDescription().to_string()),
    }
}

/// Opens `url` in the app with the bundle id `id`, with no fall back to the
/// default browser. `done` gets the result once: on the calling thread, before
/// `open_with` returns, when macOS finds no app or cannot read the link;
/// otherwise on a queue that macOS chooses.
fn open_with(url: &Url, id: &str, done: impl FnOnce(Result<(), String>) + Send + 'static) {
    // A worker thread of the async runtime has no autorelease pool.
    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let target = NSURL::URLWithString(&NSString::from_str(url.as_str()));
        let app = workspace.URLForApplicationWithBundleIdentifier(&NSString::from_str(id));
        let (Some(target), Some(app)) = (target, app) else {
            done(Err(NO_APP.to_string()));
            return;
        };

        // Nothing here may panic: an unwind out of a block aborts the process.
        let done = Cell::new(Some(done));
        let handler = RcBlock::new(move |_: *mut NSRunningApplication, error: *mut NSError| {
            if let Some(done) = done.take() {
                // Safety: the error macOS hands over is null or a live `NSError`.
                done(opened(unsafe { error.as_ref() }));
            }
        });

        workspace.openURLs_withApplicationAtURL_configuration_completionHandler(
            &NSArray::from_retained_slice(&[target]),
            &app,
            &NSWorkspaceOpenConfiguration::configuration(),
            Some(&handler),
        );
    });
}

/// Hands a link to Launch Services: a web link to the browser that the link
/// settings choose, any other link to the default app of its scheme. A link
/// that is held back or does not open is one line in the log, the only place a
/// bundle's own output can be read.
pub fn open<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if let Some(browser) = browser_for(app, url) {
        let (id, link) = (browser.id.clone(), url.clone());
        open_with(url, &browser.id, move |result| {
            if let Err(cause) = result {
                note(&not_opened_in(&id, &link, &cause));
            }
        });
        return;
    }

    let failed = failure(url, |target| {
        NSURL::URLWithString(&NSString::from_str(target.as_str()))
            .is_some_and(|link| NSWorkspace::sharedWorkspace().openURL(&link))
    });

    if let Some(reason) = failed {
        note(&format!("{reason}: {}", log::quoted(url.as_str())));
    }
}

/// The web link and the bundle id of a request body, or `None` for a body that
/// is not a JSON object with a string `url` of a web link and a string
/// `browser`.
fn read(body: &[u8]) -> Option<(Url, String)> {
    let Ok(Value::Object(fields)) = serde_json::from_slice(body) else {
        return None;
    };
    let (Some(Value::String(url)), Some(Value::String(browser))) =
        (fields.get("url"), fields.get("browser"))
    else {
        return None;
    };

    let url = Url::parse(url).ok().filter(is_web)?;
    Some((url, browser.clone()))
}

pub(crate) fn handles(path: &str) -> bool {
    path.strip_prefix(PATH)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// The status of a request to open a link, or the log line of an open that
/// failed.
async fn respond(
    method: &Method,
    path: &str,
    body: &[u8],
    installed: impl FnOnce() -> Vec<Browser>,
    open: impl FnOnce(&Url, &str, Sender<Result<(), String>>),
) -> Result<StatusCode, String> {
    if path != PATH {
        return Ok(StatusCode::NOT_FOUND);
    }

    if *method != Method::POST {
        return Ok(StatusCode::METHOD_NOT_ALLOWED);
    }

    let Some((url, id)) = read(body) else {
        return Ok(StatusCode::BAD_REQUEST);
    };

    if !installed().iter().any(|browser| browser.id == id) {
        return Ok(StatusCode::NOT_FOUND);
    }

    let (sender, receiver) = mpsc::channel();
    open(&url, &id, sender);

    // Off the async runtime's workers, so a browser that starts slowly holds
    // none.
    tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_else(|| Err("the open gave no answer".to_string()))
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(|cause| not_opened_in(&id, &url, &cause))
}

/// `POST /app/open`: opens a web link in a browser of the list. The answer
/// comes once the browser has the link.
pub(crate) async fn serve(method: &Method, path: &str, body: &[u8]) -> Response<Vec<u8>> {
    let answer = respond(
        method,
        path,
        body,
        browsers::installed,
        |url, id, sender| {
            open_with(url, id, move |result| {
                let _ = sender.send(result);
            });
        },
    )
    .await;

    match answer {
        Ok(status) => plain(status),
        Err(line) => {
            note(&line);
            plain(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    use serde_json::json;
    use tauri::Manager as _;

    use super::*;
    use crate::testing::directory;

    /// Read at compile time, so a list changed there and not here fails the
    /// test.
    const LINK_KIND: &str = include_str!("../../web/src/lib/link-kind.ts");

    const ME: u32 = 501;
    const OTHER: u32 = 502;
    const STAFF: u32 = 20;
    const ADMIN: u32 = 80;

    fn url(text: &str) -> Url {
        text.parse().unwrap()
    }

    /// The schemes the `Set` named `name` holds, without the colon.
    fn pinned(name: &str) -> BTreeSet<&'static str> {
        let start = format!("const {name} = new Set([");
        let list = LINK_KIND
            .lines()
            .map(str::trim)
            .find_map(|line| {
                line.strip_prefix("export ")
                    .unwrap_or(line)
                    .strip_prefix(start.as_str())
            })
            .and_then(|rest| rest.split_once("])"))
            .unwrap_or_else(|| panic!("link-kind.ts states {name} as a Set of strings"))
            .0;

        list.split(',')
            .map(|name| {
                name.trim()
                    .strip_prefix('"')
                    .and_then(|name| name.strip_suffix(":\""))
                    .expect("a link scheme is a quoted name with a colon")
            })
            .collect()
    }

    /// An editor link to `rest`, URL text, under `directory`.
    fn editor_link(directory: &Path, rest: &str) -> Url {
        scheme_link("vscode", directory, rest)
    }

    fn scheme_link(scheme: &str, directory: &Path, rest: &str) -> Url {
        let directory = utf8_percent_encode(directory.to_str().unwrap(), EDITOR_PATH);

        url(&format!("{scheme}://file{directory}/{rest}"))
    }

    /// The editor link `open` hands on for `rest` under `directory`: the same
    /// text under the real path of `directory`.
    fn rebuilt(directory: &Path, rest: &str) -> Url {
        editor_link(&real(directory), rest)
    }

    fn real(directory: &Path) -> PathBuf {
        std::fs::canonicalize(directory).unwrap()
    }

    /// A folder under `directory` with `mode`, holding a regular file `a.ts`.
    fn folder_with_mode(directory: &Path, name: &str, mode: u32) -> PathBuf {
        let folder = directory.join(name);
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("a.ts"), "").unwrap();
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(mode)).unwrap();

        folder
    }

    /// The URL `failure` hands to its launcher, and its answer.
    fn launched(link: &Url, opens: bool) -> (Option<&'static str>, Option<Url>) {
        let handed = Cell::new(None);
        let failed = failure(link, |target| {
            handed.set(Some(target.clone()));
            opens
        });

        (failed, handed.take())
    }

    #[test]
    fn the_schemes_are_the_ones_the_board_renders_as_links() {
        assert_eq!(pinned("LINK_SCHEMES"), SCHEMES.into_iter().collect());
        assert_eq!(
            pinned("EDITOR_SCHEMES"),
            EDITOR_SCHEMES.into_iter().collect()
        );
    }

    #[test]
    fn web_and_mail_links_open_outside() {
        assert!(opens_outside(&url("https://example.invalid/")));
        assert!(opens_outside(&url("http://example.invalid/")));
        assert!(opens_outside(&url("mailto:someone@example.invalid")));
    }

    #[test]
    fn an_editor_link_in_the_file_form_opens_outside() {
        for scheme in EDITOR_SCHEMES {
            assert!(
                opens_outside(&url(&format!("{scheme}://file/Users/x/proj/a.ts:3"))),
                "{scheme}"
            );
        }
    }

    #[test]
    fn an_editor_link_in_another_form_does_not_open_outside() {
        for link in [
            "vscode://FILE/x/a.ts",
            "vscode://vscode.git/clone?url=https://example.invalid/r.git",
            "vscode://publisher.extension/x/a.ts",
            "cursor://anysphere.cursor-deeplink/mcp/install?name=x",
            "vscode://file/x/a.ts?line=3",
            "vscode://file/x/a.ts?",
            "vscode://file/x/a.ts#L3",
            "vscode://file/x/a.ts#",
            "vscode://file:1/x/a.ts",
            "vscode://someone@file/x/a.ts",
            "vscode://:secret@file/x/a.ts",
            "windsurf://file/x/a.ts",
        ] {
            assert!(!opens_outside(&url(link)), "{link}");
        }
    }

    #[test]
    fn no_other_link_opens_outside() {
        assert!(!opens_outside(&url("file:///etc/passwd")));
        assert!(!opens_outside(&url("javascript:alert(1)")));
        assert!(!opens_outside(&url("data:text/html,x")));
        assert!(!opens_outside(&url(&format!(
            "{}://task/SAGA-1",
            crate::LINK_SCHEME
        ))));
        assert!(!opens_outside(&url("tasma-app://localhost/index.html")));
    }

    #[test]
    fn an_editor_link_to_a_regular_file_is_rebuilt_on_its_real_path() {
        let directory = directory("external-regular-file");
        for name in ["a.ts", "my notes.md", "proj"] {
            std::fs::write(directory.join(name), "").unwrap();
        }

        for (rest, target) in [
            ("a.ts", "a.ts"),
            ("a.ts:3", "a.ts:3"),
            ("a.ts:3:5", "a.ts:3:5"),
            ("my%20notes.md", "my%20notes.md"),
            ("my notes.md:3", "my%20notes.md:3"),
            ("proj%3A3", "proj:3"),
        ] {
            assert_eq!(
                editor_target(&editor_link(&directory, rest)),
                Ok(rebuilt(&directory, target)),
                "{rest}"
            );
        }
    }

    #[test]
    fn an_editor_link_keeps_its_scheme() {
        let directory = directory("external-scheme");
        std::fs::write(directory.join("a.ts"), "").unwrap();

        for scheme in EDITOR_SCHEMES {
            assert_eq!(
                editor_target(&scheme_link(scheme, &directory, "a.ts:3")),
                Ok(scheme_link(scheme, &real(&directory), "a.ts:3")),
                "{scheme}"
            );
        }
    }

    #[test]
    fn an_editor_link_through_a_symbolic_link_names_the_file_it_reaches() {
        let directory = directory("external-through-link");
        std::fs::create_dir(directory.join("proj")).unwrap();
        std::fs::write(directory.join("proj/a.ts"), "").unwrap();
        std::os::unix::fs::symlink(directory.join("proj"), directory.join("linked")).unwrap();
        std::os::unix::fs::symlink(directory.join("proj/a.ts"), directory.join("s.ts")).unwrap();

        assert_eq!(
            editor_target(&editor_link(&directory, "linked/a.ts:3")),
            Ok(rebuilt(&directory, "proj/a.ts:3"))
        );
        assert_eq!(
            editor_target(&editor_link(&directory, "s.ts")),
            Ok(rebuilt(&directory, "proj/a.ts"))
        );
    }

    #[test]
    fn an_editor_link_to_no_regular_file_names_no_file() {
        let directory = directory("external-no-regular-file");
        std::fs::create_dir(directory.join("proj")).unwrap();
        std::os::unix::fs::symlink(directory.join("proj"), directory.join("link")).unwrap();
        std::fs::write(directory.join("w.code-workspace"), "").unwrap();
        std::fs::write(directory.join("proj:"), "").unwrap();
        std::os::unix::fs::symlink(directory.join("w.code-workspace"), directory.join("w.ts"))
            .unwrap();
        std::os::unix::fs::symlink(directory.join("proj:"), directory.join("colon.ts")).unwrap();

        for rest in [
            "proj",
            "proj:3",
            "link",
            "missing.ts",
            "w.code-workspace",
            "w.code-workspace:3",
            "w.ts",
            "colon.ts",
        ] {
            assert_eq!(
                editor_target(&editor_link(&directory, rest)),
                Err(NO_FILE),
                "{rest}"
            );
        }
        assert_eq!(editor_target(&url("vscode://file")), Err(NO_FILE));
        assert_eq!(editor_target(&url("vscode://file/")), Err(NO_FILE));
    }

    #[test]
    fn a_link_drops_its_position_when_an_entry_has_its_whole_path() {
        let directory = directory("external-whole-path");
        for name in ["proj", "b.ts", "b.ts:3", "c.ts", "d.ts"] {
            std::fs::write(directory.join(name), "").unwrap();
        }
        std::fs::create_dir(directory.join("proj:3")).unwrap();
        std::fs::create_dir(directory.join("proj:3:5")).unwrap();
        std::os::unix::fs::symlink(directory.join("c.ts"), directory.join("c.ts:3")).unwrap();
        std::os::unix::fs::symlink(directory.join("missing"), directory.join("d.ts:3")).unwrap();

        for scheme in ["zed", "vscode"] {
            for (rest, target) in [
                ("proj:3", "proj"),
                ("proj%3A3", "proj"),
                ("proj:3:5", "proj"),
                ("b.ts:3", "b.ts"),
                ("c.ts:3", "c.ts"),
                ("d.ts:3", "d.ts"),
            ] {
                assert_eq!(
                    editor_target(&scheme_link(scheme, &directory, rest)),
                    Ok(scheme_link(scheme, &real(&directory), target)),
                    "{scheme} {rest}"
                );
            }
        }
    }

    #[test]
    fn a_link_drops_its_position_in_a_folder_that_another_account_can_add_to() {
        let directory = directory("external-open-folder");
        let sticky = folder_with_mode(&directory, "sticky", 0o1777);

        for scheme in ["zed", "vscode"] {
            assert_eq!(
                editor_target(&scheme_link(scheme, &sticky, "a.ts:3")),
                Ok(scheme_link(scheme, &real(&sticky), "a.ts")),
                "{scheme}"
            );
        }
    }

    #[test]
    fn an_editor_link_in_a_folder_that_another_account_can_change_is_held_back() {
        let directory = directory("external-shared-folder");
        let shared = folder_with_mode(&directory, "shared", 0o777);
        let sticky = folder_with_mode(&directory, "sticky", 0o1777);
        let below = shared.join("below");
        std::fs::create_dir(&below).unwrap();
        std::fs::write(below.join("a.ts"), "").unwrap();

        assert_eq!(editor_target(&editor_link(&shared, "a.ts")), Err(UNGUARDED));
        assert_eq!(editor_target(&editor_link(&below, "a.ts")), Err(UNGUARDED));
        assert_eq!(
            editor_target(&editor_link(&sticky, "a.ts")),
            Ok(rebuilt(&sticky, "a.ts"))
        );
    }

    #[test]
    fn only_this_account_root_and_the_administrators_can_replace_a_guarded_entry() {
        for (folder_uid, folder_gid, mode, entry_uid) in [
            (ME, STAFF, 0o755, ME),
            (ROOT, STAFF, 0o755, OTHER),
            (ME, STAFF, 0o700, OTHER),
            (ROOT, ADMIN, 0o775, OTHER),
            (ROOT, ROOT, 0o775, OTHER),
            (ROOT, ROOT, 0o1777, ME),
            (ROOT, ROOT, 0o1777, ROOT),
            (ME, STAFF, 0o1775, ME),
        ] {
            assert!(
                entry_guarded(folder_uid, folder_gid, mode, entry_uid, ME),
                "{folder_uid} {folder_gid} {mode:o} {entry_uid}"
            );
        }

        for (folder_uid, folder_gid, mode, entry_uid) in [
            (OTHER, STAFF, 0o755, ME),
            (OTHER, ADMIN, 0o700, ME),
            (ME, STAFF, 0o757, ME),
            (ME, STAFF, 0o775, ME),
            (ROOT, ROOT, 0o777, ME),
            (ROOT, ROOT, 0o1777, OTHER),
            (ME, STAFF, 0o1775, OTHER),
        ] {
            assert!(
                !entry_guarded(folder_uid, folder_gid, mode, entry_uid, ME),
                "{folder_uid} {folder_gid} {mode:o} {entry_uid}"
            );
        }
    }

    #[test]
    fn only_this_account_root_and_the_administrators_can_add_to_a_closed_folder() {
        for (folder_uid, folder_gid, mode) in [
            (ME, STAFF, 0o755),
            (ME, STAFF, 0o700),
            (ROOT, ADMIN, 0o775),
            (ROOT, ROOT, 0o775),
            (ROOT, STAFF, 0o1755),
        ] {
            assert!(
                closed(folder_uid, folder_gid, mode, ME),
                "{folder_uid} {folder_gid} {mode:o}"
            );
        }

        for (folder_uid, folder_gid, mode) in [
            (OTHER, STAFF, 0o755),
            (ME, STAFF, 0o757),
            (ME, STAFF, 0o775),
            (ROOT, ROOT, 0o777),
            (ROOT, ROOT, 0o1777),
            (ME, STAFF, 0o1775),
        ] {
            assert!(
                !closed(folder_uid, folder_gid, mode, ME),
                "{folder_uid} {folder_gid} {mode:o}"
            );
        }
    }

    #[test]
    fn a_path_that_an_editor_can_read_in_another_way_names_no_file() {
        let directory = directory("external-other-reading");
        std::fs::create_dir(directory.join("proj")).unwrap();
        std::fs::create_dir(directory.join("a")).unwrap();
        for name in [
            "proj:",
            "proj:0x1",
            "proj:3",
            "proj(3)",
            "proj(3,5)",
            "b",
            "c.ts",
            "c.ts:",
            "a.ts ",
            "a.ts\u{a0}",
            "a.ts\u{85}",
            "a.ts\u{fffd}",
            "w.CODE-Workspace",
            "w.code-wor\u{212a}space",
        ] {
            std::fs::write(directory.join(name), "").unwrap();
        }

        for rest in [
            "proj:",
            "proj%3A",
            "proj:0x1",
            "proj::3",
            "proj:3:5:7",
            "c.ts:",
            "c.ts::3",
            "proj(3)",
            "proj(3,5)",
            "/b",
            "b/",
            "a%2F..%2Fb",
            "a%2F.%2Fb",
            "a.ts%20",
            "a.ts%20:3",
            "a.ts%C2%A0",
            "a.ts%C2%85",
            "a.ts%FF",
            "w.CODE-Workspace",
            "w.code-wor%E2%84%AAspace",
        ] {
            assert_eq!(
                editor_target(&editor_link(&directory, rest)),
                Err(NO_FILE),
                "{rest}"
            );
        }
    }

    #[test]
    fn a_web_or_mail_link_goes_to_launch_services_as_it_is() {
        for link in ["https://example.invalid/", "mailto:someone@example.invalid"] {
            assert_eq!(
                launched(&url(link), true),
                (None, Some(url(link))),
                "{link}"
            );
        }
    }

    #[test]
    fn an_editor_link_goes_to_launch_services_rebuilt() {
        let directory = directory("external-launched");
        std::fs::write(directory.join("a.ts"), "").unwrap();

        assert_eq!(
            launched(&editor_link(&directory, "a.ts:3"), true),
            (None, Some(rebuilt(&directory, "a.ts:3")))
        );
    }

    #[test]
    fn a_link_that_launch_services_does_not_open_is_refused() {
        let link = url("https://example.invalid/");

        assert_eq!(
            launched(&link, false),
            (Some("a link could not be opened"), Some(link))
        );
    }

    const BROWSER: &str = "com.example.browser";
    const NOT_INSTALLED: &str = "com.example.not-installed";

    fn example_browsers() -> Vec<Browser> {
        vec![Browser {
            id: BROWSER.to_string(),
            name: "Example Browser".to_string(),
            default: false,
        }]
    }

    fn request(link: &str, browser: &str) -> Vec<u8> {
        json!({ "url": link, "browser": browser })
            .to_string()
            .into_bytes()
    }

    fn served(method: Method, path: &str, body: &[u8]) -> StatusCode {
        tauri::async_runtime::block_on(serve(&method, path, body)).status()
    }

    /// The answer of a request to open `link` in the listed browser, from an
    /// open that sends `result`, or that sends nothing for `None`, and the link
    /// and the bundle id that the open got.
    fn opened_by(
        link: &str,
        result: Option<Result<(), String>>,
    ) -> (Result<StatusCode, String>, Option<(Url, String)>) {
        let handed = Cell::new(None);
        let answer = tauri::async_runtime::block_on(respond(
            &Method::POST,
            PATH,
            &request(link, BROWSER),
            example_browsers,
            |url, id, sender| {
                handed.set(Some((url.clone(), id.to_string())));
                if let Some(result) = result {
                    sender.send(result).unwrap();
                }
            },
        ));

        (answer, handed.take())
    }

    fn app_with_settings(settings: Value) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(links::Links::default());
        let stored = links::serve(
            app.handle(),
            &Method::POST,
            links::PATH,
            settings.to_string().as_bytes(),
        );
        assert_eq!(stored.status(), StatusCode::NO_CONTENT);

        app
    }

    #[test]
    fn a_web_link_opens_in_the_browser_that_the_settings_choose() {
        let installed = browsers::installed();
        let browser = installed.first().expect("Safari is on every Mac");
        let app = app_with_settings(json!({ "browser": browser.id }));

        assert_eq!(
            browser_for(app.handle(), &url("https://example.invalid/")),
            Some(browser.clone())
        );
    }

    #[test]
    fn a_mail_link_never_opens_in_the_chosen_browser() {
        let installed = browsers::installed();
        let browser = installed.first().expect("Safari is on every Mac");
        let app = app_with_settings(json!({ "browser": browser.id }));

        assert_eq!(
            browser_for(app.handle(), &url("mailto:someone@example.invalid")),
            None
        );
    }

    #[test]
    fn a_development_link_opens_in_the_development_browser_with_no_browser_saved() {
        let installed = browsers::installed();
        let browser = installed.first().expect("Safari is on every Mac");
        let app = app_with_settings(json!({ "devBrowser": browser.id }));

        assert_eq!(
            browser_for(app.handle(), &url("http://localhost:3000/")),
            Some(browser.clone())
        );
        assert_eq!(
            browser_for(app.handle(), &url("https://example.invalid/")),
            None
        );
    }

    #[test]
    fn with_no_settings_a_web_link_opens_in_the_default_browser() {
        let app = app_with_settings(json!({}));

        assert_eq!(
            browser_for(app.handle(), &url("https://example.invalid/")),
            None
        );
    }

    #[test]
    fn a_link_not_opened_in_a_browser_is_one_line_with_the_id_the_link_and_the_cause() {
        assert_eq!(
            not_opened_in(
                "com.example.browser\n",
                &url("https://example.invalid/a b"),
                "the app quit\ntasma-app: forged"
            ),
            "a link could not be opened in com.example.browser\\u000a: \
             https://example.invalid/a%20b: the app quit\\u000atasma-app: forged"
        );
    }

    #[test]
    fn an_open_with_no_error_succeeds_and_one_with_an_error_fails_with_its_description() {
        let error = NSError::new(7, &NSString::from_str("ExampleDomain"));

        assert_eq!(opened(None), Ok(()));
        assert_eq!(
            opened(Some(&error)),
            Err(error.localizedDescription().to_string())
        );
    }

    #[test]
    fn an_open_in_an_app_that_is_not_installed_fails_at_once() {
        let (sender, receiver) = mpsc::channel();

        open_with(
            &url("https://example.invalid/"),
            NOT_INSTALLED,
            move |result| {
                sender.send(result).unwrap();
            },
        );

        assert_eq!(receiver.try_recv(), Ok(Err(NO_APP.to_string())));
    }

    #[test]
    fn a_link_that_the_browser_opens_is_answered_with_nothing() {
        assert_eq!(
            opened_by("https://example.invalid/a?b=c", Some(Ok(()))),
            (
                Ok(StatusCode::NO_CONTENT),
                Some((url("https://example.invalid/a?b=c"), BROWSER.to_string()))
            )
        );
    }

    #[test]
    fn a_link_that_the_browser_does_not_open_is_a_failure_with_its_line() {
        let link = url("http://localhost:3000/");

        assert_eq!(
            opened_by(link.as_str(), Some(Err("the app quit".to_string()))).0,
            Err(not_opened_in(BROWSER, &link, "the app quit"))
        );
    }

    #[test]
    fn an_open_that_gives_no_answer_is_a_failure() {
        let (answer, handed) = opened_by("https://example.invalid/", None);

        assert!(matches!(answer, Err(line) if line.starts_with(NOT_OPENED)));
        assert!(handed.is_some());
    }

    #[test]
    fn a_method_other_than_post_is_not_allowed() {
        for method in [Method::GET, Method::PUT, Method::DELETE] {
            assert_eq!(
                served(
                    method.clone(),
                    PATH,
                    &request("https://example.invalid/", NOT_INSTALLED)
                ),
                StatusCode::METHOD_NOT_ALLOWED,
                "{method}"
            );
        }
    }

    #[test]
    fn another_path_under_the_route_is_not_found() {
        for path in ["/open/", "/open/x"] {
            assert_eq!(
                served(
                    Method::POST,
                    path,
                    &request("https://example.invalid/", NOT_INSTALLED)
                ),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
    }

    #[test]
    fn a_body_that_names_no_web_link_and_browser_is_a_bad_request() {
        let link = "https://example.invalid/";

        for body in [
            "{url".to_string(),
            String::new(),
            "[]".to_string(),
            "null".to_string(),
            json!([link, BROWSER]).to_string(),
            json!({ "browser": BROWSER }).to_string(),
            json!({ "url": link }).to_string(),
            json!({ "url": 7, "browser": BROWSER }).to_string(),
            json!({ "url": link, "browser": null }).to_string(),
        ] {
            assert_eq!(
                served(Method::POST, PATH, body.as_bytes()),
                StatusCode::BAD_REQUEST,
                "{body}"
            );
        }
    }

    #[test]
    fn a_link_that_is_not_a_web_link_is_a_bad_request() {
        for link in [
            "example.invalid",
            "https://",
            "file:///etc/hosts",
            "mailto:someone@example.invalid",
            "javascript:alert(1)",
        ] {
            assert_eq!(
                served(Method::POST, PATH, &request(link, BROWSER)),
                StatusCode::BAD_REQUEST,
                "{link}"
            );
        }
    }

    #[test]
    fn a_browser_that_is_not_in_the_list_is_not_found() {
        for browser in [NOT_INSTALLED, ""] {
            assert_eq!(
                served(
                    Method::POST,
                    PATH,
                    &request("https://example.invalid/", browser)
                ),
                StatusCode::NOT_FOUND,
                "{browser}"
            );
        }
    }

    #[test]
    fn the_open_route_is_a_whole_segment() {
        assert!(handles("/open"));
        assert!(handles("/open/x"));
        assert!(!handles("/openx"));
        assert!(!handles("/browsers"));
    }

    #[test]
    fn an_editor_link_that_is_held_back_never_reaches_launch_services() {
        let directory = directory("external-held-back");
        std::fs::write(directory.join("a.ts"), "").unwrap();
        let shared = folder_with_mode(&directory, "shared", 0o777);
        let encoded = utf8_percent_encode(directory.to_str().unwrap(), EDITOR_PATH);

        for (link, reason) in [
            (editor_link(&directory, "missing.ts"), NO_FILE),
            (
                url(&format!("vscode://publisher.extension{encoded}/a.ts")),
                NO_FILE,
            ),
            (url(&format!("vscode://FILE{encoded}/a.ts")), NO_FILE),
            (url(&format!("vscode://file{encoded}/a.ts?")), NO_FILE),
            (editor_link(&shared, "a.ts"), UNGUARDED),
        ] {
            assert_eq!(launched(&link, true), (Some(reason), None), "{link}");
        }
    }
}
