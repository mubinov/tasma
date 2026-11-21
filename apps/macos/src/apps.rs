//! The apps that a file opens in, accepted only where they are installed.

use std::path::{Path, PathBuf};

use objc2::rc::Retained;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSString, NSURL};

use crate::command;

/// The data volume, which macOS mounts under `/System`. Each account can write
/// somewhere on it.
const DATA_VOLUME: &str = "/System/Volumes/Data";

/// An app by its bundle id and the real path of its bundle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct App {
    pub(crate) id: String,
    pub(crate) path: PathBuf,
}

/// Whether the real path of an app bundle is in macOS or in an Applications
/// folder. An app in another folder can come from a repository, and Launch
/// Services registers it once Finder shows that folder.
fn is_install_location(real: &Path, account_home: Option<&Path>) -> bool {
    (real.starts_with("/System") && !real.starts_with(DATA_VOLUME))
        || command::in_applications(real, account_home)
}

/// The real path of the app bundle at `url`, when it is installed in macOS or
/// in an Applications folder.
pub(crate) fn installed_at(url: &NSURL) -> Option<PathBuf> {
    let real = std::fs::canonicalize(url.to_file_path()?).ok()?;

    is_install_location(&real, command::account_home().as_deref()).then_some(real)
}

/// The URL and the real path of the first app with the bundle id `id` that is
/// installed in macOS or in an Applications folder.
pub(crate) fn with_id(id: &str) -> Option<(Retained<NSURL>, PathBuf)> {
    NSWorkspace::sharedWorkspace()
        .URLsForApplicationsWithBundleIdentifier(&NSString::from_str(id))
        .iter()
        .find_map(|url| installed_at(&url).map(|real| (url, real)))
}

#[cfg(test)]
mod tests {
    use objc2::rc::autoreleasepool;

    use super::*;
    use crate::testing::directory;

    const HOME: &str = "/Users/someone";

    fn installed(path: &str) -> bool {
        is_install_location(Path::new(path), Some(Path::new(HOME)))
    }

    #[test]
    fn an_app_of_macos_or_in_an_applications_folder_is_installed() {
        for path in [
            "/System/Applications/Example.app",
            "/System/Library/CoreServices/Example.app",
            "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Example.app",
            "/Applications/Example.app",
            "/Applications/Utilities/Example.app",
            "/Applications/Example.app/Contents/Applications/Helper.app",
            "/Users/someone/Applications/Example.app",
        ] {
            assert!(installed(path), "{path}");
        }
    }

    #[test]
    fn an_app_in_another_folder_is_not_installed() {
        for path in [
            "/Users/someone/proj/Viewer.app",
            "/Users/someone/Downloads/Viewer.app",
            "/Users/other/Applications/Viewer.app",
            "/System/Volumes/Data/Users/someone/proj/Viewer.app",
            "/System/Volumes/Data/private/tmp/Viewer.app",
            "/Volumes/Disk/Applications/Viewer.app",
            "/private/tmp/Viewer.app",
            "/SystemX/Viewer.app",
            "/ApplicationsX/Viewer.app",
            "/",
        ] {
            assert!(!installed(path), "{path}");
        }
    }

    #[test]
    fn a_personal_applications_folder_needs_a_known_account_home() {
        assert!(!is_install_location(
            Path::new("/Users/someone/Applications/Example.app"),
            None
        ));
    }

    #[test]
    fn an_app_is_installed_by_its_real_path() {
        let directory = directory("apps-installed-at");
        std::fs::create_dir_all(directory.join("Viewer.app/Contents")).unwrap();
        std::os::unix::fs::symlink(
            "/System/Applications/TextEdit.app",
            directory.join("Linked.app"),
        )
        .unwrap();
        let at = |name: &str| {
            autoreleasepool(|_| {
                installed_at(&NSURL::from_directory_path(directory.join(name)).unwrap())
            })
        };

        assert_eq!(
            at("Linked.app"),
            Some(PathBuf::from("/System/Applications/TextEdit.app"))
        );
        assert_eq!(at("Viewer.app"), None);
        assert_eq!(at("Missing.app"), None);
    }

    #[test]
    fn an_app_is_found_by_its_id_where_it_is_installed() {
        autoreleasepool(|_| {
            assert_eq!(
                with_id("com.apple.TextEdit").map(|(_, real)| real),
                Some(PathBuf::from("/System/Applications/TextEdit.app"))
            );
            assert!(with_id("com.example.not-installed").is_none());
        });
    }
}
