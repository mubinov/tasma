//! The one origin the window loads: the embedded bundle and the daemon behind a
//! single custom scheme.
//!
//! Because the two share an origin, `apps/web` needs no change — `base: "./"`
//! writes relative asset paths, the renderer writes `/daemon/...`, and
//! `connect-src 'self'` covers the calls.

use percent_encoding::percent_decode_str;
use tauri::http::header::{CONTENT_SECURITY_POLICY, CONTENT_TYPE};
use tauri::http::{Request, Response, StatusCode, Uri};
use tauri::{AppHandle, Runtime};

use crate::daemon::Daemon;

/// Where the renderer writes every daemon call, and where the Vite dev and
/// preview servers mount their proxy. Held to `DAEMON_PATH_PREFIX` in
/// `apps/web` by a repo test.
const PREFIX: &str = "/daemon";

/// What the origin serves a request from.
#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    /// The path and query to forward, with the prefix removed.
    Daemon(String),
    /// The file to read out of the embedded bundle.
    Asset(String),
}

/// Which file a path names. `/` is the document; every other path is taken as
/// written.
///
/// This adds no rule of its own beyond the root. `base: "./"` makes every asset
/// URL relative to the document and hash history keeps every route after the
/// `#`, so a route never arrives here as a path to rewrite.
fn asset_path(path: &str) -> String {
    if path == "/" {
        "/index.html".to_string()
    } else {
        path.to_string()
    }
}

/// Where a request goes.
///
/// The prefix has to end the path or be followed by a separator: `/daemonx`
/// names a file and not the daemon. The Vite proxy keys on a plain prefix and
/// would forward it; neither rule is normative, because the renderer writes the
/// prefix as a whole segment and a path between the two is one no caller sends.
pub fn route(uri: &Uri) -> Target {
    let path = uri.path();

    let rest = match path.strip_prefix(PREFIX) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => rest,
        _ => return Target::Asset(asset_path(path)),
    };

    // A request to exactly /daemon leaves nothing, which is not a path.
    let target = if rest.is_empty() { "/" } else { rest };

    match uri.query() {
        Some(query) => Target::Daemon(format!("{target}?{query}")),
        None => Target::Daemon(target.to_string()),
    }
}

/// Whether a path names a file the bundle can hold.
///
/// A `..` segment does not. WebKit resolves one before wry sees the request, and
/// Tauri's resolver looks up an embedded map in a packaged build — but in a
/// build without `custom-protocol` it joins the path onto a directory on disk
/// instead, so the guard stands here, where the answer is decided.
///
/// The decoded path is what is read: `Uri::path` leaves the escapes as written
/// while the resolver decodes before it looks a name up, so a guard on the
/// encoded form would pass `%2e%2e` to a sink that reads `..`.
fn inside_the_bundle(path: &str) -> bool {
    let decoded = percent_decode_str(path).decode_utf8_lossy();

    !decoded.split('/').any(|segment| segment == "..")
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(CONTENT_TYPE, "text/plain")
        .body(Vec::new())
        .expect("a status and one header are a response")
}

/// The file under a path, with the media type Tauri recorded for it.
///
/// Tauri's own resolver answers a path it holds no file for with the document,
/// so nothing under this origin 404s while the bundle carries one.
fn asset<R: Runtime>(app: &AppHandle<R>, path: &str) -> Response<Vec<u8>> {
    if !inside_the_bundle(path) {
        return not_found();
    }

    let Some(asset) = app.asset_resolver().get(path.to_string()) else {
        return not_found();
    };

    let mut answer = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, asset.mime_type);

    // Tauri supplies a policy header only where `app.security.csp` names one.
    if let Some(policy) = asset.csp_header {
        answer = answer.header(CONTENT_SECURITY_POLICY, policy);
    }

    answer
        .body(asset.bytes)
        .expect("a status and two headers are a response")
}

/// One request on the origin, start to finish.
pub async fn serve<R: Runtime>(
    app: &AppHandle<R>,
    daemon: &Daemon,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    match route(request.uri()) {
        Target::Daemon(target) => daemon.forward(&target, &request).await,
        Target::Asset(path) => asset(app, &path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routed(uri: &str) -> Target {
        route(&uri.parse::<Uri>().unwrap())
    }

    #[test]
    fn a_daemon_path_forwards_without_the_prefix() {
        assert_eq!(
            routed("tasma-app://localhost/daemon/projects/AAA/tasks"),
            Target::Daemon("/projects/AAA/tasks".to_string()),
        );
    }

    #[test]
    fn a_daemon_path_keeps_its_query() {
        assert_eq!(
            routed("tasma-app://localhost/daemon/tasks?x=1&label=one%20two"),
            Target::Daemon("/tasks?x=1&label=one%20two".to_string()),
        );
    }

    #[test]
    fn the_prefix_alone_forwards_as_the_root() {
        assert_eq!(
            routed("tasma-app://localhost/daemon"),
            Target::Daemon("/".to_string())
        );
    }

    #[test]
    fn the_prefix_alone_with_a_query_forwards_as_the_root() {
        assert_eq!(
            routed("tasma-app://localhost/daemon?x=1"),
            Target::Daemon("/?x=1".to_string()),
        );
    }

    #[test]
    fn a_trailing_separator_forwards_as_the_root() {
        assert_eq!(
            routed("tasma-app://localhost/daemon/"),
            Target::Daemon("/".to_string())
        );
    }

    #[test]
    fn a_name_that_only_starts_with_the_prefix_is_an_asset() {
        assert_eq!(
            routed("tasma-app://localhost/daemonx"),
            Target::Asset("/daemonx".to_string()),
        );
    }

    #[test]
    fn the_root_names_the_document() {
        assert_eq!(
            routed("tasma-app://localhost/"),
            Target::Asset("/index.html".to_string())
        );
    }

    #[test]
    fn a_file_is_taken_as_written() {
        assert_eq!(
            routed("tasma-app://localhost/assets/index-B9TiXxEm.css"),
            Target::Asset("/assets/index-B9TiXxEm.css".to_string()),
        );
    }

    #[test]
    fn a_route_never_arrives_as_a_path() {
        // Hash history keeps every route after the `#`, which no request carries.
        assert_eq!(
            routed("tasma-app://localhost/index.html"),
            Target::Asset("/index.html".to_string()),
        );
    }

    #[test]
    fn a_path_that_climbs_names_no_file() {
        assert!(!inside_the_bundle("/../../etc/passwd"));
        assert!(!inside_the_bundle("/assets/../../secrets"));
        assert!(inside_the_bundle("/assets/index.css"));
        // The segment has to be the whole of it.
        assert!(inside_the_bundle("/assets/..index.css"));
    }

    #[test]
    fn a_path_that_climbs_under_an_escape_names_no_file() {
        assert!(!inside_the_bundle("/%2e%2e/%2e%2e/etc/passwd"));
        assert!(!inside_the_bundle("/%2E%2E/secrets"));
        // The separator escaped as well, so the segments are not the ones
        // `Uri::path` splits into.
        assert!(!inside_the_bundle("/assets%2f..%2f..%2fsecrets"));
        assert!(inside_the_bundle("/assets/index%20one.css"));
    }

    // The bundle is served through Tauri's own resolver, so these drive a real
    // app over the mock runtime.

    use std::borrow::Cow;
    use std::collections::HashMap;

    use tauri::test::{MockRuntime, mock_builder, mock_context};
    use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
    use tauri::utils::config::Csp;
    use tauri::{App, Assets};

    struct Bundle(HashMap<String, Vec<u8>>);

    impl<R: Runtime> Assets<R> for Bundle {
        fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
            self.0
                .get(key.as_ref())
                .map(|bytes| Cow::Borrowed(bytes.as_slice()))
        }

        fn iter(&self) -> Box<AssetsIter<'_>> {
            Box::new(
                self.0.iter().map(|(key, bytes)| {
                    (Cow::Borrowed(key.as_str()), Cow::Borrowed(bytes.as_slice()))
                }),
            )
        }

        fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
            Box::new(std::iter::empty())
        }
    }

    // Through `AssetKey`, which roots every name, so the keys are the ones the
    // embedded bundle is looked up under.
    fn bundle(files: &[(&str, &[u8])]) -> Bundle {
        Bundle(
            files
                .iter()
                .map(|(name, bytes)| (AssetKey::from(*name).as_ref().to_string(), bytes.to_vec()))
                .collect(),
        )
    }

    fn app_holding(files: &[(&str, &[u8])]) -> App<MockRuntime> {
        mock_builder().build(mock_context(bundle(files))).unwrap()
    }

    fn app_under(policy: &str, files: &[(&str, &[u8])]) -> App<MockRuntime> {
        let mut context = mock_context(bundle(files));
        context.config_mut().app.security.csp = Some(Csp::Policy(policy.to_string()));
        mock_builder().build(context).unwrap()
    }

    #[test]
    fn a_file_is_served_with_the_media_type_it_was_embedded_under() {
        let app = app_holding(&[
            ("index.html", b"<!doctype html>"),
            ("assets/index.css", b".a{color:red}"),
        ]);

        let answer = asset(app.handle(), "/assets/index.css");

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(answer.headers().get(CONTENT_TYPE).unwrap(), "text/css");
        assert_eq!(answer.body(), b".a{color:red}");
    }

    #[test]
    fn the_document_is_served_for_the_root() {
        let app = app_holding(&[("index.html", b"<!doctype html>")]);

        let answer = asset(app.handle(), "/index.html");

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(answer.headers().get(CONTENT_TYPE).unwrap(), "text/html");
        assert_eq!(answer.body(), b"<!doctype html>");
    }

    #[test]
    fn a_path_the_bundle_holds_no_file_for_is_served_the_document() {
        let app = app_holding(&[("index.html", b"<!doctype html>")]);

        let answer = asset(app.handle(), "/assets/gone.js");

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(answer.body(), b"<!doctype html>");
    }

    #[test]
    fn a_bundle_carrying_no_document_answers_not_found() {
        let app = app_holding(&[]);

        let answer = asset(app.handle(), "/index.html");

        assert_eq!(answer.status(), StatusCode::NOT_FOUND);
        assert!(answer.body().is_empty());
    }

    #[test]
    fn a_path_that_climbs_answers_not_found() {
        let app = app_holding(&[("index.html", b"<!doctype html>")]);

        let answer = asset(app.handle(), "/../../etc/passwd");

        assert_eq!(answer.status(), StatusCode::NOT_FOUND);
        assert!(answer.body().is_empty());
    }

    #[test]
    fn a_path_that_climbs_under_an_escape_answers_not_found() {
        let app = app_holding(&[("index.html", b"<!doctype html>")]);

        let answer = asset(app.handle(), "/%2e%2e/%2e%2e/etc/passwd");

        assert_eq!(answer.status(), StatusCode::NOT_FOUND);
        assert!(answer.body().is_empty());
    }

    #[test]
    fn a_policy_the_configuration_names_is_sent_with_the_document() {
        let app = app_under("default-src 'none'", &[("index.html", b"<!doctype html>")]);

        let answer = asset(app.handle(), "/index.html");

        assert_eq!(
            answer.headers().get(CONTENT_SECURITY_POLICY).unwrap(),
            "default-src 'none'"
        );
    }

    #[test]
    fn a_configuration_naming_no_policy_sends_none() {
        let app = app_holding(&[("index.html", b"<!doctype html>")]);

        let answer = asset(app.handle(), "/index.html");

        assert_eq!(answer.headers().get(CONTENT_SECURITY_POLICY), None);
    }

    #[test]
    fn the_origin_serves_a_file_and_forwards_a_daemon_call() {
        let app = app_holding(&[("index.html", b"<!doctype html>")]);
        let daemon = crate::daemon::fixtures::daemon_on_a_dead_port("a-file-and-a-call");

        let file = Request::builder()
            .uri("tasma-app://localhost/")
            .body(Vec::new())
            .unwrap();
        let answer = tauri::async_runtime::block_on(serve(app.handle(), &daemon, file));

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(answer.body(), b"<!doctype html>");

        // Nothing is listening for this one, so the daemon arm is what answers.
        let call = Request::builder()
            .uri("tasma-app://localhost/daemon/projects")
            .body(Vec::new())
            .unwrap();
        let answer = tauri::async_runtime::block_on(serve(app.handle(), &daemon, call));

        assert_eq!(answer.status(), StatusCode::BAD_GATEWAY);
    }
}
