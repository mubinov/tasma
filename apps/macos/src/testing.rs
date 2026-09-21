//! Temporary paths and free ports, for the tests of every module.
//!
//! They are the subject of none of them: a record, a log and a stub are three
//! different things to write, and a directory to write them in is the same
//! need in all three.

use std::os::unix::fs::MetadataExt as _;
use std::path::PathBuf;

/// One directory for every file a test writes. It is left in place: the tests
/// run in parallel, so a removal would race another test's write, and the files
/// are a few dozen bytes under the temp directory.
const DIRECTORY: &str = "tasma-macos-tests";

/// A file under the shared directory, named for what writes it.
///
/// The directory is made rather than made-or-followed, because `temp_dir` is
/// `/tmp` wherever `TMPDIR` names nothing, and every account can write there.
/// A name already standing is read without following it, so a link planted by
/// another account ends the test rather than sending its writes through.
pub(crate) fn temp_file(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(DIRECTORY);

    if let Err(error) = std::fs::create_dir(&directory) {
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::AlreadyExists,
            "{} cannot be made: {error}",
            directory.display(),
        );

        let stats = std::fs::symlink_metadata(&directory).unwrap();
        // Safety: `getuid` reads the calling process and changes nothing.
        let ours = stats.is_dir() && stats.uid() == unsafe { libc::getuid() };

        assert!(
            ours,
            "{} holds no directory of this account's own",
            directory.display(),
        );
    }

    directory.join(name)
}

/// A directory of its own for one test, emptied first so a run before this one
/// leaves it nothing. The name is the test's, which is what keeps the tests
/// running in parallel out of each other's files.
pub(crate) fn directory(test: &str) -> PathBuf {
    let path = temp_file(&format!("directory-{test}"));

    let _ = std::fs::remove_dir_all(&path);
    // Neither call follows a link: the removal above refuses one, and this
    // fails on a name that is still there rather than writing through it.
    std::fs::create_dir(&path).unwrap();

    path
}

/// A port bound long enough to be sure nothing else holds it, then given up.
pub(crate) fn dead_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    port
}
