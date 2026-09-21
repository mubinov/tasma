//! Making sure a daemon is serving this tree.
//!
//! The application supervises a condition and not a process. One call carries
//! the whole rule — before a forward, and on any forward that could not
//! connect, make sure a daemon is serving — so a launch, a stand-down, a crash
//! of the child and a crash of a daemon this application never started are one
//! case and not four.
//!
//! No exit code is read to decide. The daemon exits zero both when it served
//! and when it stood down for another, so a daemon that answers ends the call
//! whichever process started it, and the code it left is written to the log and
//! read no further.
//!
//! The daemon's lifetime is not the application's: a daemon started here is put
//! in a session of its own, is never waited on and is never signalled.

use std::fs::File;
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tauri::async_runtime::Mutex;

use crate::log;
use crate::record::{DEFAULT_PORT, daemon_url, read_port, record_path};

/// The daemon's executable, as Tauri places it beside the application's own.
/// Held to `bundle.externalBin` and to the file `scripts/daemon-binary.sh`
/// writes by a repo test, because a mismatch bundles cleanly and finds no
/// daemon at runtime.
const DAEMON_EXECUTABLE: &str = "tasma-daemon";

/// The name a health answer carries. It is the one field that tells a daemon
/// from any other process holding the port, and it is held to its TypeScript
/// original by the same test.
const HEALTH_NAME: &str = "tasma-daemon";

/// How long a probe waits. A loopback port either answers at once or refuses at
/// once; the budget bounds the one case that does neither, a process that
/// accepts the connection and never replies.
const PROBE_TIMEOUT: Duration = Duration::from_secs(1);

/// How much of a health answer is read. It is two short fields, and the budget
/// alone would let whatever holds the port send for the whole of a second.
const PROBE_LIMIT: usize = 64 * 1024;

/// How long a spawn is given to produce a daemon that answers, and how often
/// the wait looks again.
const READY_BUDGET: Duration = Duration::from_secs(10);
const TICK: Duration = Duration::from_millis(100);

/// How long a daemon has to have been answering before the attempts behind it
/// count as spent. A crash loop is a failure and not a success: a daemon that
/// becomes ready and dies inside this leaves the backoff where it stands.
const PROVEN_AFTER: Duration = Duration::from_secs(10);

/// The longest wait between two spawns. There is no state that gives up: the
/// shell cannot tell the board's Retry from its interval poll, so a terminal
/// state would make Retry inert. The ceiling is what stops the thrash instead.
const BACKOFF_CEILING: Duration = Duration::from_secs(30);

/// What a version a daemon does not state is written as.
const UNSTATED: &str = "unstated";

/// How long the wait is before the spawn after this many. Zero, then one second
/// doubling to the ceiling: `0, 1, 2, 4, 8, 16, 30, 30`.
fn backoff(made: u32) -> Duration {
    let Some(doublings) = made.checked_sub(1) else {
        return Duration::ZERO;
    };

    // Saturating, so a loop long enough to shift past a `u64` still answers the
    // ceiling rather than wrapping to a short wait.
    let seconds = 1_u64.checked_shl(doublings).unwrap_or(u64::MAX);

    Duration::from_secs(seconds).min(BACKOFF_CEILING)
}

/// The daemon beside a given executable, which is where Tauri puts it. Inside
/// the bundle it stands next to the application; under `cargo run`
/// `tauri_build` copies it into the target directory with the target triple
/// stripped, so one rule resolves both layouts. A test executable stands in
/// `deps/` and resolves nothing, which costs it nothing: every test names a
/// stub of its own.
fn beside(executable: &Path) -> Option<PathBuf> {
    Some(executable.parent()?.join(DAEMON_EXECUTABLE))
}

/// A daemon answering, and the version it reports.
struct Serving {
    port: u16,
    version: String,
}

/// What the spawns so far came to.
#[derive(Default)]
struct Attempts {
    /// Spawns made since a daemon last proved itself, which decide the wait
    /// before the next one.
    made: u32,
    /// When the last spawn was made.
    last: Option<Instant>,
    /// When a daemon was first seen answering in the serving period running
    /// now.
    serving_since: Option<Instant>,
    /// The last child spawned, held so its end is collected at the next spawn.
    child: Option<Child>,
    /// A log that could not be opened, carried until an open succeeds and can
    /// record it.
    unlogged: Option<String>,
}

impl Attempts {
    /// A daemon was seen answering. A sighting that opens a serving period
    /// answers `true`, and one that continues a period long enough to count
    /// spends the attempts behind it.
    fn opens_a_period(&mut self, now: Instant, proven_after: Duration) -> bool {
        let Some(since) = self.serving_since else {
            self.serving_since = Some(now);

            return true;
        };

        self.spend(now, since, proven_after);

        false
    }

    /// No daemon answered, which ends whatever period was running.
    ///
    /// A period that ran long enough spends the attempts behind it here, and
    /// not only on a later sighting: the application calls in at startup and on
    /// a forward that could not connect, and both are moments when no daemon
    /// answers, so a daemon that served for hours and then died would otherwise
    /// leave the backoff of the crash loop before it standing.
    fn missed(&mut self, now: Instant, proven_after: Duration) {
        if let Some(since) = self.serving_since.take() {
            self.spend(now, since, proven_after);
        }
    }

    /// A serving period that has run for `proven_after` spends the attempts
    /// behind it.
    fn spend(&mut self, now: Instant, since: Instant, proven_after: Duration) {
        if now.duration_since(since) >= proven_after {
            self.made = 0;
        }
    }

    /// Whether another spawn may be made. Inside a backoff the answer is no,
    /// and the caller returns at once rather than holding the forward.
    fn due(&self, now: Instant) -> bool {
        self.last
            .is_none_or(|last| now >= last + backoff(self.made))
    }
}

/// The daemon of this tree, kept serving.
pub struct Supervisor {
    executable: Option<PathBuf>,
    record: Option<PathBuf>,
    home: Option<PathBuf>,
    budget: Duration,
    tick: Duration,
    proven_after: Duration,
    client: reqwest::Client,
    attempts: Mutex<Attempts>,
}

impl Supervisor {
    /// The supervisor of the tree under a home directory.
    ///
    /// A home directory the environment names none of leaves no record to read
    /// and no log to write; the default port still stands, so a daemon already
    /// serving is still found.
    pub fn new(home: Option<&Path>) -> Self {
        Self {
            executable: std::env::current_exe().ok().as_deref().and_then(beside),
            record: home.map(record_path),
            home: home.map(Path::to_path_buf),
            budget: READY_BUDGET,
            tick: TICK,
            proven_after: PROVEN_AFTER,
            client: probing(),
            attempts: Mutex::new(Attempts::default()),
        }
    }

    /// A supervisor that starts nothing and reaches nothing, for the tests that
    /// drive listeners of their own.
    #[cfg(test)]
    pub(crate) fn inert() -> Self {
        Self {
            executable: None,
            ..Self::new(None)
        }
    }

    /// Makes sure a daemon is serving this tree, and answers the port one is
    /// serving on.
    ///
    /// Serialised, so two forwards failing at the same moment produce one
    /// spawn. A call arriving while an attempt is in flight waits for that
    /// attempt and answers on its result, which is bounded by the readiness
    /// budget; a call after a finished attempt, inside the backoff it left,
    /// returns at once.
    pub async fn ensure_serving(&self) -> Option<u16> {
        // A daemon this application cannot name is one it cannot start.
        self.executable.as_ref()?;

        let mut attempts = self.attempts.lock().await;
        let now = Instant::now();

        if let Some(serving) = self.serving().await {
            if attempts.opens_a_period(now, self.proven_after) {
                let file = self.open_log_for(&mut attempts);
                let Serving { port, version } = &serving;

                log::note(
                    file.as_ref(),
                    &format!("stood down to the daemon on port {port}, version {version}"),
                );
            }

            return Some(serving.port);
        }

        attempts.missed(now, self.proven_after);

        if !attempts.due(now) {
            return None;
        }

        self.start(&mut attempts).await
    }

    /// The port the record states, or the default for every way it states none.
    fn port(&self) -> u16 {
        self.record.as_deref().map_or(DEFAULT_PORT, read_port)
    }

    /// The daemon answering for this tree, if one is.
    async fn serving(&self) -> Option<Serving> {
        self.probe(self.port()).await
    }

    /// What answers at a port. The one field that identifies a daemon decides,
    /// because a stale record names a port another program may hold and answer
    /// well-formed JSON on.
    async fn probe(&self, port: u16) -> Option<Serving> {
        let mut reply = self
            .client
            .get(format!("{}/health", daemon_url(port)))
            .send()
            .await
            .ok()?;

        // Read a frame at a time against the ceiling. A declared length is the
        // listener's claim, so the bytes delivered are what is counted.
        let mut bytes: Vec<u8> = Vec::new();
        while let Some(frame) = reply.chunk().await.ok()? {
            if bytes.len() + frame.len() > PROBE_LIMIT {
                return None;
            }
            bytes.extend_from_slice(&frame);
        }

        let answer: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        let data = answer.get("data")?;

        if data.get("name")?.as_str()? != HEALTH_NAME {
            return None;
        }

        Some(Serving {
            port,
            // Quoted where it enters, because everything past here writes it to
            // the log and the string is whatever holds the port, not a daemon's.
            version: log::quoted(
                data.get("version")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(UNSTATED),
            ),
        })
    }

    /// One attempt, with the moment it ended recorded.
    ///
    /// The backoff stands between two attempts, so it is measured from the end
    /// of one and not from its start: a readiness budget spent out of the wait
    /// that follows would make every wait shorter than the budget no wait at
    /// all.
    async fn start(&self, attempts: &mut Attempts) -> Option<u16> {
        let serving = self.attempt(attempts).await;
        attempts.last = Some(Instant::now());

        serving
    }

    /// Rotate, spawn, and poll until a daemon answers or the budget runs out.
    async fn attempt(&self, attempts: &mut Attempts) -> Option<u16> {
        log::rotate(self.home.as_deref());

        let file = self.open_log_for(attempts);

        // The child of the attempt before this one, collected rather than
        // waited on, so an end that came after its budget leaves nothing behind.
        if let Some(mut earlier) = attempts.child.take() {
            let _ = earlier.try_wait();
        }

        attempts.made = attempts.made.saturating_add(1);
        let made = attempts.made;

        let mut child = match self.spawn(file.as_ref()) {
            Ok(child) => child,
            Err(error) => {
                log::note(
                    file.as_ref(),
                    &format!("attempt {made} could not start {DAEMON_EXECUTABLE}: {error}"),
                );
                log::note(file.as_ref(), &self.next_attempt(made));

                return None;
            }
        };

        log::note(
            file.as_ref(),
            &format!(
                "attempt {made} spawned {DAEMON_EXECUTABLE} as process {}",
                child.id()
            ),
        );

        let started = Instant::now();
        let mut ended: Option<String> = None;

        loop {
            tokio::time::sleep(self.tick).await;

            if ended.is_none()
                && let Ok(Some(status)) = child.try_wait()
            {
                ended = Some(status.to_string());
            }

            if let Some(Serving { port, version }) = self.serving().await {
                let ms = started.elapsed().as_millis();

                log::note(
                    file.as_ref(),
                    &format!("a daemon answered on port {port} after {ms} ms, version {version}"),
                );
                // The period opened here, so the sighting that follows reads as
                // one already under way rather than as a stand-down.
                attempts.serving_since = Some(Instant::now());
                attempts.child = Some(child);

                return Some(port);
            }

            if started.elapsed() >= self.budget {
                break;
            }
        }

        if let Some(status) = ended {
            log::note(file.as_ref(), &format!("{DAEMON_EXECUTABLE} {status}"));
        }

        log::note(file.as_ref(), &self.next_attempt(made));
        attempts.child = Some(child);

        None
    }

    /// The line that says when a spawn may next be made.
    fn next_attempt(&self, made: u32) -> String {
        let seconds = backoff(made).as_secs();

        format!("attempt {made} reached no daemon, and the next is due in {seconds}s")
    }

    /// Starts the daemon, with its output on the log and its stdin closed.
    fn spawn(&self, output: Option<&File>) -> std::io::Result<Child> {
        let executable = self
            .executable
            .as_deref()
            .expect("a supervisor that names no daemon never reaches a spawn");
        let mut command = Command::new(executable);

        command.stdin(Stdio::null());

        match output {
            Some(file) => {
                command.stdout(Stdio::from(file.try_clone()?));
                command.stderr(Stdio::from(file.try_clone()?));
            }
            None => {
                command.stdout(Stdio::null());
                command.stderr(Stdio::null());
            }
        }

        // A session of its own, which is about SIGHUP and not about the
        // application quitting: a child already outlives its parent, but the
        // daemon shuts down on SIGHUP, so closing the terminal that ran the
        // application would otherwise take the daemon with it.
        //
        // The call is safe here because it touches nothing of the parent: a
        // freshly forked child is never a process group leader, so `setsid`
        // cannot fail for any reason a retry would fix.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }

                Ok(())
            });
        }

        command.spawn()
    }

    /// The log, with a fault an earlier open left recorded as its first line.
    fn open_log_for(&self, attempts: &mut Attempts) -> Option<File> {
        match log::open(self.home.as_deref()) {
            Ok(file) => {
                if let Some(fault) = attempts.unlogged.take() {
                    log::note(Some(&file), &fault);
                }

                Some(file)
            }
            Err(fault) => {
                attempts.unlogged = Some(fault);

                None
            }
        }
    }
}

/// The client a probe dials with. No TLS, no proxy, and no redirect: the daemon
/// answers none, so one proves the listener is not the daemon.
fn probing() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("a client with no TLS and no proxy is always buildable")
}

/// Stand-ins a test points a `Supervisor` at. Reachable across the crate,
/// because the forward that has a daemon started for it is driven from
/// `daemon.rs`.
#[cfg(test)]
pub(crate) mod fixtures {
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt as _;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::record::fixtures::write_record;
    use crate::testing::{dead_port, directory};

    /// How long a test gives a stub that does serve. Generous rather than
    /// tight: a wait that a daemon answers ends on the answer, so the budget
    /// costs nothing but the headroom a loaded machine running the whole suite
    /// at once needs.
    pub(crate) const TEST_BUDGET: Duration = Duration::from_secs(5);

    /// How long a test gives a stub that does not. It is the whole cost of
    /// such a test, and it still has to outlast a shell starting on a machine
    /// running the rest of the suite beside it.
    pub(crate) const TEST_GIVE_UP: Duration = Duration::from_secs(2);

    /// A health answer naming a daemon, as the daemon composes it: the envelope
    /// carries `ok` beside the data, which the probe reads nothing of.
    pub(crate) fn health() -> String {
        r#"{"ok":true,"data":{"name":"tasma-daemon","version":"9.9.9"},"diagnostics":[]}"#
            .to_string()
    }

    /// A listener answering every request for as long as the test process
    /// lives, with the reply chosen from what it read. The thread is not
    /// joined: the tests run in one process, and a listener outliving its test
    /// holds nothing but its port.
    pub(crate) fn listening(reply: impl Fn(&str) -> String + Send + 'static) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut chunk = [0_u8; 1024];

                stream
                    .set_read_timeout(Some(Duration::from_millis(250)))
                    .unwrap();

                let read = stream.read(&mut chunk).unwrap_or(0);
                let request = String::from_utf8_lossy(&chunk[..read]).into_owned();

                let _ = stream.write_all(reply(&request).as_bytes());
            }
        });

        port
    }

    /// One whole reply carrying a body.
    pub(crate) fn ok(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// A listener answering every request with the same body.
    pub(crate) fn answering(body: String) -> u16 {
        listening(move |_| ok(&body))
    }

    /// A stand-in for the daemon, written where a test can spawn it.
    pub(crate) fn stub(directory: &Path, body: &str) -> PathBuf {
        let path = directory.join(DAEMON_EXECUTABLE);

        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();

        path
    }

    /// The line a stub writes to make a listener the test already holds count
    /// as the daemon of this tree.
    pub(crate) fn records(record: &Path, port: u16) -> String {
        format!(
            "printf '{{\"port\":{port},\"pid\":1}}' > {}",
            record.display()
        )
    }

    /// A port held for the life of the test process by something that is not a
    /// daemon.
    ///
    /// It is what a record names while a test needs no daemon to be found. A
    /// port merely released is not: the kernel hands it out again, so a
    /// listener another test opens can take it and answer as the daemon this
    /// one is proving absent.
    pub(crate) fn no_daemon() -> u16 {
        answering(r#"{"data":{"name":"something-else","version":"1"}}"#.to_string())
    }

    /// A listener that is a daemon for one answer and something else after it,
    /// which is how a daemon that served and then ended reads from outside.
    pub(crate) fn a_daemon_that_ends_after_one_answer() -> u16 {
        let answered = AtomicBool::new(false);

        listening(move |_| {
            if answered.swap(true, Ordering::SeqCst) {
                ok(r#"{"data":{"name":"something-else"}}"#)
            } else {
                ok(&health())
            }
        })
    }

    /// A supervisor of a tree under a directory, driven on budgets short enough
    /// for a test.
    pub(crate) fn supervising(directory: &Path, executable: Option<PathBuf>) -> Supervisor {
        Supervisor {
            executable,
            record: Some(directory.join("daemon.json")),
            home: Some(directory.to_path_buf()),
            budget: TEST_BUDGET,
            tick: Duration::from_millis(25),
            proven_after: Duration::from_millis(200),
            ..Supervisor::new(None)
        }
    }

    /// A listener that is a daemon on `/health` and a broken one everywhere
    /// else: on any other route it declares a length it never sends, so a
    /// forward to it fails after the supervisor has reported a daemon serving.
    pub(crate) fn a_daemon_serving_nothing_else() -> u16 {
        listening(|request| {
            if request.starts_with("GET /health") {
                ok(&health())
            } else {
                "HTTP/1.1 200 OK\r\ncontent-length: 64\r\n\r\n{}".to_string()
            }
        })
    }

    /// A supervisor whose stub serves the tree: the record names a port nothing
    /// listens on until the stub rewrites it to the port given here. The record
    /// comes back with it.
    pub(crate) fn supervising_a_stub(test: &str, port: u16) -> (Supervisor, PathBuf) {
        let directory = directory(test);
        let record = directory.join("daemon.json");

        // A port nothing listens on rather than one held by a stranger: the
        // forward this fixture is for has to fail to connect, which is the one
        // fault that makes it try again.
        write_record(&record, dead_port());

        let supervisor = supervising(&directory, Some(stub(&directory, &records(&record, port))));

        (supervisor, record)
    }

    /// What the log holds, or an empty string where none was written.
    pub(crate) fn logged(supervisor: &Supervisor) -> String {
        std::fs::read_to_string(log::path(supervisor.home.as_deref().unwrap())).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;
    use crate::record::fixtures::write_record;
    use crate::testing::{dead_port, directory};

    fn block_on<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn the_wait_before_a_spawn_doubles_to_a_ceiling() {
        let waits: Vec<u64> = (0..8).map(|made| backoff(made).as_secs()).collect();

        assert_eq!(waits, [0, 1, 2, 4, 8, 16, 30, 30]);
    }

    #[test]
    fn a_loop_longer_than_a_shift_still_waits_the_ceiling() {
        assert_eq!(backoff(u32::MAX), BACKOFF_CEILING);
    }

    #[test]
    fn the_daemon_stands_beside_the_application() {
        assert_eq!(
            beside(Path::new("/opt/Tasma.app/Contents/MacOS/Tasma")),
            Some(PathBuf::from("/opt/Tasma.app/Contents/MacOS/tasma-daemon")),
        );
        // An executable with no directory above it names no daemon.
        assert_eq!(beside(Path::new("/")), None);
    }

    #[test]
    fn one_home_names_both_the_tree_and_the_log() {
        let supervisor = Supervisor::new(Some(Path::new("/tmp/home")));

        assert_eq!(
            supervisor.record.as_deref(),
            Some(Path::new("/tmp/home/.tasma/daemon.json")),
        );
        assert_eq!(
            supervisor.home.as_deref().map(log::path),
            Some(PathBuf::from("/tmp/home/Library/Logs/Tasma/daemon.log")),
        );
    }

    #[test]
    fn a_home_the_environment_names_none_of_leaves_neither() {
        let supervisor = Supervisor::new(None);

        assert_eq!(supervisor.record, None);
        assert_eq!(supervisor.home, None);
    }

    #[test]
    fn an_absent_record_leaves_the_default_port_to_probe() {
        let supervisor = supervising(&directory("absent-record"), None);

        assert_eq!(supervisor.port(), DEFAULT_PORT);
    }

    #[test]
    fn a_record_names_the_port_a_probe_dials() {
        let directory = directory("recorded-port");
        let supervisor = supervising(&directory, None);
        write_record(supervisor.record.as_deref().unwrap(), 9001);

        assert_eq!(supervisor.port(), 9001);
    }

    #[test]
    fn a_daemon_is_what_names_itself_one() {
        let supervisor = supervising(&directory("names-itself"), None);
        let port = answering(health());

        let serving = block_on(supervisor.probe(port)).expect("the listener names a daemon");

        assert_eq!(serving.port, port);
        assert_eq!(serving.version, "9.9.9");
    }

    #[test]
    fn a_daemon_that_states_no_version_is_still_a_daemon() {
        let supervisor = supervising(&directory("no-version"), None);
        let port = answering(r#"{"data":{"name":"tasma-daemon"},"diagnostics":[]}"#.to_string());

        let serving = block_on(supervisor.probe(port)).expect("the listener names a daemon");

        assert_eq!(serving.version, UNSTATED);
    }

    #[test]
    fn a_version_a_listener_states_reaches_the_log_as_one_line() {
        let supervisor = supervising(&directory("forged-version"), None);
        let port = answering(
            r#"{"data":{"name":"tasma-daemon","version":"1.0\ntasma-app: forged"}}"#.to_string(),
        );

        let serving = block_on(supervisor.probe(port)).expect("the listener names a daemon");

        assert_eq!(serving.version, r"1.0\u000atasma-app: forged");
    }

    #[test]
    fn nothing_else_holding_the_port_is_a_daemon() {
        let supervisor = supervising(&directory("not-a-daemon"), None);
        let named = |body: &str| block_on(supervisor.probe(answering(body.to_string()))).is_some();

        assert!(!named(
            r#"{"data":{"name":"something-else","version":"1"}}"#
        ));
        assert!(!named(r#"{"data":{"name":7}}"#));
        assert!(!named(r#"{"data":{"version":"1"}}"#));
        assert!(!named(r#"{"diagnostics":[]}"#));
        assert!(!named("not json at all"));
    }

    #[test]
    fn a_port_nothing_listens_on_holds_no_daemon() {
        let supervisor = supervising(&directory("dead-port"), None);

        assert!(block_on(supervisor.probe(dead_port())).is_none());
    }

    #[test]
    fn an_answer_that_breaks_part_way_out_holds_no_daemon() {
        let supervisor = supervising(&directory("broken-answer"), None);
        // A content-length the listener never sends: the headers arrive, the
        // body does not, and the read of it fails.
        let port = listening(|_| "HTTP/1.1 200 OK\r\ncontent-length: 64\r\n\r\n{}".to_string());

        assert!(block_on(supervisor.probe(port)).is_none());
    }

    #[test]
    fn an_answer_past_the_ceiling_holds_no_daemon() {
        let supervisor = supervising(&directory("past-the-ceiling"), None);
        // A health answer with padding past the ceiling, so the reply is
        // refused on its length and never on what it says.
        let padded = format!(
            r#"{{"data":{{"name":"tasma-daemon","version":"9.9.9"}},"padding":"{}"}}"#,
            "x".repeat(PROBE_LIMIT),
        );

        assert!(block_on(supervisor.probe(answering(padded))).is_none());
    }

    #[test]
    fn a_period_opens_on_the_first_sighting_and_spends_the_attempts_it_outlasts() {
        let proven_after = Duration::from_secs(10);
        let now = Instant::now();
        let mut attempts = Attempts {
            made: 3,
            ..Attempts::default()
        };

        assert!(
            attempts.opens_a_period(now, proven_after),
            "the first sighting opens a period"
        );
        assert_eq!(
            attempts.made, 3,
            "an attempt is not spent by readiness alone"
        );

        assert!(!attempts.opens_a_period(now + Duration::from_secs(9), proven_after));
        assert_eq!(attempts.made, 3);

        assert!(!attempts.opens_a_period(now + proven_after, proven_after));
        assert_eq!(attempts.made, 0);
    }

    #[test]
    fn a_daemon_that_dies_inside_the_period_leaves_the_attempts_where_they_stand() {
        let proven_after = Duration::from_secs(10);
        let now = Instant::now();
        let mut attempts = Attempts {
            made: 2,
            ..Attempts::default()
        };

        attempts.opens_a_period(now, proven_after);
        attempts.missed(now + Duration::from_secs(3), proven_after);

        assert_eq!(attempts.made, 2);
        assert!(
            attempts.opens_a_period(now + Duration::from_secs(4), proven_after),
            "the next sighting opens a period of its own",
        );
    }

    #[test]
    fn a_daemon_that_served_long_enough_spends_the_attempts_when_it_ends() {
        let proven_after = Duration::from_secs(10);
        let now = Instant::now();
        let mut attempts = Attempts {
            made: 6,
            ..Attempts::default()
        };

        attempts.opens_a_period(now, proven_after);
        attempts.missed(now + proven_after, proven_after);

        assert_eq!(attempts.made, 0);
    }

    #[test]
    fn a_spawn_waits_out_the_backoff_of_the_attempts_before_it() {
        let now = Instant::now();

        assert!(
            Attempts::default().due(now),
            "the first spawn waits for nothing"
        );

        let attempts = Attempts {
            made: 3,
            last: Some(now),
            ..Attempts::default()
        };

        assert!(!attempts.due(now + Duration::from_secs(3)));
        assert!(attempts.due(now + Duration::from_secs(4)));
    }

    #[test]
    fn a_daemon_already_serving_is_stood_down_to_and_nothing_is_spawned() {
        let directory = directory("stand-down");
        let port = answering(health());
        let runs = directory.join("runs");
        let supervisor = supervising(
            &directory,
            Some(stub(&directory, &format!("echo ran >> {}", runs.display()))),
        );
        write_record(supervisor.record.as_deref().unwrap(), port);

        assert_eq!(block_on(supervisor.ensure_serving()), Some(port));

        assert!(!runs.exists(), "a daemon that answers ends the call");
        assert!(
            logged(&supervisor).contains(&format!(
                "stood down to the daemon on port {port}, version 9.9.9"
            )),
            "{}",
            logged(&supervisor),
        );
    }

    #[test]
    fn a_stand_down_is_recorded_once_for_the_period_it_opens() {
        let directory = directory("one-stand-down");
        let port = answering(health());
        let supervisor = supervising(&directory, Some(stub(&directory, "exit 0")));
        write_record(supervisor.record.as_deref().unwrap(), port);

        block_on(supervisor.ensure_serving());
        block_on(supervisor.ensure_serving());

        assert_eq!(logged(&supervisor).matches("stood down").count(), 1);
    }

    #[test]
    fn a_daemon_that_served_and_then_ended_leaves_the_next_spawn_at_the_first_wait() {
        let directory = directory("served-then-ended");
        let supervisor = Supervisor {
            budget: TEST_GIVE_UP,
            // Nothing is proved by waiting a real period out: the rule itself
            // is held by the tests on `Attempts` above, and this one is here to
            // prove the application's own path reaches it.
            proven_after: Duration::ZERO,
            ..supervising(&directory, Some(stub(&directory, "exit 0")))
        };
        write_record(
            supervisor.record.as_deref().unwrap(),
            a_daemon_that_ends_after_one_answer(),
        );

        // The first call finds a daemon and opens the period.
        assert!(block_on(supervisor.ensure_serving()).is_some());
        // A crash loop behind it, which the period that just ended spends.
        block_on(supervisor.attempts.lock()).made = 5;

        assert_eq!(block_on(supervisor.ensure_serving()), None);

        assert_eq!(
            block_on(supervisor.attempts.lock()).made,
            1,
            "the attempt made is the first of a new loop and not the sixth of the old",
        );
    }

    #[test]
    fn a_spawned_daemon_is_waited_for_and_its_output_reaches_the_log() {
        let directory = directory("spawn");
        let port = answering(health());
        let supervisor = supervising(&directory, None);
        let record = supervisor.record.clone().unwrap();
        // The record names a dead port until the stub rewrites it, so the check
        // before the spawn cannot reach a daemon of the machine's own.
        write_record(&record, no_daemon());
        let supervisor = Supervisor {
            executable: Some(stub(
                &directory,
                &format!(
                    "echo the daemon speaks\necho the daemon complains >&2\n{}",
                    records(&record, port),
                ),
            )),
            ..supervisor
        };

        assert_eq!(block_on(supervisor.ensure_serving()), Some(port));

        let written = logged(&supervisor);

        assert!(
            written.contains(&format!(
                "{} attempt 1 spawned {DAEMON_EXECUTABLE} as process ",
                log::MARK
            )),
            "{written}"
        );
        assert!(written.contains("the daemon speaks"), "{written}");
        assert!(written.contains("the daemon complains"), "{written}");
        assert!(
            written.contains(&format!("a daemon answered on port {port} after ")),
            "{written}"
        );
        assert!(!written.contains("stood down"), "{written}");
    }

    #[test]
    fn a_spawned_daemon_is_left_in_a_session_of_its_own() {
        let directory = directory("session");
        let port = answering(health());
        let pidfile = directory.join("pid");
        let supervisor = supervising(&directory, None);
        let record = supervisor.record.clone().unwrap();
        write_record(&record, no_daemon());
        let supervisor = Supervisor {
            executable: Some(stub(
                &directory,
                &format!(
                    "printf '%s' \"$$\" > {}\n{}\nsleep 30",
                    pidfile.display(),
                    records(&record, port),
                ),
            )),
            ..supervisor
        };

        assert_eq!(block_on(supervisor.ensure_serving()), Some(port));

        let pid: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // Safety: both calls read a session id and change nothing.
        let (child, ours) = unsafe { (libc::getsid(pid), libc::getsid(0)) };

        assert!(child > 0, "the child is still running");
        assert_ne!(child, ours, "the child holds a session of its own");

        // Safety: the pid is the child this test spawned, still running.
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }

    #[test]
    fn a_child_that_exits_without_serving_is_no_daemon() {
        let directory = directory("exits-zero");
        let supervisor = Supervisor {
            budget: TEST_GIVE_UP,
            ..supervising(&directory, Some(stub(&directory, "exit 0")))
        };
        write_record(supervisor.record.as_deref().unwrap(), no_daemon());

        assert_eq!(block_on(supervisor.ensure_serving()), None);

        let written = logged(&supervisor);

        assert!(written.contains("exit status: 0"), "{written}");
        assert!(
            written.contains("attempt 1 reached no daemon, and the next is due in 1s"),
            "{written}",
        );
    }

    #[test]
    fn a_child_still_running_at_the_budget_is_no_daemon_either() {
        let directory = directory("still-running");
        let pidfile = directory.join("pid");
        let supervisor = Supervisor {
            budget: TEST_GIVE_UP,
            ..supervising(
                &directory,
                Some(stub(
                    &directory,
                    &format!("printf '%s' \"$$\" > {}\nsleep 30", pidfile.display()),
                )),
            )
        };
        write_record(supervisor.record.as_deref().unwrap(), no_daemon());

        assert_eq!(block_on(supervisor.ensure_serving()), None);

        let written = logged(&supervisor);

        assert!(
            !written.contains("exit status"),
            "a child still running left no end: {written}"
        );
        assert!(written.contains("attempt 1 reached no daemon"), "{written}");

        let pid: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // Safety: the pid is the child this test spawned, still running.
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }

    #[test]
    fn the_child_of_an_earlier_attempt_is_collected_at_the_next() {
        let directory = directory("collected");
        let supervisor = Supervisor {
            // What the child does is nothing to this test, so the budget is one
            // tick and the two attempts cost nothing.
            budget: Duration::from_millis(50),
            ..supervising(&directory, Some(stub(&directory, "exit 0")))
        };
        write_record(supervisor.record.as_deref().unwrap(), no_daemon());
        // The attempts are driven straight, because the backoff between two
        // spawns is a second the test has nothing to do with.
        let mut attempts = Attempts::default();

        block_on(supervisor.start(&mut attempts));
        let first = attempts.child.as_ref().map(Child::id);
        block_on(supervisor.start(&mut attempts));

        assert_eq!(attempts.made, 2);
        assert_ne!(attempts.child.as_ref().map(Child::id), first);
    }

    #[test]
    fn a_log_that_cannot_be_opened_never_holds_back_a_spawn() {
        let directory = directory("unwritable-log");
        let port = answering(health());
        let supervisor = supervising(&directory, None);
        let record = supervisor.record.clone().unwrap();
        let planted = log::path(supervisor.home.as_deref().unwrap());
        write_record(&record, no_daemon());
        std::fs::create_dir_all(planted.parent().unwrap()).unwrap();
        // A symbolic link, which the open refuses rather than follows.
        std::os::unix::fs::symlink(directory.join("elsewhere"), &planted).unwrap();

        let supervisor = Supervisor {
            executable: Some(stub(&directory, &records(&record, port))),
            ..supervisor
        };

        assert_eq!(block_on(supervisor.ensure_serving()), Some(port));
        assert!(
            block_on(supervisor.attempts.lock()).unlogged.is_some(),
            "the fault is carried until a log can record it",
        );
    }

    #[test]
    fn a_fault_an_earlier_open_met_is_recorded_by_the_next_one() {
        let directory = directory("carried-fault");
        let supervisor = supervising(&directory, None);
        let mut attempts = Attempts {
            unlogged: Some("the log was planted with a pipe".to_string()),
            ..Attempts::default()
        };

        let file = supervisor.open_log_for(&mut attempts);

        assert!(file.is_some());
        assert!(attempts.unlogged.is_none());
        assert!(logged(&supervisor).contains("the log was planted with a pipe"));
    }

    #[test]
    fn a_daemon_that_cannot_be_started_is_one_attempt_all_the_same() {
        let directory = directory("no-executable");
        let supervisor = supervising(&directory, Some(directory.join("absent")));
        write_record(supervisor.record.as_deref().unwrap(), no_daemon());

        assert_eq!(block_on(supervisor.ensure_serving()), None);

        let written = logged(&supervisor);

        assert!(
            written.contains(&format!("attempt 1 could not start {DAEMON_EXECUTABLE}")),
            "{written}"
        );
        assert_eq!(block_on(supervisor.attempts.lock()).made, 1);
    }

    #[test]
    fn a_call_inside_a_backoff_spawns_nothing_and_holds_nothing() {
        let directory = directory("inside-a-backoff");
        let runs = directory.join("runs");
        let supervisor = Supervisor {
            budget: TEST_GIVE_UP,
            ..supervising(
                &directory,
                Some(stub(
                    &directory,
                    &format!("echo ran >> {}\nexit 0", runs.display()),
                )),
            )
        };
        write_record(supervisor.record.as_deref().unwrap(), no_daemon());

        assert_eq!(block_on(supervisor.ensure_serving()), None);
        assert_eq!(block_on(supervisor.ensure_serving()), None);

        assert_eq!(std::fs::read_to_string(&runs).unwrap().lines().count(), 1);
    }

    #[test]
    fn two_calls_at_once_produce_one_spawn() {
        let directory = directory("at-once");
        let port = answering(health());
        let runs = directory.join("runs");
        let supervisor = supervising(&directory, None);
        let record = supervisor.record.clone().unwrap();
        write_record(&record, no_daemon());
        let supervisor = std::sync::Arc::new(Supervisor {
            executable: Some(stub(
                &directory,
                &format!("echo ran >> {}\n{}", runs.display(), records(&record, port)),
            )),
            ..supervisor
        });

        let (first, second) = block_on(async {
            let alongside = tauri::async_runtime::spawn({
                let supervisor = std::sync::Arc::clone(&supervisor);

                async move { supervisor.ensure_serving().await }
            });

            (supervisor.ensure_serving().await, alongside.await.unwrap())
        });

        assert_eq!((first, second), (Some(port), Some(port)));
        assert_eq!(std::fs::read_to_string(&runs).unwrap().lines().count(), 1);
    }

    #[test]
    fn a_supervisor_that_names_no_daemon_makes_nothing_serve() {
        assert_eq!(block_on(Supervisor::inert().ensure_serving()), None);
    }
}
