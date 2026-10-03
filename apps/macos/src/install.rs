//! The swap of a downloaded release for the running bundle: mount, copy, check
//! and swap, and the `--install-update` process that copies, checks and swaps
//! as root.

use std::ffi::{CString, OsString};
use std::io::ErrorKind;
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use semver::Version;

use crate::command::bundle_of;

/// The argument of the child that asks for the administrator password, and of
/// the process that the password starts as root.
pub(crate) const ELEVATED_ARGUMENT: &str = "--install-update-elevated";
pub(crate) const ROOT_ARGUMENT: &str = "--install-update";

/// The bundle identifier of every release, held to `tauri.conf.json` by a repo
/// test.
pub(crate) const IDENTIFIER: &str = "dev.tasma.desktop";

/// The team of the Developer ID certificate that signs every release, held to
/// `scripts/app-release.sh` by a repo test.
pub(crate) const TEAM: &str = "3A8ZGST774";

/// The bundle at the root of a release DMG.
pub(crate) const IMAGE_BUNDLE: &str = "Tasma.app";

/// The first exit code of a failure. The link steps of `elevate.rs` use the
/// codes below it.
const FIRST_CODE: i32 = 10;

/// How an install failed. The reason is all that the sidebar shows, never the
/// output of a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Failure {
    Download,
    Open,
    Unsigned,
    WrongVersion,
    Replace,
    Password,
    Busy,
    Disk,
}

const FAILURES: [Failure; 8] = [
    Failure::Download,
    Failure::Open,
    Failure::Unsigned,
    Failure::WrongVersion,
    Failure::Replace,
    Failure::Password,
    Failure::Busy,
    Failure::Disk,
];

impl Failure {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::Download => "The download failed.",
            Self::Open => "The update file could not be opened.",
            Self::Unsigned => "The update is not signed by the Tasma developer.",
            Self::WrongVersion => "The update has the wrong version.",
            Self::Replace => "Tasma could not replace the app.",
            Self::Password => "The administrator password was not entered.",
            Self::Busy => "Another administrator password prompt is open.",
            Self::Disk => "This disk does not support the update.",
        }
    }

    /// The exit code that carries this failure from a child to the app.
    pub(crate) fn code(self) -> i32 {
        let at = FAILURES
            .iter()
            .position(|failure| *failure == self)
            .expect("every failure is listed");

        FIRST_CODE + i32::try_from(at).expect("eight failures fit an exit code")
    }

    pub(crate) fn of_code(code: i32) -> Option<Self> {
        FAILURES.into_iter().find(|failure| failure.code() == code)
    }
}

/// The system tools an install runs. Tests name stubs.
#[derive(Debug, Clone)]
pub(crate) struct Tools {
    pub(crate) hdiutil: PathBuf,
    pub(crate) ditto: PathBuf,
    pub(crate) codesign: PathBuf,
}

impl Tools {
    pub(crate) fn system() -> Self {
        Self {
            hdiutil: PathBuf::from("/usr/bin/hdiutil"),
            ditto: PathBuf::from("/usr/bin/ditto"),
            codesign: PathBuf::from("/usr/bin/codesign"),
        }
    }
}

/// A Developer ID Application certificate of the team.
fn requirement() -> String {
    format!(
        "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"{TEAM}\""
    )
}

/// Runs a tool with no input and no output, and answers whether it succeeded.
fn quiet(command: &mut Command) -> bool {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// A string value of a bundle's `Info.plist`.
fn info(bundle: &Path, key: &str) -> Option<String> {
    let value = plist::Value::from_file(bundle.join("Contents/Info.plist")).ok()?;

    value
        .as_dictionary()?
        .get(key)?
        .as_string()
        .map(str::to_string)
}

pub(crate) fn bundle_version(bundle: &Path) -> Option<Version> {
    Version::parse(&info(bundle, "CFBundleShortVersionString")?).ok()
}

/// Whether the bundle on disk already has `version` or a higher one: another
/// OS user's copy has installed it.
pub(crate) fn already_installed(installed: &Path, version: &Version) -> bool {
    bundle_version(installed).is_some_and(|found| found >= *version)
}

/// Where a new bundle is copied before the swap: a hidden folder beside the
/// installed bundle, so the swap stays on one volume, and the copy under the
/// installed name inside it.
fn staged_of(installed: &Path) -> Option<(PathBuf, PathBuf)> {
    let bundle = installed.file_name()?;
    let mut name = OsString::from(".");
    name.push(bundle);
    name.push(".new");

    let staging = installed.with_file_name(name);
    let staged = staging.join(bundle);

    Some((staging, staged))
}

/// Whether the app can replace the bundle without administrator rights.
pub(crate) fn writable(installed: &Path) -> bool {
    // Safety: `getuid` reads the calling process and changes nothing.
    let owned = std::fs::symlink_metadata(installed)
        .is_ok_and(|stats| stats.uid() == unsafe { libc::getuid() });

    owned
        && installed
            .parent()
            .and_then(|folder| CString::new(folder.as_os_str().as_bytes()).ok())
            // Safety: the name lives across the call.
            .is_some_and(|folder| unsafe { libc::access(folder.as_ptr(), libc::W_OK) } == 0)
}

const ROOT: u32 = 0;

/// The groups `wheel` and `admin`, whose members can act as root already.
const ADMINISTRATORS: [u32; 2] = [0, 80];

/// Whether no account other than root and the administrators can change
/// `folder` or a folder above it. Root works on paths under the folder, and an
/// account that can rename one of these folders can redirect them.
pub(crate) fn protected(folder: &Path) -> bool {
    std::fs::canonicalize(folder).is_ok_and(|real| {
        real.ancestors().all(|part| {
            std::fs::symlink_metadata(part)
                .is_ok_and(|stats| guarded(stats.uid(), stats.gid(), stats.mode()))
        })
    })
}

fn guarded(uid: u32, gid: u32, mode: u32) -> bool {
    uid == ROOT && mode & 0o002 == 0 && (mode & 0o020 == 0 || ADMINISTRATORS.contains(&gid))
}

/// Deletes what stands at a path, without following a link there.
fn remove(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(stats) if stats.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Whether `path` names itself with no link and no `..` in it.
pub(crate) fn is_real(path: &Path) -> bool {
    std::fs::canonicalize(path).is_ok_and(|real| real == path)
}

/// A Developer ID signature of the team on the DMG, checked before
/// `hdiutil` reads anything of it.
fn check_image(tools: &Tools, image: &Path) -> Result<(), Failure> {
    let signed = quiet(
        Command::new(&tools.codesign)
            .args(["--verify", "--strict"])
            .arg(format!("-R={}", requirement()))
            .arg(image),
    );

    signed.then_some(()).ok_or(Failure::Unsigned)
}

/// Mounts a DMG read-only, where Finder does not show it.
fn mount(tools: &Tools, image: &Path, mountpoint: &Path) -> Result<(), Failure> {
    let attached = quiet(
        Command::new(&tools.hdiutil)
            .args([
                "attach",
                "-readonly",
                "-nobrowse",
                "-noautoopen",
                "-mountpoint",
            ])
            .arg(mountpoint)
            .arg(image),
    );

    attached.then_some(()).ok_or(Failure::Open)
}

fn detach(tools: &Tools, mountpoint: &Path) {
    quiet(
        Command::new(&tools.hdiutil)
            .args(["detach", "-force"])
            .arg(mountpoint),
    );
}

/// Copies the bundle of a mounted release beside `installed`, restricts the
/// copy, and checks it. The check reads the copy, so nothing can change the
/// files between the check and the swap. On a failure nothing is left of the
/// copy.
pub(crate) fn stage(
    tools: &Tools,
    source: &Path,
    installed: &Path,
    version: &Version,
    owner: Option<(u32, u32)>,
) -> Result<(), Failure> {
    let (staging, staged) = staged_of(installed).ok_or(Failure::Replace)?;
    let result = copy(tools, source, &staging, &staged).and_then(|()| {
        restrict(&staged, owner).map_err(|_| Failure::Replace)?;

        check(tools, &staged, version)
    });

    if result.is_err() {
        let _ = remove(&staging);
    }

    result
}

fn copy(tools: &Tools, source: &Path, staging: &Path, staged: &Path) -> Result<(), Failure> {
    if !source.is_dir() {
        return Err(Failure::Open);
    }

    remove(staging).map_err(|_| Failure::Replace)?;

    // Made here and open to this process's user alone, so no other account can
    // reach the copy before the swap: the image records its own file owners,
    // which a copy as root keeps.
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(staging)
        .map_err(|_| Failure::Replace)?;

    let copied = quiet(
        Command::new(&tools.ditto)
            .arg("--noacl")
            .arg(source)
            .arg(staged),
    );

    copied.then_some(()).ok_or(Failure::Replace)
}

/// A Developer ID signature of the team, the identifier of Tasma, and the
/// version of the release.
fn check(tools: &Tools, bundle: &Path, version: &Version) -> Result<(), Failure> {
    let signed = quiet(
        Command::new(&tools.codesign)
            .args(["--verify", "--deep", "--strict"])
            .arg(format!("-R={}", requirement()))
            .arg(bundle),
    );

    if !signed || info(bundle, "CFBundleIdentifier").as_deref() != Some(IDENTIFIER) {
        return Err(Failure::Unsigned);
    }

    if bundle_version(bundle).as_ref() != Some(version) {
        return Err(Failure::WrongVersion);
    }

    Ok(())
}

/// Exchanges two folders in one step, so no moment exists when either path is
/// missing.
fn exchange(one: &Path, other: &Path) -> std::io::Result<()> {
    let one = CString::new(one.as_os_str().as_bytes())?;
    let other = CString::new(other.as_os_str().as_bytes())?;

    // Safety: both names live across the call.
    let code = unsafe { libc::renamex_np(one.as_ptr(), other.as_ptr(), libc::RENAME_SWAP) };

    if code == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Swaps the staged bundle in and deletes the old one, which the swap leaves in
/// its place. On a failure the installed bundle is unchanged and nothing is
/// left of the copy.
pub(crate) fn swap_in(installed: &Path) -> Result<(), Failure> {
    let (staging, staged) = staged_of(installed).ok_or(Failure::Replace)?;
    let swapped = exchange(&staged, installed);
    let _ = remove(&staging);

    swapped.map_err(|error| {
        // `RENAME_SWAP` needs APFS.
        if error.raw_os_error() == Some(libc::ENOTSUP) {
            Failure::Disk
        } else {
            Failure::Replace
        }
    })
}

/// The setuid, setgid, group-write and other-write bits.
const UNSAFE_MODE: u32 = 0o6022;

/// Gives every file under `path` the owner and the group of the installed
/// bundle when one is named, and takes the `UNSAFE_MODE` bits from it, without
/// following a link. The signature covers no file mode, and a copy keeps them.
fn restrict(path: &Path, owner: Option<(u32, u32)>) -> std::io::Result<()> {
    if let Some((uid, gid)) = owner {
        std::os::unix::fs::lchown(path, Some(uid), Some(gid))?;
    }

    let stats = std::fs::symlink_metadata(path)?;

    if stats.is_symlink() {
        return Ok(());
    }

    let name = CString::new(path.as_os_str().as_bytes())?;
    let mode = libc::mode_t::try_from(stats.mode() & 0o7777 & !UNSAFE_MODE)
        .map_err(|_| std::io::Error::from(ErrorKind::InvalidData))?;

    let flag = libc::AT_SYMLINK_NOFOLLOW;
    // Safety: the name lives across the call.
    let code = unsafe { libc::fchmodat(libc::AT_FDCWD, name.as_ptr(), mode, flag) };

    if code != 0 {
        return Err(std::io::Error::last_os_error());
    }

    if stats.is_dir() {
        for entry in std::fs::read_dir(path)? {
            restrict(&entry?.path(), owner)?;
        }
    }

    Ok(())
}

/// A folder of its own for one install: the download and the mount point.
/// Dropped, it detaches the image and deletes itself.
pub(crate) struct Scratch {
    folder: PathBuf,
    tools: Tools,
    mounted: bool,
}

impl Scratch {
    pub(crate) fn new(root: &Path, tools: &Tools) -> std::io::Result<Self> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        let folder = root.join(format!("tasma-update-{}-{nanos}", std::process::id()));

        std::fs::DirBuilder::new().mode(0o700).create(&folder)?;

        Ok(Self {
            folder,
            tools: tools.clone(),
            mounted: false,
        })
    }

    pub(crate) fn image(&self) -> PathBuf {
        self.folder.join("update.dmg")
    }

    fn mountpoint(&self) -> PathBuf {
        self.folder.join("mount")
    }

    /// The bundle inside the mounted image.
    pub(crate) fn source(&self) -> PathBuf {
        self.mountpoint().join(IMAGE_BUNDLE)
    }

    pub(crate) fn mount(&mut self) -> Result<(), Failure> {
        check_image(&self.tools, &self.image())?;
        mount(&self.tools, &self.image(), &self.mountpoint())?;
        self.mounted = true;

        Ok(())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if self.mounted {
            detach(&self.tools, &self.mountpoint());
        }

        let _ = std::fs::remove_dir_all(&self.folder);
    }
}

/// What the hidden arguments ask the process to do instead of opening the
/// window.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Request {
    /// Ask for the administrator password, as the user.
    Elevated { source: PathBuf, version: String },
    /// Copy, check and swap, as root.
    Root { source: PathBuf, version: String },
    /// A hidden argument with the wrong arguments after it.
    Malformed,
}

/// The request of the arguments, the program name first.
pub(crate) fn requested(arguments: &[OsString]) -> Option<Request> {
    let flag = arguments.get(1)?;

    if flag != ELEVATED_ARGUMENT && flag != ROOT_ARGUMENT {
        return None;
    }

    let [_, _, source, version] = arguments else {
        return Some(Request::Malformed);
    };
    let Some(version) = version.to_str().map(str::to_string) else {
        return Some(Request::Malformed);
    };
    let source = PathBuf::from(source);

    Some(if flag == ELEVATED_ARGUMENT {
        Request::Elevated { source, version }
    } else {
        Request::Root { source, version }
    })
}

/// The root process: replaces the bundle this executable stands in with the
/// release mounted at `source`, and exits with the code of the result.
pub(crate) fn run_root(source: &Path, version: &str) -> i32 {
    match std::env::current_exe() {
        Ok(executable) => exit_code(replace_as_root(
            &executable,
            source,
            version,
            &Tools::system(),
            protected,
        )),
        Err(_) => Failure::Replace.code(),
    }
}

fn exit_code(result: Result<(), Failure>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(failure) => failure.code(),
    }
}

/// The installed path comes from the executable, never from the arguments: as
/// root, an argument could name any folder on the disk. Any process of the user
/// can start this with any signed release, so an equal or a lower version
/// changes nothing. `protected` checks the real folders only, so a path with a
/// link in it is refused.
fn replace_as_root(
    executable: &Path,
    source: &Path,
    version: &str,
    tools: &Tools,
    protected: impl FnOnce(&Path) -> bool,
) -> Result<(), Failure> {
    let version = Version::parse(version).map_err(|_| Failure::WrongVersion)?;
    let installed = bundle_of(executable)
        .filter(|_| is_real(executable))
        .ok_or(Failure::Replace)?;

    if already_installed(installed, &version) {
        return Ok(());
    }

    if !installed.parent().is_some_and(protected) {
        return Err(Failure::Replace);
    }

    let stats = std::fs::symlink_metadata(installed).map_err(|_| Failure::Replace)?;

    stage(
        tools,
        source,
        installed,
        &version,
        Some((stats.uid(), stats.gid())),
    )?;

    swap_in(installed)
}

/// Stand-in bundles and tools for the tests of this module and of the update.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use crate::testing::script_file;

    /// A bundle with an `Info.plist` and one executable, under `folder`.
    pub(crate) fn bundle(folder: &Path, name: &str, identifier: &str, version: &str) -> PathBuf {
        let bundle = folder.join(name);
        let macos = bundle.join("Contents/MacOS");

        std::fs::create_dir_all(&macos).unwrap();
        std::fs::write(
            bundle.join("Contents/Info.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>{identifier}</string>
  <key>CFBundleShortVersionString</key>
  <string>{version}</string>
</dict>
</plist>
"#
            ),
        )
        .unwrap();
        std::fs::write(macos.join("Sample"), version).unwrap();

        bundle
    }

    /// The real `ditto`, and stubs for the rest: `hdiutil attach` copies
    /// `mounted` into the mount point when the image exists, `hdiutil detach`
    /// records itself in `<folder>/detached`, and `codesign` passes when
    /// `signed`.
    pub(crate) fn tools(folder: &Path, mounted: &Path, signed: bool) -> Tools {
        let hdiutil = script_file(
            &folder.join("hdiutil"),
            &format!(
                r#"case "$1" in
attach) [ -f "$7" ] || exit 1; mkdir -p "$6" && cp -R '{}' "$6/" ;;
detach) echo detached >> '{}' ;;
esac"#,
                mounted.display(),
                folder.join("detached").display(),
            ),
        );
        let codesign = script_file(
            &folder.join("codesign"),
            if signed { "exit 0" } else { "exit 1" },
        );

        Tools {
            hdiutil,
            ditto: PathBuf::from("/usr/bin/ditto"),
            codesign,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::fixtures::*;
    use super::*;
    use crate::testing::{directory, script_file};

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    #[test]
    fn each_failure_has_its_own_exit_code_and_reason() {
        let codes: Vec<i32> = FAILURES.iter().map(|failure| failure.code()).collect();

        assert_eq!(codes, (10..18).collect::<Vec<_>>());
        for failure in FAILURES {
            assert_eq!(Failure::of_code(failure.code()), Some(failure));
            assert!(failure.reason().ends_with('.'));
        }
        assert_eq!(Failure::of_code(0), None);
        assert_eq!(Failure::of_code(3), None);
        assert_eq!(Failure::of_code(18), None);
    }

    #[test]
    fn the_requirement_names_a_developer_id_certificate_of_the_team() {
        assert_eq!(
            requirement(),
            r#"anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "3A8ZGST774""#,
        );
    }

    #[test]
    fn the_codesign_check_is_strict_and_tests_the_requirement() {
        let folder = directory("codesign-arguments");
        let bundle = bundle(&folder, "Sample.app", IDENTIFIER, "1.2.0");
        let codesign = script_file(
            &folder.join("codesign"),
            &format!(
                r#"[ "$1 $2 $3" = "--verify --deep --strict" ] || exit 1
[ "$4" = "-R={}" ] || exit 1
[ "$5" = "{}" ]"#,
                requirement().replace('"', "\\\""),
                bundle.display(),
            ),
        );
        let tools = Tools {
            codesign,
            ..Tools::system()
        };

        assert_eq!(check(&tools, &bundle, &version("1.2.0")), Ok(()));
    }

    #[test]
    fn a_bundle_is_accepted_only_with_the_signature_the_identifier_and_the_version() {
        let folder = directory("check");
        let ours = bundle(&folder, "Ours.app", IDENTIFIER, "1.2.0");
        let other = bundle(&folder, "Other.app", "org.example.other", "1.2.0");
        let signed = tools(&directory("check-signed"), &folder, true);
        let unsigned = tools(&directory("check-unsigned"), &folder, false);

        assert_eq!(check(&signed, &ours, &version("1.2.0")), Ok(()));
        assert_eq!(
            check(&unsigned, &ours, &version("1.2.0")),
            Err(Failure::Unsigned)
        );
        assert_eq!(
            check(&signed, &other, &version("1.2.0")),
            Err(Failure::Unsigned)
        );
        assert_eq!(
            check(&signed, &ours, &version("1.3.0")),
            Err(Failure::WrongVersion)
        );
        assert_eq!(
            check(&signed, &folder.join("Absent.app"), &version("1.2.0")),
            Err(Failure::Unsigned)
        );
    }

    #[test]
    fn a_version_on_disk_is_read_from_the_info_plist() {
        let folder = directory("bundle-version");
        let installed = bundle(&folder, "Sample.app", IDENTIFIER, "1.2.0");
        let broken = bundle(&folder, "Broken.app", IDENTIFIER, "one");

        assert_eq!(bundle_version(&installed), Some(version("1.2.0")));
        assert_eq!(bundle_version(&broken), None);
        assert_eq!(bundle_version(&folder.join("Absent.app")), None);

        assert!(already_installed(&installed, &version("1.2.0")));
        assert!(already_installed(&installed, &version("1.1.0")));
        assert!(!already_installed(&installed, &version("1.3.0")));
        assert!(!already_installed(&broken, &version("1.3.0")));
    }

    #[test]
    fn the_staged_copy_is_in_a_hidden_folder_beside_the_bundle() {
        assert_eq!(
            staged_of(Path::new("/Applications/My Tasma.app")),
            Some((
                PathBuf::from("/Applications/.My Tasma.app.new"),
                PathBuf::from("/Applications/.My Tasma.app.new/My Tasma.app"),
            )),
        );
        assert_eq!(staged_of(Path::new("/")), None);
    }

    #[test]
    fn a_bundle_of_the_user_in_a_folder_of_the_user_is_writable() {
        let folder = directory("writable");
        let installed = bundle(&folder, "Sample.app", IDENTIFIER, "1.0.0");

        assert!(writable(&installed));
        assert!(!writable(&folder.join("Absent.app")));

        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
        let locked = writable(&installed);
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(!locked);
        // A bundle owned by another account.
        assert!(!writable(Path::new("/System/Applications/Calculator.app")));
    }

    /// An installed bundle, a release to install and the stub tools, in one
    /// folder.
    struct Scene {
        folder: PathBuf,
        installed: PathBuf,
        staging: PathBuf,
        source: PathBuf,
    }

    fn scene(test: &str, release_identifier: &str) -> Scene {
        // The root process refuses an executable path that holds a link, and
        // the temporary folder is under one.
        let folder = std::fs::canonicalize(directory(test)).unwrap();
        let applications = folder.join("Applications");
        let release = folder.join("release");

        std::fs::create_dir_all(&applications).unwrap();
        std::fs::create_dir_all(&release).unwrap();

        let installed = bundle(&applications, "My Sample.app", IDENTIFIER, "1.0.0");
        let source = bundle(&release, IMAGE_BUNDLE, release_identifier, "1.1.0");

        Scene {
            staging: staged_of(&installed).unwrap().0,
            folder,
            installed,
            source,
        }
    }

    fn installed_text(scene: &Scene) -> String {
        std::fs::read_to_string(scene.installed.join("Contents/MacOS/Sample")).unwrap()
    }

    #[test]
    fn a_staged_release_swaps_in_and_the_old_bundle_is_deleted() {
        let scene = scene("swap", IDENTIFIER);
        let tools = tools(&scene.folder, &scene.folder, true);
        // A copy left from an earlier attempt.
        std::fs::create_dir(&scene.staging).unwrap();
        std::fs::write(scene.staging.join("left"), "").unwrap();

        stage(
            &tools,
            &scene.source,
            &scene.installed,
            &version("1.1.0"),
            None,
        )
        .unwrap();

        assert!(!scene.staging.join("left").exists());
        assert_eq!(
            std::fs::metadata(&scene.staging)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "no other account can reach the copy"
        );

        swap_in(&scene.installed).unwrap();

        assert_eq!(installed_text(&scene), "1.1.0");
        assert_eq!(bundle_version(&scene.installed), Some(version("1.1.0")));
        assert!(!scene.staging.exists());
    }

    fn mode(path: &Path) -> u32 {
        std::fs::symlink_metadata(path).unwrap().mode() & 0o7777
    }

    fn has_acl(path: &Path) -> bool {
        let listing = Command::new("/bin/ls")
            .arg("-led")
            .arg(path)
            .output()
            .unwrap();

        String::from_utf8_lossy(&listing.stdout)
            .lines()
            .any(|line| line.trim_start().starts_with("0:"))
    }

    #[test]
    fn the_copy_keeps_no_write_bit_for_other_accounts_no_setuid_bit_and_no_acl() {
        let scene = scene("stage-modes", IDENTIFIER);
        let executable = scene.source.join("Contents/MacOS/Sample");
        let info = scene.source.join("Contents/Info.plist");
        let folder = scene.source.join("Contents/MacOS");
        let link = scene.source.join("Contents/Link");
        std::os::unix::fs::symlink("MacOS/Sample", &link).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o4777)).unwrap();
        std::fs::set_permissions(&info, std::fs::Permissions::from_mode(0o2666)).unwrap();
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(
            Command::new("/bin/chmod")
                .args(["+a", "everyone allow write"])
                .arg(&info)
                .status()
                .unwrap()
                .success()
        );
        assert!(has_acl(&info));
        let tools = tools(&scene.folder, &scene.folder, true);

        stage(
            &tools,
            &scene.source,
            &scene.installed,
            &version("1.1.0"),
            None,
        )
        .unwrap();

        let staged = staged_of(&scene.installed).unwrap().1;
        assert_eq!(mode(&staged.join("Contents/MacOS/Sample")), 0o755);
        assert_eq!(mode(&staged.join("Contents/Info.plist")), 0o644);
        assert_eq!(mode(&staged.join("Contents/MacOS")), 0o755);
        assert!(!has_acl(&staged.join("Contents/Info.plist")));
        assert!(
            std::fs::symlink_metadata(staged.join("Contents/Link"))
                .unwrap()
                .is_symlink()
        );
    }

    #[test]
    fn a_failure_at_each_step_leaves_the_installed_bundle_and_no_copy() {
        let unsigned = scene("fail-signature", IDENTIFIER);
        let tools_unsigned = tools(&unsigned.folder, &unsigned.folder, false);
        assert_eq!(
            stage(
                &tools_unsigned,
                &unsigned.source,
                &unsigned.installed,
                &version("1.1.0"),
                None
            ),
            Err(Failure::Unsigned),
        );

        let wrong = scene("fail-version", IDENTIFIER);
        let signed = tools(&wrong.folder, &wrong.folder, true);
        assert_eq!(
            stage(
                &signed,
                &wrong.source,
                &wrong.installed,
                &version("1.2.0"),
                None
            ),
            Err(Failure::WrongVersion),
        );

        let missing = scene("fail-source", IDENTIFIER);
        assert_eq!(
            stage(
                &signed,
                &missing.folder.join("absent/Tasma.app"),
                &missing.installed,
                &version("1.1.0"),
                None
            ),
            Err(Failure::Open),
        );

        let copy = scene("fail-copy", IDENTIFIER);
        let broken_ditto = Tools {
            ditto: script_file(&copy.folder.join("ditto"), "exit 1"),
            ..signed.clone()
        };
        assert_eq!(
            stage(
                &broken_ditto,
                &copy.source,
                &copy.installed,
                &version("1.1.0"),
                None
            ),
            Err(Failure::Replace),
        );

        // Only root can give a file to another account.
        let owner = scene("fail-owner", IDENTIFIER);
        assert_eq!(
            stage(
                &signed,
                &owner.source,
                &owner.installed,
                &version("1.1.0"),
                Some((0, 0))
            ),
            Err(Failure::Replace),
        );

        let folder = scene("fail-folder", IDENTIFIER);
        let applications = folder.installed.parent().unwrap().to_path_buf();
        std::fs::set_permissions(&applications, std::fs::Permissions::from_mode(0o555)).unwrap();
        let unwritable = stage(
            &signed,
            &folder.source,
            &folder.installed,
            &version("1.1.0"),
            None,
        );
        std::fs::set_permissions(&applications, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(unwritable, Err(Failure::Replace));

        // A copy left from an earlier attempt that cannot be deleted.
        let left = scene("fail-left", IDENTIFIER);
        let applications = left.installed.parent().unwrap().to_path_buf();
        std::fs::create_dir(&left.staging).unwrap();
        std::fs::set_permissions(&applications, std::fs::Permissions::from_mode(0o555)).unwrap();
        let undeletable = stage(
            &signed,
            &left.source,
            &left.installed,
            &version("1.1.0"),
            None,
        );
        std::fs::set_permissions(&applications, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(undeletable, Err(Failure::Replace));
        assert_eq!(installed_text(&left), "1.0.0");

        for scene in [&unsigned, &wrong, &missing, &copy, &owner, &folder] {
            assert_eq!(installed_text(scene), "1.0.0");
            assert!(!scene.staging.exists(), "{}", scene.staging.display());
        }

        assert_eq!(
            stage(
                &signed,
                &copy.source,
                Path::new("/"),
                &version("1.1.0"),
                None
            ),
            Err(Failure::Replace),
        );
        assert_eq!(swap_in(Path::new("/")), Err(Failure::Replace));
    }

    #[test]
    fn a_swap_that_fails_leaves_the_installed_bundle_and_no_copy() {
        let scene = scene("fail-swap", IDENTIFIER);
        let tools = tools(&scene.folder, &scene.folder, true);
        let away = scene.folder.join("away");

        stage(
            &tools,
            &scene.source,
            &scene.installed,
            &version("1.1.0"),
            None,
        )
        .unwrap();

        // The installed bundle is gone, so there is nothing to swap with.
        std::fs::rename(&scene.installed, &away).unwrap();
        let swapped = swap_in(&scene.installed);
        std::fs::rename(&away, &scene.installed).unwrap();

        assert_eq!(swapped, Err(Failure::Replace));
        assert_eq!(installed_text(&scene), "1.0.0");
        assert!(!scene.staging.exists());
    }

    #[test]
    fn a_path_that_holds_a_zero_byte_cannot_be_swapped() {
        assert!(exchange(Path::new("/tmp/a\0b"), Path::new("/tmp/c")).is_err());
    }

    #[test]
    fn a_disk_without_the_atomic_swap_is_named() {
        // HFS+ has no `RENAME_SWAP`. The volume is made only where `hdiutil`
        // can attach one, so a sandbox skips this.
        let Some(volume) = Volume::hfs("no-swap") else {
            return;
        };
        let installed = volume.0.join("one");
        std::fs::create_dir(&installed).unwrap();
        std::fs::create_dir_all(staged_of(&installed).unwrap().1).unwrap();

        assert_eq!(swap_in(&installed), Err(Failure::Disk));
    }

    /// A small writable HFS+ volume, mounted under the test's directory, and
    /// detached when dropped.
    struct Volume(PathBuf);

    impl Volume {
        fn hfs(test: &str) -> Option<Self> {
            let folder = directory(test);
            let image = folder.join("disk.dmg");
            let mountpoint = folder.join("volume");
            let made = quiet(
                Command::new("/usr/bin/hdiutil")
                    .args(["create", "-size", "2m", "-fs", "HFS+", "-volname", "Sample"])
                    .arg(&image),
            );
            let attached = made
                && quiet(
                    Command::new("/usr/bin/hdiutil")
                        .args(["attach", "-nobrowse", "-noautoopen", "-mountpoint"])
                        .arg(&mountpoint)
                        .arg(&image),
                );

            attached.then_some(Self(mountpoint))
        }
    }

    impl Drop for Volume {
        fn drop(&mut self) {
            detach(&Tools::system(), &self.0);
        }
    }

    #[test]
    fn a_mount_that_fails_cannot_open_the_update() {
        let folder = directory("mount-fails");
        let tools = tools(&folder, &folder, true);

        assert_eq!(
            mount(&tools, &folder.join("absent.dmg"), &folder.join("mount")),
            Err(Failure::Open)
        );
    }

    #[test]
    fn the_image_check_tests_the_requirement() {
        let folder = directory("image-arguments");
        let image = folder.join("update.dmg");
        let codesign = script_file(
            &folder.join("codesign"),
            &format!(
                r#"[ "$1 $2" = "--verify --strict" ] || exit 1
[ "$3" = "-R={}" ] || exit 1
[ "$4" = "{}" ]"#,
                requirement().replace('"', "\\\""),
                image.display(),
            ),
        );
        let tools = Tools {
            codesign,
            ..Tools::system()
        };

        assert_eq!(check_image(&tools, &image), Ok(()));
        assert_eq!(
            check_image(&tools, &folder.join("other.dmg")),
            Err(Failure::Unsigned)
        );
    }

    #[test]
    fn an_image_without_the_signature_is_never_mounted() {
        let folder = directory("image-unsigned");
        let release = folder.join("release");
        std::fs::create_dir(&release).unwrap();
        bundle(&release, IMAGE_BUNDLE, IDENTIFIER, "1.1.0");
        let tools = tools(&folder, &release.join(IMAGE_BUNDLE), false);

        let mut scratch = Scratch::new(&folder, &tools).unwrap();
        std::fs::write(scratch.image(), "image").unwrap();

        assert_eq!(scratch.mount(), Err(Failure::Unsigned));
        assert!(!scratch.mountpoint().exists());

        drop(scratch);
        assert!(!folder.join("detached").exists());
    }

    #[test]
    fn a_scratch_folder_detaches_its_image_and_deletes_itself() {
        let folder = directory("scratch");
        let release = folder.join("release");
        std::fs::create_dir(&release).unwrap();
        bundle(&release, IMAGE_BUNDLE, IDENTIFIER, "1.1.0");
        let tools = tools(&folder, &release.join(IMAGE_BUNDLE), true);

        let mut scratch = Scratch::new(&folder, &tools).unwrap();
        let made = scratch.folder.clone();
        std::fs::write(scratch.image(), "image").unwrap();
        scratch.mount().unwrap();

        assert_eq!(bundle_version(&scratch.source()), Some(version("1.1.0")));
        assert_eq!(
            std::fs::metadata(&made).unwrap().permissions().mode() & 0o777,
            0o700
        );

        drop(scratch);

        assert!(!made.exists());
        assert_eq!(
            std::fs::read_to_string(folder.join("detached")).unwrap(),
            "detached\n"
        );
    }

    #[test]
    fn a_scratch_folder_that_was_never_mounted_is_not_detached() {
        let folder = directory("scratch-unmounted");
        let tools = tools(&folder, &folder, true);

        let scratch = Scratch::new(&folder, &tools).unwrap();
        let made = scratch.folder.clone();
        drop(scratch);

        assert!(!made.exists());
        assert!(!folder.join("detached").exists());
        assert!(Scratch::new(&folder.join("absent"), &tools).is_err());
    }

    fn arguments(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn the_hidden_arguments_name_the_source_and_the_version_only() {
        assert_eq!(
            requested(&arguments(&[
                "Tasma",
                "--install-update-elevated",
                "/tmp/m/Tasma.app",
                "1.1.0"
            ])),
            Some(Request::Elevated {
                source: PathBuf::from("/tmp/m/Tasma.app"),
                version: "1.1.0".to_string(),
            }),
        );
        assert_eq!(
            requested(&arguments(&[
                "Tasma",
                "--install-update",
                "/tmp/m/Tasma.app",
                "1.1.0"
            ])),
            Some(Request::Root {
                source: PathBuf::from("/tmp/m/Tasma.app"),
                version: "1.1.0".to_string(),
            }),
        );
    }

    #[test]
    fn a_hidden_argument_with_the_wrong_arguments_is_malformed() {
        assert_eq!(
            requested(&arguments(&["Tasma", "--install-update"])),
            Some(Request::Malformed)
        );
        assert_eq!(
            requested(&arguments(&["Tasma", "--install-update", "/a", "1", "/b"])),
            Some(Request::Malformed),
        );

        let not_utf8 = vec![
            OsString::from("Tasma"),
            OsString::from("--install-update"),
            OsString::from("/a"),
            OsString::from(std::ffi::OsStr::from_bytes(b"\xff")),
        ];
        assert_eq!(requested(&not_utf8), Some(Request::Malformed));
    }

    #[test]
    fn any_other_argument_is_no_update_request() {
        assert_eq!(requested(&arguments(&["Tasma"])), None);
        assert_eq!(
            requested(&arguments(&["Tasma", "--install-command-line-tool"])),
            None
        );
        assert_eq!(
            requested(&arguments(&["Tasma", "-psn_0_1", "a", "b"])),
            None
        );
    }

    #[test]
    fn the_root_process_replaces_the_bundle_of_its_own_executable() {
        let scene = scene("root", IDENTIFIER);
        let tools = tools(&scene.folder, &scene.folder, true);
        let executable = scene.installed.join("Contents/MacOS/Sample");

        let result = replace_as_root(&executable, &scene.source, "1.1.0", &tools, |_| true);

        assert_eq!(result, Ok(()));
        assert_eq!(installed_text(&scene), "1.1.0");
        assert!(!scene.staging.exists());
        // Safety: `getuid` reads the calling process and changes nothing.
        assert_eq!(
            std::fs::metadata(scene.installed.join("Contents/MacOS/Sample"))
                .unwrap()
                .uid(),
            unsafe { libc::getuid() }
        );
    }

    #[test]
    fn the_root_process_refuses_what_it_cannot_install() {
        let scene = scene("root-refuses", "org.example.other");
        let tools = tools(&scene.folder, &scene.folder, true);
        let executable = scene.installed.join("Contents/MacOS/Sample");

        assert_eq!(
            replace_as_root(&executable, &scene.source, "1.1.0", &tools, |_| true),
            Err(Failure::Unsigned)
        );
        assert_eq!(
            replace_as_root(&executable, &scene.source, "one", &tools, |_| true),
            Err(Failure::WrongVersion)
        );
        assert_eq!(
            replace_as_root(
                Path::new("/usr/bin/true"),
                &scene.source,
                "1.1.0",
                &tools,
                |_| true
            ),
            Err(Failure::Replace)
        );
        assert_eq!(
            replace_as_root(
                &scene.folder.join("Absent.app/Contents/MacOS/Sample"),
                &scene.source,
                "1.1.0",
                &tools,
                |_| true
            ),
            Err(Failure::Replace)
        );
        assert_eq!(installed_text(&scene), "1.0.0");
    }

    #[test]
    fn the_root_process_refuses_a_bundle_in_a_folder_that_another_account_can_change() {
        let scene = scene("root-unprotected", IDENTIFIER);
        let tools = tools(&scene.folder, &scene.folder, true);
        let executable = scene.installed.join("Contents/MacOS/Sample");
        let mut asked = None;

        assert_eq!(
            replace_as_root(&executable, &scene.source, "1.1.0", &tools, |folder| {
                asked = Some(folder.to_path_buf());
                false
            }),
            Err(Failure::Replace)
        );

        assert_eq!(asked.as_deref(), scene.installed.parent());
        assert_eq!(installed_text(&scene), "1.0.0");
        assert!(!scene.staging.exists(), "nothing was copied");
    }

    #[test]
    fn a_folder_is_protected_only_when_root_owns_it_and_only_administrators_can_write_to_it() {
        assert!(guarded(0, 0, 0o40755));
        assert!(guarded(0, 80, 0o40775));
        assert!(guarded(0, 0, 0o40775));
        assert!(!guarded(501, 80, 0o40755), "another owner");
        assert!(
            !guarded(0, 20, 0o40775),
            "a group that is not the administrators"
        );
        assert!(!guarded(0, 0, 0o41777), "every account");
    }

    #[test]
    fn every_folder_above_a_protected_one_is_protected_too() {
        assert!(protected(Path::new("/usr/bin")));
        assert!(
            !protected(Path::new("/private/tmp")),
            "every account can write"
        );
        assert!(
            !protected(&directory("protected-own")),
            "an account other than root owns a folder of the chain"
        );
        assert!(!protected(Path::new("/absent/folder")));
    }

    #[test]
    fn the_root_process_never_installs_an_equal_or_a_lower_version() {
        let scene = scene("root-lower", IDENTIFIER);
        let tools = tools(&scene.folder, &scene.folder, true);
        let executable = scene.installed.join("Contents/MacOS/Sample");

        for version in ["1.0.0", "0.9.0"] {
            assert_eq!(
                replace_as_root(&executable, &scene.source, version, &tools, |_| true),
                Ok(())
            );
        }

        assert_eq!(installed_text(&scene), "1.0.0");
        assert!(!scene.staging.exists(), "nothing was copied");
    }

    #[test]
    fn the_root_process_refuses_an_executable_path_that_holds_a_link() {
        let scene = scene("root-link", IDENTIFIER);
        let tools = tools(&scene.folder, &scene.folder, true);
        let linked = scene.folder.join("Linked");
        std::os::unix::fs::symlink(scene.installed.parent().unwrap(), &linked).unwrap();
        let executable = linked.join("My Sample.app/Contents/MacOS/Sample");

        assert_eq!(
            replace_as_root(&executable, &scene.source, "1.1.0", &tools, |_| true),
            Err(Failure::Replace)
        );

        assert_eq!(installed_text(&scene), "1.0.0");
        assert!(!scene.staging.exists(), "nothing was copied");
    }

    #[test]
    fn a_path_is_real_only_when_no_link_is_in_it() {
        let folder = std::fs::canonicalize(directory("real-path")).unwrap();
        let linked = folder.join("linked");
        std::os::unix::fs::symlink(&folder, &linked).unwrap();

        assert!(is_real(&folder));
        assert!(!is_real(&linked));
        assert!(!is_real(&folder.join("absent")));
        assert!(!is_real(
            &folder.join("..").join(folder.file_name().unwrap())
        ));
    }

    #[test]
    fn a_missing_file_cannot_be_given_an_owner() {
        assert!(restrict(&directory("own-absent").join("absent"), Some((0, 0))).is_err());
        assert!(restrict(&directory("restrict-absent").join("absent"), None).is_err());
        assert!(
            restrict(Path::new("/usr/bin/true"), None).is_err(),
            "only the owner can change a mode"
        );
    }

    #[test]
    fn the_root_process_reports_its_result_as_an_exit_code() {
        assert_eq!(exit_code(Ok(())), 0);
        assert_eq!(exit_code(Err(Failure::Disk)), Failure::Disk.code());
        // The test executable stands in no bundle.
        assert_eq!(
            run_root(Path::new("/absent"), "1.1.0"),
            Failure::Replace.code()
        );
    }
}
