//! The forward to the daemon.
//!
//! The shell reads a port and writes nothing. Every write goes to the daemon,
//! and the tree written is the one the daemon's own `HOME` resolved.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use tauri::http::header::{
    ALLOW, CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, HeaderName, X_CONTENT_TYPE_OPTIONS,
};
use tauri::http::{HeaderValue, Method, Request, Response, StatusCode};

use crate::record::{DEFAULT_PORT, daemon_url, read_port, record_path};
use crate::supervisor::Supervisor;

/// How long a forward waits. The daemon is a local process and answers at once;
/// a listener that accepts and never answers would otherwise hold the call for
/// as long as the window is open.
const TIMEOUT: Duration = Duration::from_secs(30);

/// How much of a reply is read. The daemon reads at most 8 MiB of request but
/// composes its answer from what the tree holds, so this stands well above any
/// answer of its own. What it bounds is a listener that is not the daemon: one
/// holding the recorded port can answer for as long as the window takes bytes.
const REPLY_LIMIT: usize = 64 * 1024 * 1024;

/// The reply headers relayed as the daemon wrote them. The daemon sets
/// `cache-control` on every answer and `allow` on a refused method, and the
/// browser board reads both through the Vite proxy. The framing headers are not
/// relayed: the answer is framed again on the way out, so a length copied from
/// the daemon would contradict the bytes.
///
/// A relayed value has to be visible ASCII. wry's macOS scheme handler turns
/// `content-type` into an `NSString` with an unguarded `unwrap`, and a header
/// value may legally hold `obs-text`, so a byte outside that range would panic
/// the handler inside the task that answers — leaving the call unanswered and
/// the window waiting, with neither the reply nor the failure screen.
const RELAYED: [HeaderName; 3] = [CONTENT_TYPE, CACHE_CONTROL, ALLOW];

/// The policy a forwarded reply carries, whatever the listener sent. The reply
/// lands on the window's own origin, and the document's policy is a meta element
/// inside `index.html` that no forwarded reply carries: without this a listener
/// answering `text/html` would render as a document of this application under no
/// policy at all.
const FORWARDED_POLICY: &str = "default-src 'none'; sandbox";

/// The request the forward sends, built rather than copied.
///
/// WKWebView hands the handler `referer`, `accept`, `user-agent` and
/// `content-type`, and no `Origin` and no Fetch Metadata header at all, on a
/// read or on a write. The daemon's two guards read what a request claims about
/// its origin, and building the request is what keeps every such claim off the
/// forward: `referer`, which the document that sends the request decides, and
/// any Fetch Metadata header WebKit may later add. Dialling the loopback address
/// sets the `Host` the daemon serves; sending no `Sec-Fetch-Site` puts the
/// request in the arm it accepts.
#[derive(Debug, PartialEq, Eq)]
struct Forward {
    url: String,
    method: Method,
    media_type: Option<HeaderValue>,
    body: Vec<u8>,
}

/// The outgoing request for one incoming one: the method, the path, the media
/// type and the body, and nothing else the incoming request carried.
fn forward_of(port: u16, target: &str, request: &Request<Vec<u8>>) -> Forward {
    Forward {
        url: format!("{}{target}", daemon_url(port)),
        method: request.method().clone(),
        media_type: request.headers().get(CONTENT_TYPE).cloned(),
        body: request.body().clone(),
    }
}

/// What the origin answers when no daemon can be reached, with the fault named
/// on stderr.
///
/// The request cannot be failed: wry resolves every custom-scheme request with
/// a response and its macOS handler has no failure path, so `fetch` cannot be
/// made to reject. This is byte for byte what the Vite proxy answers for the
/// same condition, so the window and the browser board show one screen. That one
/// screen is what the line is for: a stale recorded port and a listener that is
/// not the daemon are the same screen, and a run from a terminal is where they
/// can be told apart.
fn bad_gateway(port: u16, fault: &str) -> Response<Vec<u8>> {
    eprintln!("tasma: no answer from the daemon on port {port}: {fault}");

    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .header(CONTENT_TYPE, "text/plain")
        .body(Vec::new())
        .expect("a status and one header are a response")
}

/// A failed forward in one phrase, with the error that carries the detail.
fn fault_of(error: &reqwest::Error) -> String {
    let kind = if error.is_connect() {
        "nothing is listening"
    } else if error.is_timeout() {
        "nothing answered within the wait"
    } else {
        "the reply broke part way out"
    };

    format!("{kind} ({error})")
}

/// The daemon this window reads and writes through.
pub struct Daemon {
    record: Option<PathBuf>,
    port: AtomicU16,
    client: reqwest::Client,
    reply_limit: usize,
    supervisor: Supervisor,
}

impl Daemon {
    /// The daemon of the tree under the current home directory, kept serving by
    /// a supervisor over the same tree.
    ///
    /// A home directory the environment names none of leaves no record to read,
    /// and the default port stands.
    pub fn new() -> Self {
        let home = std::env::home_dir();

        Self::with_supervisor(
            home.as_deref().map(record_path),
            Supervisor::new(home.as_deref()),
            TIMEOUT,
            REPLY_LIMIT,
        )
    }

    /// The same, with the supervisor, the wait and the ceiling all named.
    fn with_supervisor(
        record: Option<PathBuf>,
        supervisor: Supervisor,
        timeout: Duration,
        reply_limit: usize,
    ) -> Self {
        let port = record.as_deref().map_or(DEFAULT_PORT, read_port);

        Self {
            record,
            port: AtomicU16::new(port),
            reply_limit,
            supervisor,
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(timeout)
                // The daemon answers no redirect, so one proves the listener is
                // not the daemon. Followed, it would replay the body to whatever
                // host the reply names and return that answer inside this origin.
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("a client with no TLS and no proxy is always buildable"),
        }
    }

    /// The daemon of the tree a given record names, supervised by nothing. For
    /// the tests, which drive listeners of their own and start no process.
    #[cfg(test)]
    fn at(record: Option<PathBuf>) -> Self {
        Self::limited(record, TIMEOUT, REPLY_LIMIT)
    }

    /// The same, with the wait and the ceiling a forward holds the listener it
    /// dials to.
    #[cfg(test)]
    fn limited(record: Option<PathBuf>, timeout: Duration, reply_limit: usize) -> Self {
        Self::with_supervisor(record, Supervisor::inert(), timeout, reply_limit)
    }

    /// The port last read from the record.
    fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    /// Reads the record again and keeps what it states. A daemon restarted on
    /// another port is picked up without restarting the app.
    fn reread(&self) -> u16 {
        let port = self.record.as_deref().map_or(DEFAULT_PORT, read_port);
        self.port.store(port, Ordering::Relaxed);
        port
    }

    /// Makes sure a daemon is serving this tree, and keeps the port one answers
    /// on. Called once at startup, so the daemon is warm before the board's
    /// first request, and again by a forward that could not connect.
    pub async fn ensure_serving(&self) -> Option<u16> {
        let port = self.supervisor.ensure_serving().await?;
        self.port.store(port, Ordering::Relaxed);

        Some(port)
    }

    /// Stops supervising. From then on no daemon is started for this window.
    pub async fn retire(&self) {
        self.supervisor.retire().await;
    }

    /// The daemon's answer to one request: its status, the headers it set and
    /// its bytes, untouched. The daemon's body is authoritative and its status
    /// advisory, so neither is read here.
    pub async fn forward(&self, target: &str, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let mut port = self.port();
        // Only a failure to connect is retried: it is the one fault that proves
        // the request never reached the daemon, so replaying a write cannot
        // carry it out twice.
        let mut error = match self.send(port, target, request).await {
            Ok(reply) => return reply,
            Err(error) => error,
        };

        // The record first, which names a daemon restarted on another port.
        if error.is_connect() {
            port = self.reread();
            error = match self.send(port, target, request).await {
                Ok(reply) => return reply,
                Err(error) => error,
            };
        }

        // Then the supervisor, which starts one where none is serving at all,
        // so a cold start recovers the request in flight rather than showing
        // the failure screen and waiting for Retry.
        if error.is_connect()
            && let Some(serving) = self.ensure_serving().await
        {
            port = serving;
            error = match self.send(port, target, request).await {
                Ok(reply) => return reply,
                Err(error) => error,
            };
        }

        bad_gateway(port, &fault_of(&error))
    }

    async fn send(
        &self,
        port: u16,
        target: &str,
        request: &Request<Vec<u8>>,
    ) -> reqwest::Result<Response<Vec<u8>>> {
        let forward = forward_of(port, target, request);
        let mut outgoing = self.client.request(forward.method, forward.url);

        if let Some(media_type) = forward.media_type {
            outgoing = outgoing.header(CONTENT_TYPE, media_type);
        }

        let mut reply = outgoing.body(forward.body).send().await?;
        let status = reply.status();
        let relayed: Vec<(HeaderName, HeaderValue)> = RELAYED
            .into_iter()
            .filter_map(|name| {
                reply
                    .headers()
                    .get(&name)
                    .filter(|value| value.to_str().is_ok())
                    .map(|value| (name, value.clone()))
            })
            .collect();

        // Read a frame at a time against the ceiling. A declared length is the
        // listener's claim, so the bytes delivered are what is counted.
        let mut bytes: Vec<u8> = Vec::new();
        while let Some(frame) = reply.chunk().await? {
            if bytes.len() + frame.len() > self.reply_limit {
                return Ok(bad_gateway(port, "the reply is past the ceiling"));
            }
            bytes.extend_from_slice(&frame);
        }

        let mut answer = Response::builder()
            .status(status)
            .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header(CONTENT_SECURITY_POLICY, FORWARDED_POLICY);
        for (name, value) in relayed {
            answer = answer.header(name, value);
        }

        Ok(answer
            .body(bytes)
            .expect("a status and the daemon's own headers are a response"))
    }
}

/// Stand-ins a test points a `Daemon` at. Reachable across the crate, because
/// the protocol tests drive a daemon nothing answers for.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use crate::record::fixtures::record_naming;
    use crate::testing::dead_port;

    /// A daemon whose record names a port nothing listens on.
    pub(crate) fn daemon_on_a_dead_port(test: &str) -> Daemon {
        Daemon::at(Some(record_naming(test, dead_port())))
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read as _;

    use super::fixtures::*;
    use super::*;
    use crate::record::fixtures::{record_naming, write_record};
    use crate::supervisor::fixtures::{
        a_daemon_serving_nothing_else, answering, health, supervising_a_stub,
    };
    use crate::testing::dead_port;

    #[test]
    fn a_forward_carries_the_method_the_path_the_media_type_and_the_body() {
        let request = Request::builder()
            .method(Method::POST)
            .uri("tasma-app://localhost/daemon/projects/AAA/tasks")
            .header(CONTENT_TYPE, "application/json")
            .header("origin", "tasma-app://localhost")
            .header("referer", "tasma-app://localhost/index.html")
            .header("sec-fetch-site", "same-origin")
            .header("sec-fetch-mode", "cors")
            .header("accept", "*/*")
            .body(br#"{"title":"one"}"#.to_vec())
            .unwrap();

        assert_eq!(
            forward_of(9001, "/projects/AAA/tasks", &request),
            Forward {
                url: "http://127.0.0.1:9001/projects/AAA/tasks".to_string(),
                method: Method::POST,
                media_type: Some(HeaderValue::from_static("application/json")),
                body: br#"{"title":"one"}"#.to_vec(),
            },
        );
    }

    #[test]
    fn a_read_forwards_without_a_media_type() {
        let request = Request::builder()
            .method(Method::GET)
            .uri("tasma-app://localhost/daemon/projects")
            .header("sec-fetch-site", "same-origin")
            .body(Vec::new())
            .unwrap();

        let forward = forward_of(DEFAULT_PORT, "/projects", &request);

        assert_eq!(forward.media_type, None);
        assert_eq!(forward.url, "http://127.0.0.1:8278/projects");
        assert!(forward.body.is_empty());
    }

    #[test]
    fn no_daemon_answers_an_empty_bad_gateway() {
        let answer = bad_gateway(DEFAULT_PORT, "nothing is listening");

        assert_eq!(answer.status(), StatusCode::BAD_GATEWAY);
        assert!(answer.body().is_empty());
    }

    // Driven against a real listener: the bytes reqwest puts on the wire are
    // what the whitelist is about.

    use std::io::Write as _;
    use std::net::TcpListener;
    use std::sync::mpsc::{Sender, channel};

    /// A listener that answers one request and hands back what it read.
    fn listen(reply: &'static str) -> (u16, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (sender, receiver): (Sender<String>, _) = channel();

        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(250)))
                .unwrap();

            // Read until the peer stops sending. A request this small arrives in
            // one or two segments, so the timeout is what ends the read.
            let mut seen = Vec::new();
            let mut chunk = [0u8; 4096];
            while let Ok(read) = stream.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                seen.extend_from_slice(&chunk[..read]);
            }

            sender
                .send(String::from_utf8_lossy(&seen).into_owned())
                .unwrap();
            stream.write_all(reply.as_bytes()).unwrap();
        });

        (port, receiver)
    }

    fn write(target: &str) -> Request<Vec<u8>> {
        Request::builder()
            .method(Method::POST)
            .uri(format!("tasma-app://localhost/daemon{target}"))
            .header(CONTENT_TYPE, "application/json")
            .header("origin", "tasma-app://localhost")
            .header("referer", "tasma-app://localhost/index.html")
            .header("sec-fetch-site", "same-origin")
            .header("sec-fetch-mode", "cors")
            .body(br#"{"title":"one"}"#.to_vec())
            .unwrap()
    }

    #[test]
    fn a_write_reaches_the_daemon_with_its_body_and_nothing_it_claims_about_its_origin() {
        let (port, seen) = listen(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{\"ok\":true}",
        );
        let daemon = Daemon::at(Some(record_naming("a-write", port)));

        let answer = tauri::async_runtime::block_on(
            daemon.forward("/projects/AAA/tasks", &write("/projects/AAA/tasks")),
        );
        let request = seen.recv_timeout(Duration::from_secs(5)).unwrap();
        let lines = request.to_lowercase();

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(
            answer.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert_eq!(answer.body(), br#"{"ok":true}"#);

        assert!(
            request.starts_with("POST /projects/AAA/tasks HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(request.ends_with(r#"{"title":"one"}"#), "{request}");
        assert!(
            lines.contains("content-type: application/json"),
            "{request}"
        );
        assert!(
            lines.contains(&format!("host: 127.0.0.1:{port}")),
            "{request}"
        );
        assert!(!lines.contains("origin:"), "{request}");
        assert!(!lines.contains("referer:"), "{request}");
        assert!(!lines.contains("sec-fetch"), "{request}");
    }

    #[test]
    fn the_headers_the_daemon_sets_reach_the_board() {
        let (port, _seen) = listen(
            "HTTP/1.1 405 Method Not Allowed\r\ncontent-type: application/json\r\ncache-control: no-store\r\nx-content-type-options: nosniff\r\nallow: GET, POST\r\ncontent-length: 2\r\n\r\n{}",
        );
        let daemon = Daemon::at(Some(record_naming("relayed-headers", port)));

        let answer =
            tauri::async_runtime::block_on(daemon.forward("/projects", &write("/projects")));
        let headers = answer.headers();

        assert_eq!(answer.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(headers.get(CACHE_CONTROL).unwrap(), "no-store");
        assert_eq!(headers.get(ALLOW).unwrap(), "GET, POST");
        // Framed again on the way out, so the daemon's own length is not copied.
        assert_eq!(headers.get("content-length"), None);
    }

    #[test]
    fn a_reply_header_outside_visible_ascii_is_not_relayed() {
        // `\u{ff}` reaches the wire as two obs-text bytes, which is what a
        // header value may legally hold and `to_str` rejects.
        let (port, _seen) = listen(
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\u{ff}\r\ncache-control: no-store\r\ncontent-length: 2\r\n\r\n{}",
        );
        let daemon = Daemon::at(Some(record_naming("obs-text-header", port)));

        let answer =
            tauri::async_runtime::block_on(daemon.forward("/projects", &write("/projects")));

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(answer.headers().get(CONTENT_TYPE), None);
        assert_eq!(answer.headers().get(CACHE_CONTROL).unwrap(), "no-store");
        assert_eq!(answer.body(), b"{}");
    }

    #[test]
    fn a_forwarded_reply_is_inert_whatever_the_listener_sent() {
        // Neither header set, and a media type a webview would render.
        let (port, _seen) = listen(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 14\r\n\r\n<p>a page</p>\n",
        );
        let daemon = Daemon::at(Some(record_naming("inert-reply", port)));

        let answer =
            tauri::async_runtime::block_on(daemon.forward("/projects", &write("/projects")));
        let headers = answer.headers();

        assert_eq!(headers.get(X_CONTENT_TYPE_OPTIONS).unwrap(), "nosniff");
        assert_eq!(
            headers.get(CONTENT_SECURITY_POLICY).unwrap(),
            FORWARDED_POLICY
        );
        // One value each, so a listener setting them cannot append a second.
        assert_eq!(headers.get_all(X_CONTENT_TYPE_OPTIONS).iter().count(), 1);
        assert_eq!(headers.get_all(CONTENT_SECURITY_POLICY).iter().count(), 1);
    }

    #[test]
    fn a_listener_setting_them_itself_does_not_double_them() {
        let (port, _seen) = listen(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-content-type-options: nosniff\r\ncontent-security-policy: default-src *\r\ncontent-length: 2\r\n\r\n{}",
        );
        let daemon = Daemon::at(Some(record_naming("not-doubled", port)));

        let answer =
            tauri::async_runtime::block_on(daemon.forward("/projects", &write("/projects")));
        let headers = answer.headers();

        assert_eq!(headers.get_all(X_CONTENT_TYPE_OPTIONS).iter().count(), 1);
        assert_eq!(
            headers.get(CONTENT_SECURITY_POLICY).unwrap(),
            FORWARDED_POLICY
        );
    }

    #[test]
    fn a_listener_that_answers_a_redirect_is_not_followed() {
        let (port, _seen) = listen(
            "HTTP/1.1 307 Temporary Redirect\r\nlocation: http://example.invalid/\r\ncontent-length: 0\r\n\r\n",
        );
        let daemon = Daemon::at(Some(record_naming("a-redirect", port)));

        let answer =
            tauri::async_runtime::block_on(daemon.forward("/projects", &write("/projects")));

        assert_eq!(answer.status(), StatusCode::TEMPORARY_REDIRECT);
        assert!(answer.body().is_empty());
    }

    #[test]
    fn a_listener_that_never_answers_is_a_bad_gateway() {
        // Accepted and left open: without a wait the call would never end.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let held = std::thread::spawn(move || listener.accept().unwrap());

        let daemon = Daemon::limited(
            Some(record_naming("no-answer", port)),
            Duration::from_millis(250),
            REPLY_LIMIT,
        );
        let answer =
            tauri::async_runtime::block_on(daemon.forward("/projects", &write("/projects")));

        assert_eq!(answer.status(), StatusCode::BAD_GATEWAY);
        drop(held.join().unwrap());
    }

    #[test]
    fn a_daemon_on_another_port_is_picked_up_without_a_restart() {
        // A record naming a port nothing listens on, so the first call cannot
        // connect and the record is read again.
        let gone = dead_port();
        let record = record_naming("another-port", gone);
        let daemon = Daemon::at(Some(record.clone()));
        assert_eq!(daemon.port(), gone);

        let (port, seen) = listen("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}");
        write_record(&record, port);

        let answer = tauri::async_runtime::block_on(daemon.forward("/health", &write("/health")));

        assert_eq!(answer.status(), StatusCode::OK);
        assert!(
            seen.recv_timeout(Duration::from_secs(5))
                .unwrap()
                .starts_with("POST /health ")
        );
        assert_eq!(daemon.port(), port);
    }

    #[test]
    fn a_forward_that_reaches_no_daemon_has_one_started_and_is_sent_again() {
        let port = answering(health());
        let (supervisor, record) = supervising_a_stub("a-cold-start", port);
        let daemon = Daemon::with_supervisor(Some(record), supervisor, TIMEOUT, REPLY_LIMIT);

        let answer = tauri::async_runtime::block_on(daemon.forward("/health", &write("/health")));

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(daemon.port(), port);
    }

    #[test]
    fn a_daemon_that_was_started_and_still_cannot_answer_is_a_bad_gateway() {
        let port = a_daemon_serving_nothing_else();
        let (supervisor, record) = supervising_a_stub("a-started-daemon-that-breaks", port);
        let daemon = Daemon::with_supervisor(Some(record), supervisor, TIMEOUT, REPLY_LIMIT);

        let answer =
            tauri::async_runtime::block_on(daemon.forward("/projects", &write("/projects")));

        assert_eq!(answer.status(), StatusCode::BAD_GATEWAY);
        assert!(answer.body().is_empty());
    }

    #[test]
    fn a_retired_daemon_starts_none_for_a_forward() {
        let port = answering(health());
        let (supervisor, record) = supervising_a_stub("a-retired-forward", port);
        let daemon = Daemon::with_supervisor(Some(record), supervisor, TIMEOUT, REPLY_LIMIT);

        tauri::async_runtime::block_on(daemon.retire());
        let answer = tauri::async_runtime::block_on(daemon.forward("/health", &write("/health")));

        assert_eq!(answer.status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn a_daemon_that_cannot_be_reached_answers_a_bad_gateway() {
        let daemon = daemon_on_a_dead_port("unreachable");
        let answer =
            tauri::async_runtime::block_on(daemon.forward("/projects", &write("/projects")));

        assert_eq!(answer.status(), StatusCode::BAD_GATEWAY);
        assert!(answer.body().is_empty());
    }

    #[test]
    fn a_home_the_environment_names_none_of_leaves_the_default_port() {
        let daemon = Daemon::at(None);

        assert_eq!(daemon.port(), DEFAULT_PORT);
        assert_eq!(daemon.reread(), DEFAULT_PORT);
    }

    #[test]
    fn an_answer_that_breaks_part_way_out_is_a_bad_gateway() {
        // A content-length the daemon never sends: the status and the headers
        // arrive, the body does not, and the read of it fails.
        let (port, _seen) = listen("HTTP/1.1 200 OK\r\ncontent-length: 64\r\n\r\n{}");
        let daemon = Daemon::at(Some(record_naming("broken-answer", port)));

        let answer =
            tauri::async_runtime::block_on(daemon.forward("/projects", &write("/projects")));

        assert_eq!(answer.status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn an_answer_past_the_ceiling_is_a_bad_gateway() {
        let (port, _seen) =
            listen("HTTP/1.1 200 OK\r\ncontent-length: 20\r\n\r\n01234567890123456789");
        let daemon = Daemon::limited(Some(record_naming("past-the-ceiling", port)), TIMEOUT, 8);

        let answer =
            tauri::async_runtime::block_on(daemon.forward("/projects", &write("/projects")));

        assert_eq!(answer.status(), StatusCode::BAD_GATEWAY);
        assert!(answer.body().is_empty());
    }

    #[test]
    fn a_failed_forward_names_the_fault_it_ended_in() {
        let call = write("/projects");
        let fault = |daemon: &Daemon, port| {
            let sent = daemon.send(port, "/projects", &call);
            fault_of(&tauri::async_runtime::block_on(sent).unwrap_err())
        };

        // The listener reads the request to its own timeout before it answers,
        // so only the call that must not be answered takes the short wait.
        let waits = Daemon::limited(None, Duration::from_millis(250), REPLY_LIMIT);
        let answers = Daemon::limited(None, TIMEOUT, REPLY_LIMIT);

        let named = fault(&answers, dead_port());
        assert!(named.starts_with("nothing is listening"), "{named}");

        // Accepted and left open, so the wait is what ends the call.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let silent = listener.local_addr().unwrap().port();
        let held = std::thread::spawn(move || listener.accept().unwrap());
        let named = fault(&waits, silent);
        assert!(
            named.starts_with("nothing answered within the wait"),
            "{named}"
        );
        drop(held.join().unwrap());

        // A content-length the listener never sends.
        let (broken, _seen) = listen("HTTP/1.1 200 OK\r\ncontent-length: 64\r\n\r\n{}");
        let named = fault(&answers, broken);
        assert!(named.starts_with("the reply broke part way out"), "{named}");
    }

    #[test]
    fn an_answer_at_the_ceiling_is_read_whole() {
        let (port, _seen) =
            listen("HTTP/1.1 200 OK\r\ncontent-length: 20\r\n\r\n01234567890123456789");
        let daemon = Daemon::limited(Some(record_naming("at-the-ceiling", port)), TIMEOUT, 20);

        let answer =
            tauri::async_runtime::block_on(daemon.forward("/projects", &write("/projects")));

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(answer.body(), b"01234567890123456789");
    }
}
