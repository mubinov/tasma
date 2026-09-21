//! Where the daemon of a tree listens, as its own record states it.
//!
//! The forward dials a daemon and the supervisor starts one, and both have to
//! agree on where a daemon is. That address is its own subject, kept out of
//! either of them, as `apps/cli` keeps it out of the code that starts a daemon.

use std::io::Read as _;
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

/// What the record states, or the default for every way it states nothing:
/// not JSON, not an object, or a `port` that is not a port a daemon listens on.
///
/// `pid` is ignored. It names a process to signal, and this shell signals none.
fn port_in(text: &str) -> u16 {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .as_ref()
        .and_then(|record| record.get("port"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0)
        .unwrap_or(DEFAULT_PORT)
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
fn read_record(path: &Path) -> String {
    let Ok(file) = std::fs::File::open(path) else {
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

/// The port the record under a name states.
pub(crate) fn read_port(path: &Path) -> u16 {
    port_in(&read_record(path))
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

    /// The record a test points a `Daemon` at, as a running daemon writes it.
    pub(crate) fn write_record(path: &Path, port: u16) {
        std::fs::write(path, format!(r#"{{"port":{port},"pid":1}}"#)).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::temp_file;

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
}
