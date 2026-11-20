//! Links that a document opens outside the window: in the default browser,
//! the default mail app or an editor.

use std::os::unix::fs::MetadataExt;
use std::path::Path;

use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSString, NSURL};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use tauri::Url;

use crate::accounts::{ADMINISTRATORS, ROOT};
use crate::log;

/// `LINK_SCHEMES` in `apps/web/src/lib/link-kind.ts`, without the colon.
const SCHEMES: [&str; 3] = ["http", "https", "mailto"];

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

    (!opened).then_some("a link could not be opened")
}

/// Hands a link to Launch Services. A link that is held back or does not open
/// is one line in the log, the only place a bundle's own output can be read.
pub fn open(url: &Url) {
    let failed = failure(url, |target| {
        NSURL::URLWithString(&NSString::from_str(target.as_str()))
            .is_some_and(|link| NSWorkspace::sharedWorkspace().openURL(&link))
    });

    if let Some(reason) = failed {
        let file = log::open(std::env::home_dir().as_deref()).ok();
        log::note(
            file.as_ref(),
            &format!("{reason}: {}", log::quoted(url.as_str())),
        );
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::collections::BTreeSet;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

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
