//! The `tasma` command in PATH: where the link stands, what it points at, and
//! whether this copy of the application may own it.

use std::ffi::{CStr, OsStr};
use std::io::ErrorKind;
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Component, Path, PathBuf};

/// The link the command is reached through. `/etc/paths` lists its folder
/// first, and every terminal starts a login shell that reads it.
pub(crate) const LINK: &str = "/usr/local/bin/tasma";

/// The CLI's file in the bundle, held to `bundle.externalBin` by a repo test.
/// `tasma` would be the application's own `Tasma` on a case-insensitive disk.
pub(crate) const CLI_EXECUTABLE: &str = "tasma-cli";

const APPLICATIONS: &str = "Applications";

/// The `.app` folder an executable stands in, when it has the form
/// `<dir>/<name>.app/Contents/MacOS/<file>`.
pub(crate) fn bundle_of(executable: &Path) -> Option<&Path> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;

    let shaped = macos.file_name() == Some(OsStr::new("MacOS"))
        && contents.file_name() == Some(OsStr::new("Contents"))
        && bundle.extension() == Some(OsStr::new("app"));

    shaped.then_some(bundle)
}

/// Whether this copy runs from an Applications folder, the only place a link
/// to it stays valid. A copy on a disk image, under `target/` or under App
/// Translocation is gone or moved after it quits.
pub(crate) fn installed_location(executable: &Path, account_home: Option<&Path>) -> bool {
    let plain = executable.is_absolute()
        && executable
            .components()
            .all(|part| matches!(part, Component::RootDir | Component::Normal(_)));
    let Some(bundle) = bundle_of(executable).filter(|_| plain) else {
        return false;
    };

    let system = Path::new("/").join(APPLICATIONS);
    let personal = account_home.map(|home| home.join(APPLICATIONS));

    bundle.starts_with(&system) || personal.is_some_and(|folder| bundle.starts_with(folder))
}

/// The CLI in the same bundle as `executable`: the target of the link.
/// `link_state` compares paths exactly, so every caller builds it here.
pub(crate) fn cli_beside(executable: &Path) -> PathBuf {
    executable.with_file_name(CLI_EXECUTABLE)
}

/// This process's executable, when it runs from an Applications folder.
pub(crate) fn installed_executable(account: Option<&Path>) -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .filter(|executable| installed_location(executable, account))
}

/// The home folder of the account, as the user database states it. macOS
/// frameworks write under it whatever `HOME` says.
pub(crate) fn account_home() -> Option<PathBuf> {
    let mut buffer = vec![0 as libc::c_char; 16 * 1024];
    // Safety: `passwd` is plain data, and an all-zero value is a valid one.
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found: *mut libc::passwd = std::ptr::null_mut();

    // Safety: every pointer names memory that lives across the call, and the
    // buffer length is the buffer's own.
    let code = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut entry,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut found,
        )
    };

    if code != 0 || found.is_null() || entry.pw_dir.is_null() {
        return None;
    }

    // Safety: on success `pw_dir` points into the buffer, which is still alive.
    let home = unsafe { CStr::from_ptr(entry.pw_dir) };

    Some(PathBuf::from(OsStr::from_bytes(home.to_bytes())))
}

/// What stands at the link path.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LinkState {
    /// A link to this copy's CLI.
    Installed,
    Missing,
    /// A link Tasma may replace: to nothing, or to the CLI of another copy.
    Stale {
        dangling: bool,
    },
    /// Something Tasma did not make.
    Foreign,
    Unreadable(String),
}

/// Reads what stands at `link`. Needs no privilege.
pub(crate) fn link_state(link: &Path, target: &Path) -> LinkState {
    let stats = match std::fs::symlink_metadata(link) {
        Ok(stats) => stats,
        Err(error) if error.kind() == ErrorKind::NotFound => return LinkState::Missing,
        Err(error) => return LinkState::Unreadable(error.to_string()),
    };

    if !stats.is_symlink() {
        return LinkState::Foreign;
    }

    let points_at = match std::fs::read_link(link) {
        Ok(points_at) => points_at,
        Err(error) => return LinkState::Unreadable(error.to_string()),
    };

    if points_at == target {
        return LinkState::Installed;
    }

    // Followed from the link's own folder. `read_link` answers a relative
    // target as written, and testing that resolves it against the working
    // directory instead.
    match std::fs::metadata(link) {
        Ok(_) if points_at.ends_with(Path::new("Contents/MacOS").join(CLI_EXECUTABLE)) => {
            LinkState::Stale { dangling: false }
        }
        Ok(_) => LinkState::Foreign,
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            LinkState::Stale { dangling: true }
        }
        Err(error) => LinkState::Unreadable(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;
    use crate::testing::directory;

    const HOME: &str = "/Users/someone";

    fn installed(executable: &str) -> bool {
        installed_location(Path::new(executable), Some(Path::new(HOME)))
    }

    #[test]
    fn a_copy_in_an_applications_folder_is_installed() {
        assert!(installed("/Applications/Tasma.app/Contents/MacOS/Tasma"));
        assert!(installed(
            "/Applications/Utilities/Tasma.app/Contents/MacOS/Tasma"
        ));
        assert!(installed(
            "/Users/someone/Applications/Tasma.app/Contents/MacOS/Tasma"
        ));
    }

    #[test]
    fn a_copy_anywhere_else_is_not() {
        assert!(!installed("target/debug/Tasma"));
        assert!(!installed(
            "/work/apps/macos/target/release/bundle/macos/Tasma.app/Contents/MacOS/Tasma"
        ));
        assert!(!installed("/Volumes/Tasma/Tasma.app/Contents/MacOS/Tasma"));
        assert!(!installed(
            "/private/var/folders/xy/abc/T/AppTranslocation/0000-1111/d/Tasma.app/Contents/MacOS/Tasma"
        ));
        assert!(!installed("/Applications/Tasma/Contents/MacOS/Tasma"));
        assert!(!installed("/Applications/Tasma.app/Contents/Tasma"));
        assert!(!installed("/Applications/Tasma.app/Resources/MacOS/Tasma"));
        assert!(!installed(
            "/Applications/../tmp/Tasma.app/Contents/MacOS/Tasma"
        ));
        assert!(!installed("/"));
    }

    #[test]
    fn a_personal_applications_folder_needs_a_known_account_home() {
        assert!(!installed_location(
            Path::new("/Users/someone/Applications/Tasma.app/Contents/MacOS/Tasma"),
            None,
        ));
        assert!(!installed(
            "/Users/other/Applications/Tasma.app/Contents/MacOS/Tasma"
        ));
    }

    #[test]
    fn the_cli_stands_beside_the_executable() {
        assert_eq!(
            cli_beside(Path::new("/Applications/Tasma.app/Contents/MacOS/Tasma")),
            Path::new("/Applications/Tasma.app/Contents/MacOS/tasma-cli"),
        );
    }

    #[test]
    fn the_test_executable_is_not_installed() {
        // It stands under `target/`.
        assert_eq!(installed_executable(account_home().as_deref()), None);
    }

    #[test]
    fn the_account_home_is_an_absolute_folder() {
        let home = account_home().expect("the account has a user database entry");

        assert!(home.is_absolute());
    }

    struct Scene {
        link: PathBuf,
        target: PathBuf,
        root: PathBuf,
    }

    fn scene(test: &str) -> Scene {
        let root = directory(test);
        let macos = root.join("Sample.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let target = macos.join(CLI_EXECUTABLE);
        std::fs::write(&target, "").unwrap();
        std::fs::create_dir(root.join("bin")).unwrap();

        Scene {
            link: root.join("bin/tasma"),
            target,
            root,
        }
    }

    #[test]
    fn nothing_at_the_link_is_missing() {
        let scene = scene("link-missing");

        assert_eq!(link_state(&scene.link, &scene.target), LinkState::Missing);
        assert_eq!(
            link_state(&scene.root.join("absent/tasma"), &scene.target),
            LinkState::Missing,
        );
    }

    #[test]
    fn a_link_to_the_target_is_installed() {
        let scene = scene("link-installed");
        symlink(&scene.target, &scene.link).unwrap();

        assert_eq!(link_state(&scene.link, &scene.target), LinkState::Installed);
    }

    #[test]
    fn a_link_to_nothing_is_stale() {
        let scene = scene("link-dangling");
        symlink(
            scene.root.join("gone/Contents/MacOS/tasma-cli"),
            &scene.link,
        )
        .unwrap();

        assert_eq!(
            link_state(&scene.link, &scene.target),
            LinkState::Stale { dangling: true },
        );
    }

    #[test]
    fn a_link_through_a_file_is_stale() {
        let scene = scene("link-through-a-file");
        symlink(scene.target.join("more"), &scene.link).unwrap();

        assert_eq!(
            link_state(&scene.link, &scene.target),
            LinkState::Stale { dangling: true },
        );
    }

    #[test]
    fn a_relative_link_is_followed_from_its_own_folder() {
        let scene = scene("link-relative");
        symlink("../Sample.app/Contents/MacOS/tasma-cli", &scene.link).unwrap();

        assert_eq!(
            link_state(&scene.link, &scene.target),
            LinkState::Stale { dangling: false },
        );
    }

    #[test]
    fn a_link_to_another_copy_is_stale() {
        let scene = scene("link-another-copy");
        let other = scene.root.join("Other.app/Contents/MacOS");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join(CLI_EXECUTABLE), "").unwrap();
        symlink(other.join(CLI_EXECUTABLE), &scene.link).unwrap();

        assert_eq!(
            link_state(&scene.link, &scene.target),
            LinkState::Stale { dangling: false },
        );
    }

    #[test]
    fn a_link_to_an_unrelated_file_is_foreign() {
        let scene = scene("link-unrelated");
        let other = scene.root.join("other-tool");
        std::fs::write(&other, "").unwrap();
        symlink(&other, &scene.link).unwrap();

        assert_eq!(link_state(&scene.link, &scene.target), LinkState::Foreign);
    }

    #[test]
    fn a_file_or_a_folder_at_the_link_is_foreign() {
        let scene = scene("link-file");
        std::fs::write(&scene.link, "").unwrap();

        assert_eq!(link_state(&scene.link, &scene.target), LinkState::Foreign);

        let scene = self::scene("link-folder");
        std::fs::create_dir(&scene.link).unwrap();

        assert_eq!(link_state(&scene.link, &scene.target), LinkState::Foreign);
    }

    #[test]
    fn a_link_path_that_cannot_be_read_is_unreadable() {
        let scene = scene("link-unreadable");
        // A file where a folder is expected: `ENOTDIR`, not `ENOENT`.
        let link = scene.target.join("tasma");

        assert!(matches!(
            link_state(&link, &scene.target),
            LinkState::Unreadable(_)
        ));
    }

    #[test]
    fn a_link_loop_is_unreadable() {
        let scene = scene("link-loop");
        let other = scene.root.join("bin/loop");
        symlink(&scene.link, &other).unwrap();
        symlink(&other, &scene.link).unwrap();

        assert!(matches!(
            link_state(&scene.link, &scene.target),
            LinkState::Unreadable(_)
        ));
    }

    #[test]
    fn the_bundle_of_an_executable_is_its_app_folder() {
        assert_eq!(
            bundle_of(Path::new("/Applications/Tasma.app/Contents/MacOS/Tasma")),
            Some(Path::new("/Applications/Tasma.app")),
        );
        assert_eq!(bundle_of(Path::new("/Tasma")), None);
    }
}
