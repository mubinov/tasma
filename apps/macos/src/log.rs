//! The file the daemon's output and the application's own lines share.
//!
//! One file holds both, so it answers "why is there no daemon" in one read. The
//! daemon's lines carry no one marker to sit beside — a fault reads
//! `tasma-daemon: <message>` and the startup line has no colon — so nothing may
//! key on the daemon's shape, and the application marks its own lines instead.
//!
//! Both writers open in append mode and every line is short, so the writes do
//! not tear.

use std::fs::File;
use std::io::Write as _;
use std::os::fd::{AsRawFd as _, FromRawFd as _};
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

/// Where the log stands under a home directory, and the name the generation
/// before it is kept under. macOS keeps a user's logs in this tree.
const DIRECTORY: [&str; 3] = ["Library", "Logs", "Tasma"];
const FILE: &str = "daemon.log";
const ROTATED: &str = "daemon.log.1";

/// The mode the log carries, and the mode a directory the walk makes carries:
/// the account that owns it, alone.
const MODE: u32 = 0o600;
const DIRECTORY_MODE: u32 = 0o700;

/// The size at which the log is renamed and a new one started. One generation
/// is kept.
const CEILING: u64 = 5 * 1024 * 1024;

/// What marks a line as the application's own.
pub(crate) const MARK: &str = "tasma-app:";

/// The account a directory above this application's own is allowed to belong
/// to. What it can reach here it can reach anywhere under this home.
const ROOT: u32 = 0;

/// The most of a quoted string a line carries. What is quoted is a few
/// characters of version; the ceiling bounds whatever else holds the port.
const QUOTED_LIMIT: usize = 64;

/// Where the daemon's output and the application's own lines go, under a home
/// directory. One variable selects the tree and the log together, so a
/// development run cannot write into the real log.
pub(crate) fn path(home: &Path) -> PathBuf {
    let mut path = home.to_path_buf();

    for name in DIRECTORY {
        path.push(name);
    }

    path.join(FILE)
}

/// Writes one line under the application's mark. A log nothing could be opened
/// at takes the line nowhere, which is never a reason to hold back a spawn.
pub(crate) fn note(log: Option<&File>, text: &str) {
    if let Some(mut file) = log {
        let _ = writeln!(file, "{MARK} {text}");
    }
}

/// Text a line carries as data rather than as lines of its own.
///
/// What answers a probe is whatever holds the port, and every string it states
/// is that listener's. Written straight, a newline inside one forges whole
/// lines, `MARK` included, and a reader can no longer tell the application's
/// lines from a listener's. This is the class `packages/protocol` states for
/// the two binaries; the shell writes to a file of its own and carries its own.
pub(crate) fn quoted(text: &str) -> String {
    let mut safe = String::new();

    for character in text.chars().take(QUOTED_LIMIT) {
        if character == ' ' || character.is_ascii_graphic() {
            safe.push(character);

            continue;
        }

        // By code unit rather than code point, so an astral character keeps
        // both halves, as the TypeScript control does.
        for unit in character.encode_utf16(&mut [0_u16; 2]) {
            safe.push_str(&format!("\\u{unit:04x}"));
        }
    }

    safe
}

/// The log, opened under the guards the CLI opens the daemon's output file
/// with, in a directory walked to rather than named.
///
/// `O_NOFOLLOW` refuses a symbolic link planted at the name, `O_NONBLOCK`
/// refuses a pipe rather than waiting for a reader that never comes, and the
/// link count refuses a file that is also another name somewhere else.
pub(crate) fn open(home: Option<&Path>) -> Result<File, String> {
    let home = home.ok_or_else(|| "no home directory names a log to write".to_string())?;
    let directory = walk(home, Make::Directories)?;
    let name = component(FILE);
    let flags = libc::O_WRONLY
        | libc::O_APPEND
        | libc::O_CREAT
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | libc::O_CLOEXEC;

    // Safety: the descriptor is open, the name lives across the call, and the
    // descriptor the call answers is owned from here.
    let opened = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags,
            MODE as libc::c_uint,
        )
    };

    if opened < 0 {
        return Err(format!(
            "{} cannot be opened: {}",
            path(home).display(),
            std::io::Error::last_os_error(),
        ));
    }

    // Safety: the descriptor was just opened and is owned by nothing else.
    let file = unsafe { File::from_raw_fd(opened) };
    let regular = file
        .metadata()
        .is_ok_and(|stats| stats.is_file() && stats.nlink() == 1);

    if !regular {
        return Err(format!(
            "{} holds no log of this application's own",
            path(home).display()
        ));
    }

    // The umask narrows the mode an open declares, and a file created read-only
    // would refuse every later append.
    let _ = file.set_permissions(std::fs::Permissions::from_mode(MODE));

    Ok(file)
}

/// Whether a walk makes the directories it does not find.
enum Make {
    Directories,
    Nothing,
}

/// The directory the log stands in, opened one component at a time from the
/// home directory and held open.
///
/// Every component under the home is writable by any process of the account,
/// which is the threat here. A whole path is resolved again by each call that
/// names it, so a component swapped for a link between a check and the open
/// after it is followed, and the guards on the file itself read its last
/// component alone — the daemon's whole output would land outside the home tree
/// while `O_NOFOLLOW`, the link count and the kind all still reported the log as
/// the application's own. A descriptor per component, each opened with
/// `O_NOFOLLOW` and tested through itself, leaves nothing to re-resolve.
fn walk(home: &Path, make: Make) -> Result<File, String> {
    let mut walked = home.to_path_buf();
    let mut current = anchor(home)?;

    for name in DIRECTORY {
        walked.push(name);
        current = step(&current, name, &make, &walked)?;
    }

    Ok(current)
}

/// The home directory, which the walk starts from. It is resolved as a whole,
/// links included: it is the tree the application was pointed at, and what
/// stands above it is not this account's to guard.
fn anchor(home: &Path) -> Result<File, String> {
    let name = std::ffi::CString::new(home.as_os_str().as_bytes())
        .map_err(|_| format!("{} names no directory", home.display()))?;

    // Safety: the name lives across the call, and the descriptor the call
    // answers is owned from here.
    let opened = unsafe { libc::open(name.as_ptr(), libc::O_DIRECTORY | libc::O_CLOEXEC) };

    if opened < 0 {
        return Err(format!(
            "{} cannot be read: {}",
            home.display(),
            std::io::Error::last_os_error(),
        ));
    }

    // Safety: the descriptor was just opened and is owned by nothing else.
    Ok(unsafe { File::from_raw_fd(opened) })
}

/// One component below the one held open, made where it is absent and refused
/// unless it is a real directory of this account's.
fn step(current: &File, name: &str, make: &Make, walked: &Path) -> Result<File, String> {
    let component = component(name);

    if matches!(make, Make::Directories) {
        // A name already there is what the open below judges, so the result of
        // the call says nothing this needs.
        //
        // Safety: the descriptor is open and the name lives across the call.
        unsafe {
            libc::mkdirat(
                current.as_raw_fd(),
                component.as_ptr(),
                DIRECTORY_MODE as libc::mode_t,
            )
        };
    }

    // Safety: as above, and the descriptor the call answers is owned from here.
    let opened = unsafe {
        libc::openat(
            current.as_raw_fd(),
            component.as_ptr(),
            libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };

    if opened < 0 {
        return Err(format!(
            "{} holds no directory of this account's own: {}",
            walked.display(),
            std::io::Error::last_os_error(),
        ));
    }

    // Safety: the descriptor was just opened and is owned by nothing else.
    let directory = unsafe { File::from_raw_fd(opened) };

    if !ours(&directory) {
        return Err(format!(
            "{} holds no directory of this account's own",
            walked.display()
        ));
    }

    Ok(directory)
}

/// Whether what a descriptor holds belongs to this account. `O_DIRECTORY` has
/// already refused everything that is not a directory.
fn ours(directory: &File) -> bool {
    directory.metadata().is_ok_and(|stats| {
        // Safety: `getuid` reads the calling process and changes nothing.
        stats.uid() == unsafe { libc::getuid() } || stats.uid() == ROOT
    })
}

/// One name of the walk, as the calls below take it. The names are this
/// module's own constants, none of which holds a zero byte.
fn component(name: &str) -> std::ffi::CString {
    std::ffi::CString::new(name).expect("a name of this module's own holds no zero byte")
}

/// Renames a log at or over the ceiling, replacing the one generation kept.
/// Anything that is not a regular file of ours is left alone, and a directory
/// absent above it is left absent: a tree with no log in it has none to rotate.
///
/// A live daemon holds the log open, so this stands at a spawn and nowhere
/// else: it is the one point where no daemon of ours is writing to it.
pub(crate) fn rotate(home: Option<&Path>) {
    let Some(home) = home else {
        return;
    };
    let Ok(directory) = walk(home, Make::Nothing) else {
        return;
    };
    let name = component(FILE);
    let rotated = component(ROTATED);

    if !over_the_ceiling(&directory, &name) {
        return;
    }

    // Safety: the descriptor is open and both names live across the call.
    unsafe {
        libc::renameat(
            directory.as_raw_fd(),
            name.as_ptr(),
            directory.as_raw_fd(),
            rotated.as_ptr(),
        )
    };
}

/// Whether the name in a directory holds a regular file at or over the ceiling.
/// The name is read without following it, so a link planted at it is left where
/// it stands.
fn over_the_ceiling(directory: &File, name: &std::ffi::CStr) -> bool {
    let mut stats = std::mem::MaybeUninit::<libc::stat>::uninit();

    // Safety: the descriptor is open, the name lives across the call, and the
    // buffer is this frame's to fill.
    let read = unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            stats.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };

    if read != 0 {
        return false;
    }

    // Safety: the call above answered success, so the buffer is filled.
    let stats = unsafe { stats.assume_init() };

    stats.st_mode & libc::S_IFMT == libc::S_IFREG && stats.st_size as u64 >= CEILING
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::directory;

    /// A home with the log's directory already standing under it, which is what
    /// a tree the application has served once looks like.
    fn home_with_a_log_directory(test: &str) -> PathBuf {
        let home = directory(test);

        std::fs::create_dir_all(path(&home).parent().unwrap()).unwrap();

        home
    }

    #[test]
    fn the_log_stands_under_the_home_the_tree_does() {
        assert_eq!(
            path(Path::new("/tmp/home")),
            PathBuf::from("/tmp/home/Library/Logs/Tasma/daemon.log"),
        );
    }

    #[test]
    fn a_line_a_listener_states_carries_no_lines_of_its_own() {
        let forged = quoted("1.0\ntasma-app: a daemon answered on port 1");

        assert!(!forged.contains('\n'), "{forged}");
        assert!(forged.starts_with(r"1.0\u000a"), "{forged}");
    }

    #[test]
    fn a_line_a_listener_states_is_cut_to_the_ceiling() {
        assert_eq!(quoted(&"9".repeat(QUOTED_LIMIT + 10)).len(), QUOTED_LIMIT);
    }

    #[test]
    fn a_character_outside_printable_ascii_is_written_as_its_escape() {
        // Both halves of an astral character, and an escape a terminal acts on.
        assert_eq!(quoted("\u{1f600}\u{1b}"), "\\ud83d\\ude00\\u001b");
    }

    #[test]
    fn a_log_at_the_ceiling_becomes_the_generation_before_it() {
        let home = home_with_a_log_directory("rotation");
        let log = path(&home);
        let rotated = log.with_file_name(ROTATED);

        std::fs::write(&rotated, "the generation before").unwrap();
        std::fs::write(&log, vec![b'x'; CEILING as usize]).unwrap();

        rotate(Some(&home));

        assert!(!log.exists());
        assert_eq!(std::fs::metadata(&rotated).unwrap().len(), CEILING);
    }

    #[test]
    fn a_log_under_the_ceiling_is_left_alone() {
        let home = home_with_a_log_directory("no-rotation");
        let log = path(&home);

        std::fs::write(&log, vec![b'x'; CEILING as usize - 1]).unwrap();

        rotate(Some(&home));

        assert_eq!(std::fs::metadata(&log).unwrap().len(), CEILING - 1);
        assert!(!log.with_file_name(ROTATED).exists());
    }

    #[test]
    fn a_tree_that_holds_no_log_yet_has_none_to_rotate() {
        let absent = directory("nothing-to-rotate");
        let empty = home_with_a_log_directory("no-log-yet");

        rotate(Some(&absent));
        rotate(Some(&empty));

        assert!(!absent.join(DIRECTORY[0]).exists());
        assert!(!path(&empty).with_file_name(ROTATED).exists());
    }

    #[test]
    fn a_log_that_is_not_a_file_of_ours_is_neither_rotated_nor_written() {
        let home = home_with_a_log_directory("planted");
        let log = path(&home);
        let elsewhere = home.join("elsewhere");

        std::fs::write(&elsewhere, vec![b'x'; CEILING as usize]).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &log).unwrap();

        rotate(Some(&home));

        assert!(
            !log.with_file_name(ROTATED).exists(),
            "a symlink is not rotated"
        );
        assert!(open(Some(&home)).is_err(), "a symlink is not written to");
    }

    #[test]
    fn a_log_that_is_a_second_name_for_a_file_is_refused() {
        let home = home_with_a_log_directory("hard-linked");
        let elsewhere = home.join("elsewhere");

        std::fs::write(&elsewhere, "someone else's file").unwrap();
        std::fs::hard_link(&elsewhere, path(&home)).unwrap();

        let refused = open(Some(&home)).unwrap_err();

        assert!(
            refused.ends_with("holds no log of this application's own"),
            "{refused}"
        );
    }

    #[test]
    fn a_log_in_a_planted_directory_is_refused() {
        let home = directory("planted-directory");
        let elsewhere = home.join("elsewhere");

        std::fs::create_dir_all(home.join(DIRECTORY[0]).join(DIRECTORY[1])).unwrap();
        std::fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, path(&home).parent().unwrap()).unwrap();

        assert!(open(Some(&home)).is_err());
        assert!(
            !elsewhere.join(FILE).exists(),
            "the output went nowhere through the link"
        );
    }

    #[test]
    fn a_log_under_a_planted_directory_above_it_is_refused() {
        let home = directory("planted-above");
        let elsewhere = home.join("elsewhere");

        std::fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, home.join(DIRECTORY[0])).unwrap();

        assert!(open(Some(&home)).is_err());
        assert!(
            !elsewhere.join(DIRECTORY[1]).exists(),
            "the walk made nothing through the link"
        );
    }

    #[test]
    fn a_home_no_directory_stands_at_names_no_log() {
        // A character device, which nothing can be made or opened under.
        assert!(open(Some(Path::new("/dev/null"))).is_err());
    }

    #[test]
    fn a_home_that_is_no_name_at_all_names_no_log() {
        use std::os::unix::ffi::OsStrExt as _;

        let zeroed = PathBuf::from(std::ffi::OsStr::from_bytes(b"/tmp/\0home"));

        assert!(open(Some(&zeroed)).is_err());
    }

    #[test]
    fn a_home_that_names_no_log_leaves_the_lines_nowhere() {
        assert!(open(None).is_err());
        rotate(None);
    }

    #[test]
    fn a_log_carries_the_mode_the_tree_carries() {
        let home = directory("log-mode");

        open(Some(&home)).unwrap();

        let log = std::fs::metadata(path(&home)).unwrap();
        let made = std::fs::metadata(path(&home).parent().unwrap()).unwrap();

        assert_eq!(log.permissions().mode() & 0o777, MODE);
        assert_eq!(made.permissions().mode() & 0o777, DIRECTORY_MODE);
    }

    #[test]
    fn a_line_written_carries_the_application_s_mark() {
        let home = directory("marked");

        note(open(Some(&home)).ok().as_ref(), "a daemon answered");
        note(None, "and this one goes nowhere");

        assert_eq!(
            std::fs::read_to_string(path(&home)).unwrap(),
            format!("{MARK} a daemon answered\n"),
        );
    }
}
