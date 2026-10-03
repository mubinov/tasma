//! `tasma-cli daemon stop`, run from a bundle: the stop that Uninstall, the
//! update and the version check share.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The CLI's own waits are ten seconds each.
pub(crate) const STOP_LIMIT: Duration = Duration::from_secs(30);
pub(crate) const STOP_TICK: Duration = Duration::from_millis(100);

/// Runs `<cli> daemon stop`, and answers whether it reported success within
/// the limit. At the limit the child is killed.
pub(crate) fn stop_daemon(cli: &Path, limit: Duration, tick: Duration) -> bool {
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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::testing::{directory, script_file};

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
}
