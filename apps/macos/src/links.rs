//! The link settings of the board. The board sends them at start and after each
//! change, and the app keeps the last ones in memory.

use std::sync::{Mutex, MutexGuard, PoisonError};

use serde_json::{Map, Value};
use tauri::http::{Method, Response, StatusCode};
use tauri::{AppHandle, Manager as _, Runtime};

use crate::update::plain;

/// The route under `/app`. Held to `LINKS_ROUTE` in `apps/web` by a repo test.
pub(crate) const PATH: &str = "/links";

// The keys of the body. Held to the keys of `DEFAULT_LINK_SETTINGS` by a repo test.
const BROWSER: &str = "browser";
const DEV_BROWSER: &str = "devBrowser";
const DEV_DOMAINS: &str = "devDomains";
const FILE_APP: &str = "fileApp";

/// An empty field is its default. `LinkSettings` in `apps/web` states what each
/// default means.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Settings {
    pub(crate) browser: String,
    pub(crate) dev_browser: String,
    pub(crate) dev_domains: Vec<String>,
    pub(crate) file_app: String,
}

#[derive(Default)]
pub(crate) struct Links(Mutex<Settings>);

impl Links {
    fn lock(&self) -> MutexGuard<'_, Settings> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The last settings the board sent, or the defaults before its first send.
#[cfg_attr(not(test), expect(dead_code))]
pub(crate) fn settings<R: Runtime>(app: &AppHandle<R>) -> Settings {
    app.state::<Links>().lock().clone()
}

fn string(fields: &Map<String, Value>, key: &str) -> String {
    match fields.get(key) {
        Some(Value::String(value)) => value.clone(),
        _ => String::new(),
    }
}

fn strings(fields: &Map<String, Value>, key: &str) -> Vec<String> {
    let Some(Value::Array(entries)) = fields.get(key) else {
        return Vec::new();
    };

    entries
        .iter()
        .map(|entry| entry.as_str().map(str::to_owned))
        .collect::<Option<_>>()
        .unwrap_or_default()
}

/// Each field is read on its own: an invalid one takes its default, and the
/// others still apply. `None` for a body that is not a JSON object.
fn read(body: &[u8]) -> Option<Settings> {
    let Ok(Value::Object(fields)) = serde_json::from_slice(body) else {
        return None;
    };

    Some(Settings {
        browser: string(&fields, BROWSER),
        dev_browser: string(&fields, DEV_BROWSER),
        dev_domains: strings(&fields, DEV_DOMAINS),
        file_app: string(&fields, FILE_APP),
    })
}

pub(crate) fn handles(path: &str) -> bool {
    path.strip_prefix(PATH)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// `POST /app/links`. The answer comes after the copy is replaced.
pub(crate) fn serve<R: Runtime>(
    app: &AppHandle<R>,
    method: &Method,
    path: &str,
    body: &[u8],
) -> Response<Vec<u8>> {
    if path != PATH {
        return plain(StatusCode::NOT_FOUND);
    }

    if *method != Method::POST {
        return plain(StatusCode::METHOD_NOT_ALLOWED);
    }

    let Some(settings) = read(body) else {
        return plain(StatusCode::BAD_REQUEST);
    };

    *app.state::<Links>().lock() = settings;
    plain(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;
    use tauri::App;
    use tauri::test::{MockRuntime, mock_app};

    fn sent() -> Map<String, Value> {
        let Value::Object(fields) = json!({
            "browser": "com.example.browser",
            "devBrowser": "com.example.dev-browser",
            "devDomains": ["example.test", "staging.example.org"],
            "fileApp": "com.example.editor",
        }) else {
            unreachable!("the literal is an object");
        };

        fields
    }

    fn stored() -> Settings {
        Settings {
            browser: "com.example.browser".to_string(),
            dev_browser: "com.example.dev-browser".to_string(),
            dev_domains: vec![
                "example.test".to_string(),
                "staging.example.org".to_string(),
            ],
            file_app: "com.example.editor".to_string(),
        }
    }

    fn stored_with_default(key: &str) -> Settings {
        let mut settings = stored();

        match key {
            BROWSER => settings.browser.clear(),
            DEV_BROWSER => settings.dev_browser.clear(),
            DEV_DOMAINS => settings.dev_domains.clear(),
            FILE_APP => settings.file_app.clear(),
            _ => unreachable!("{key} is not a field"),
        }

        settings
    }

    fn body(fields: &Map<String, Value>) -> Vec<u8> {
        serde_json::to_vec(fields).unwrap()
    }

    fn app_holding(settings: Settings) -> App<MockRuntime> {
        let app = mock_app();
        app.manage(Links(Mutex::new(settings)));
        app
    }

    #[test]
    fn a_post_stores_the_four_fields_and_answers_with_nothing() {
        let app = app_holding(Settings::default());

        let answer = serve(app.handle(), &Method::POST, PATH, &body(&sent()));

        assert_eq!(answer.status(), StatusCode::NO_CONTENT);
        assert!(answer.body().is_empty());
        assert_eq!(settings(app.handle()), stored());
    }

    #[test]
    fn the_copy_starts_on_the_defaults() {
        let app = mock_app();
        app.manage(Links::default());

        assert_eq!(
            settings(app.handle()),
            Settings {
                browser: String::new(),
                dev_browser: String::new(),
                dev_domains: Vec::new(),
                file_app: String::new(),
            }
        );
    }

    #[test]
    fn a_missing_field_takes_its_default_and_the_others_apply() {
        for key in [BROWSER, DEV_BROWSER, DEV_DOMAINS, FILE_APP] {
            let mut fields = sent();
            fields.remove(key);

            assert_eq!(
                read(&body(&fields)),
                Some(stored_with_default(key)),
                "{key}"
            );
        }
    }

    #[test]
    fn an_invalid_field_takes_its_default_and_the_others_apply() {
        let invalid = [
            (BROWSER, json!(42)),
            (DEV_BROWSER, Value::Null),
            (FILE_APP, json!(["com.example.editor"])),
            (DEV_DOMAINS, json!("example.test")),
            (DEV_DOMAINS, json!(["example.test", 7])),
            (DEV_DOMAINS, json!({ "0": "example.test" })),
        ];

        for (key, value) in invalid {
            let mut fields = sent();
            fields.insert(key.to_string(), value.clone());

            assert_eq!(
                read(&body(&fields)),
                Some(stored_with_default(key)),
                "{key}: {value}"
            );
        }
    }

    #[test]
    fn an_unknown_field_is_ignored() {
        let mut fields = sent();
        fields.insert("theme".to_string(), json!("dark"));

        assert_eq!(read(&body(&fields)), Some(stored()));
    }

    #[test]
    fn a_body_that_is_not_a_json_object_is_refused_and_the_copy_stays() {
        for refused in ["{browser", "", "[]", "null", "\"x\""] {
            let app = app_holding(stored());

            let answer = serve(app.handle(), &Method::POST, PATH, refused.as_bytes());

            assert_eq!(answer.status(), StatusCode::BAD_REQUEST, "{refused}");
            assert_eq!(settings(app.handle()), stored(), "{refused}");
        }
    }

    #[test]
    fn another_method_is_not_allowed() {
        let app = app_holding(stored());

        for method in [Method::GET, Method::PUT, Method::DELETE] {
            assert_eq!(
                serve(app.handle(), &method, PATH, &body(&sent())).status(),
                StatusCode::METHOD_NOT_ALLOWED,
                "{method}"
            );
        }
    }

    #[test]
    fn another_path_under_the_route_is_not_found() {
        let app = app_holding(stored());

        for path in ["/links/", "/links/x"] {
            assert_eq!(
                serve(app.handle(), &Method::POST, path, &body(&sent())).status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
    }

    #[test]
    fn the_route_is_a_whole_segment() {
        assert!(handles("/links"));
        assert!(handles("/links/x"));
        assert!(!handles("/linksx"));
        assert!(!handles("/theme"));
    }
}
