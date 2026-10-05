//! Where the daemon of a tree listens, as its own record states it.
//!
//! The forward dials a daemon and the supervisor starts one, and both have to
//! agree on where a daemon is. That address is its own subject, kept out of
//! either of them, as `apps/cli` keeps it out of the code that starts a daemon.

use std::io::Read as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};

/// Where a daemon listens when its record names no port. It is the port the
/// daemon binds and the CLI dials, held to `@tasma/protocol` by a repo test.
pub(crate) const DEFAULT_PORT: u16 = 8278;

/// The tree the engine stores everything under, and the record a running daemon
/// writes into its root. Held to their TypeScript originals by the same test.
const TREE: &str = ".tasma";
const RECORD: &str = "daemon.json";

/// How much of the record is read. A record is a few dozen bytes, and the file
/// stands in a directory any process of the account can write.
const RECORD_LIMIT: u64 = 4096;

/// The port a record names and the token of the same record. A daemon of an
/// earlier version writes no token.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Address {
    pub(crate) port: u16,
    pub(crate) token: Option<String>,
}

/// What the record states, or nothing for every way it states no daemon: not
/// JSON, not an object, or a `port` that is not a port a daemon listens on.
///
/// `pid` is ignored. It names a process to signal, and this shell signals none.
fn address_in(text: &str) -> Option<Address> {
    let record = serde_json::from_str::<serde_json::Value>(text).ok()?;
    let port = record
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0)?;
    let token = record
        .get("token")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);

    Some(Address { port, token })
}

/// The record of the tree under a home directory.
pub(crate) fn record_path(home: &Path) -> PathBuf {
    home.join(TREE).join(RECORD)
}

/// The address a daemon on this machine listens at. The literal rather than a
/// name, for the reason `@tasma/protocol` states.
pub(crate) fn daemon_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// The text under the name, or an empty string where the name holds no record
/// to read: absent, unreadable, or longer than a record can be.
///
/// `O_NOFOLLOW` refuses a link out of the tree, and `O_NONBLOCK` a pipe whose
/// open would otherwise wait for a writer.
fn read_record(path: &Path) -> String {
    let Ok(file) = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    else {
        return String::new();
    };

    let mut text = String::new();
    // One byte past the ceiling, so a read that fills the buffer states a file
    // longer than a record can be whatever it holds.
    match file.take(RECORD_LIMIT + 1).read_to_string(&mut text) {
        Ok(read) if read as u64 <= RECORD_LIMIT => text,
        _ => String::new(),
    }
}

/// The address the record under a name states, or nothing where it states none.
pub(crate) fn read_address(path: &Path) -> Option<Address> {
    address_in(&read_record(path))
}

/// The port the record under a name states, or the default where it states none.
pub(crate) fn read_port(path: &Path) -> u16 {
    read_address(path).map_or(DEFAULT_PORT, |address| address.port)
}

/// Stand-ins for a record and for the port one names. Reachable across the
/// crate, because the forward and the supervisor are both driven against a
/// record a test wrote.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use crate::testing::temp_file;

    /// A record naming a port, written where a test can point a `Daemon` at it.
    ///
    /// The file is named for the test, never for the port: the kernel hands the
    /// same port number out again once a listener releases it, and the tests run
    /// in parallel, so two of them would otherwise share one file and the one
    /// that rewrites its record would have the other put the old port back.
    pub(crate) fn record_naming(test: &str, port: u16) -> PathBuf {
        let path = temp_file(&format!("daemon-{test}.json"));
        write_record(&path, port);
        path
    }

    /// The record a test points a `Daemon` at, as a daemon of an earlier version writes it.
    pub(crate) fn write_record(path: &Path, port: u16) {
        std::fs::write(path, format!(r#"{{"port":{port},"pid":1}}"#)).unwrap();
    }

    /// The same, carrying the token a daemon of this version writes.
    pub(crate) fn write_record_with_token(path: &Path, port: u16, token: &str) {
        std::fs::write(
            path,
            format!(r#"{{"port":{port},"pid":1,"token":"{token}"}}"#),
        )
        .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::temp_file;

    fn port_in(text: &str) -> u16 {
        address_in(text).map_or(DEFAULT_PORT, |address| address.port)
    }

    #[test]
    fn a_record_states_its_port() {
        assert_eq!(port_in(r#"{"port":9001,"pid":42}"#), 9001);
    }

    #[test]
    fn a_record_that_is_not_json_states_no_port() {
        assert_eq!(port_in("not json at all"), DEFAULT_PORT);
    }

    #[test]
    fn an_empty_record_states_no_port() {
        assert_eq!(port_in(""), DEFAULT_PORT);
    }

    #[test]
    fn a_record_that_is_not_an_object_states_no_port() {
        assert_eq!(port_in("[9001]"), DEFAULT_PORT);
    }

    #[test]
    fn a_record_without_a_port_states_none() {
        assert_eq!(port_in(r#"{"pid":42}"#), DEFAULT_PORT);
    }

    #[test]
    fn a_port_that_is_not_a_port_states_none() {
        assert_eq!(port_in(r#"{"port":"9001"}"#), DEFAULT_PORT);
        assert_eq!(port_in(r#"{"port":65536}"#), DEFAULT_PORT);
        assert_eq!(port_in(r#"{"port":-1}"#), DEFAULT_PORT);
        assert_eq!(port_in(r#"{"port":8278.5}"#), DEFAULT_PORT);
        // Zero is a port to bind, never a port a daemon is found on.
        assert_eq!(port_in(r#"{"port":0}"#), DEFAULT_PORT);
    }

    #[test]
    fn an_absent_record_states_no_port() {
        assert_eq!(
            read_port(Path::new("/nonexistent/.tasma/daemon.json")),
            DEFAULT_PORT
        );
    }

    #[test]
    fn a_directory_in_place_of_a_record_states_no_port() {
        assert_eq!(read_port(Path::new("/tmp")), DEFAULT_PORT);
    }

    #[test]
    fn a_record_longer_than_a_record_can_be_states_no_port() {
        let path = temp_file("longer-than-a-record.json");
        let padding = " ".repeat(RECORD_LIMIT as usize);
        std::fs::write(&path, format!(r#"{{"port":9001,"pid":42}}{padding}"#)).unwrap();

        assert_eq!(read_port(&path), DEFAULT_PORT);
    }

    #[test]
    fn a_record_stands_in_the_root_of_the_tree() {
        assert_eq!(
            record_path(Path::new("/tmp/home")),
            PathBuf::from("/tmp/home/.tasma/daemon.json"),
        );
    }

    #[test]
    fn a_daemon_is_dialled_at_the_loopback_address() {
        assert_eq!(daemon_url(9001), "http://127.0.0.1:9001");
    }

    #[test]
    fn a_record_states_its_token_beside_its_port() {
        assert_eq!(
            address_in(r#"{"port":9001,"pid":42,"token":"ab12"}"#),
            Some(Address {
                port: 9001,
                token: Some("ab12".to_string())
            }),
        );
    }

    #[test]
    fn a_record_without_a_token_still_states_its_port() {
        assert_eq!(
            address_in(r#"{"port":9001,"pid":42}"#),
            Some(Address {
                port: 9001,
                token: None
            }),
        );
        assert_eq!(
            address_in(r#"{"port":9001,"pid":42,"token":7}"#),
            Some(Address {
                port: 9001,
                token: None
            }),
        );
    }

    #[test]
    fn a_token_beside_no_port_states_nothing() {
        assert_eq!(address_in(r#"{"pid":42,"token":"ab12"}"#), None);
    }

    #[test]
    fn a_record_is_read_with_its_token() {
        let path = temp_file("a-record-with-a-token.json");
        fixtures::write_record_with_token(&path, 9001, "ab12");

        assert_eq!(
            read_address(&path),
            Some(Address {
                port: 9001,
                token: Some("ab12".to_string())
            }),
        );
    }

    #[test]
    fn a_link_in_place_of_a_record_is_not_followed() {
        let target = temp_file("a-record-a-link-points-at.json");
        fixtures::write_record_with_token(&target, 9001, "ab12");
        let link = temp_file("a-link-in-place-of-a-record.json");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert_eq!(read_address(&link), None);
    }

    #[test]
    fn a_pipe_in_place_of_a_record_is_not_waited_on() {
        let path = temp_file("a-pipe-in-place-of-a-record");
        let _ = std::fs::remove_file(&path);
        let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        // Safety: `mkfifo` reads the name and creates one file.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);

        assert_eq!(read_address(&path), None);
    }
}
