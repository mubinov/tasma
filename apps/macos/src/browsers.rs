//! The browsers installed on this Mac, the rule that chooses one for a web
//! link, and `GET /app/browsers`.

use objc2::rc::autoreleasepool;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSBundle, NSString, NSURL};
use serde::Serialize;
use tauri::Url;
use tauri::http::{Method, Response, StatusCode};

use crate::links::Settings;
use crate::update::{json, plain};

/// The route under `/app`. Held to `BROWSERS_ROUTE` in `apps/web` by a repo test.
pub(crate) const PATH: &str = "/browsers";

/// No app claims a host of the reserved `.invalid` domain through a universal
/// link, so only the apps that open the `https` scheme answer for it.
const PROBE: &str = "https://example.invalid/";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Browser {
    /// The bundle id.
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) default: bool,
}

/// The browsers, one for each bundle id, sorted by name. `apps` holds the
/// bundle id and the name of each app that Launch Services gives.
fn listed(apps: Vec<(Option<String>, String)>, default_id: Option<&str>) -> Vec<Browser> {
    let mut browsers: Vec<Browser> = Vec::new();

    for (id, name) in apps {
        let Some(id) = id else {
            continue;
        };
        if browsers.iter().any(|browser| browser.id == id) {
            continue;
        }

        browsers.push(Browser {
            default: default_id == Some(id.as_str()),
            id,
            name,
        });
    }

    browsers.sort_by(|one, other| {
        one.name
            .to_lowercase()
            .cmp(&other.name.to_lowercase())
            .then_with(|| one.id.cmp(&other.id))
    });

    browsers
}

pub(crate) fn bundle_id(bundle: &NSBundle) -> Option<String> {
    bundle.bundleIdentifier().map(|id| id.to_string())
}

fn info_string(bundle: &NSBundle, key: &str) -> Option<String> {
    let value = bundle.objectForInfoDictionaryKey(&NSString::from_str(key))?;

    value
        .downcast::<NSString>()
        .ok()
        .map(|value| value.to_string())
}

/// The bundle id and the name of the app at `url`.
pub(crate) fn app_of(url: &NSURL) -> (Option<String>, String) {
    let bundle = NSBundle::bundleWithURL(url);
    let name = bundle
        .as_deref()
        .and_then(|bundle| {
            info_string(bundle, "CFBundleDisplayName")
                .or_else(|| info_string(bundle, "CFBundleName"))
        })
        .or_else(|| {
            url.URLByDeletingPathExtension()?
                .lastPathComponent()
                .map(|name| name.to_string())
        })
        .unwrap_or_default();

    (bundle.as_deref().and_then(bundle_id), name)
}

/// The browsers that Launch Services lists now.
pub(crate) fn installed() -> Vec<Browser> {
    // A worker thread of the async runtime has no autorelease pool.
    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let probe = NSURL::URLWithString(&NSString::from_str(PROBE)).expect("the probe is a URL");
        let apps = workspace
            .URLsForApplicationsToOpenURL(&probe)
            .iter()
            .map(|app| app_of(&app))
            .collect();
        let default_id = workspace
            .URLForApplicationToOpenURL(&probe)
            .and_then(|app| NSBundle::bundleWithURL(&app))
            .and_then(|bundle| bundle_id(&bundle));

        listed(apps, default_id.as_deref())
    })
}

/// Whether a web link opens in the development browser. The URL parser gives
/// the host in lowercase ASCII.
fn is_development(url: &Url, dev_domains: &[String]) -> bool {
    match url.domain() {
        Some(name) => {
            name == "localhost"
                || name.ends_with(".localhost")
                || dev_domains
                    .iter()
                    .any(|entry| name == entry || name.ends_with(&format!(".{entry}")))
        }
        // A host that is no domain is an IP address.
        None => url.host_str().is_some(),
    }
}

/// The browser a web link opens in, or `None` for the macOS default browser. A
/// setting that names no installed browser counts as empty.
pub(crate) fn choose<'a>(
    url: &Url,
    settings: &Settings,
    installed: &'a [Browser],
) -> Option<&'a Browser> {
    let find = |id: &str| installed.iter().find(|browser| browser.id == id);

    is_development(url, &settings.dev_domains)
        .then(|| find(&settings.dev_browser))
        .flatten()
        .or_else(|| find(&settings.browser))
}

pub(crate) fn handles(path: &str) -> bool {
    path.strip_prefix(PATH)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// `GET /app/browsers`.
pub(crate) fn serve(method: &Method, path: &str) -> Response<Vec<u8>> {
    if path != PATH {
        return plain(StatusCode::NOT_FOUND);
    }

    if *method != Method::GET {
        return plain(StatusCode::METHOD_NOT_ALLOWED);
    }

    json(&serde_json::json!(installed()))
}

#[cfg(test)]
mod tests {
    use super::*;

    use tauri::http::header::CONTENT_TYPE;

    fn url(text: &str) -> Url {
        text.parse().unwrap()
    }

    fn app(id: Option<&str>, name: &str) -> (Option<String>, String) {
        (id.map(str::to_owned), name.to_string())
    }

    fn browser(id: &str, name: &str, default: bool) -> Browser {
        Browser {
            id: id.to_string(),
            name: name.to_string(),
            default,
        }
    }

    fn domains(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|entry| entry.to_string()).collect()
    }

    const BROWSER: &str = "com.example.browser";
    const DEV_BROWSER: &str = "com.example.dev-browser";
    const NOT_INSTALLED: &str = "com.example.not-installed";

    fn example_browsers() -> Vec<Browser> {
        vec![
            browser(BROWSER, "Example Browser", true),
            browser(DEV_BROWSER, "Example Dev Browser", false),
        ]
    }

    fn settings(browser: &str, dev_browser: &str, dev_domains: &[&str]) -> Settings {
        Settings {
            browser: browser.to_string(),
            dev_browser: dev_browser.to_string(),
            dev_domains: domains(dev_domains),
            ..Settings::default()
        }
    }

    fn chosen(link: &str, settings: &Settings) -> Option<String> {
        choose(&url(link), settings, &example_browsers()).map(|browser| browser.id.clone())
    }

    #[test]
    fn an_app_with_no_bundle_id_is_skipped() {
        assert_eq!(
            listed(
                vec![app(None, "Alpha"), app(Some("com.example.beta"), "Beta")],
                None
            ),
            vec![browser("com.example.beta", "Beta", false)]
        );
    }

    #[test]
    fn two_copies_of_one_bundle_id_give_the_first_entry() {
        assert_eq!(
            listed(
                vec![
                    app(Some("com.example.alpha"), "Alpha"),
                    app(Some("com.example.alpha"), "Alpha Old"),
                ],
                None
            ),
            vec![browser("com.example.alpha", "Alpha", false)]
        );
    }

    #[test]
    fn only_the_entry_of_the_default_id_is_marked() {
        assert_eq!(
            listed(
                vec![
                    app(Some("com.example.alpha"), "Alpha"),
                    app(Some("com.example.beta"), "Beta"),
                ],
                Some("com.example.beta")
            ),
            vec![
                browser("com.example.alpha", "Alpha", false),
                browser("com.example.beta", "Beta", true),
            ]
        );
    }

    #[test]
    fn no_entry_is_marked_when_the_default_id_is_not_in_the_list() {
        assert_eq!(
            listed(
                vec![app(Some("com.example.alpha"), "Alpha")],
                Some("com.example.gamma")
            ),
            vec![browser("com.example.alpha", "Alpha", false)]
        );
    }

    #[test]
    fn the_list_is_sorted_by_name_in_any_case_then_by_id() {
        assert_eq!(
            listed(
                vec![
                    app(Some("com.example.c"), "beta"),
                    app(Some("com.example.b"), "Alpha"),
                    app(Some("com.example.a"), "alpha"),
                ],
                None
            ),
            vec![
                browser("com.example.a", "alpha", false),
                browser("com.example.b", "Alpha", false),
                browser("com.example.c", "beta", false),
            ]
        );
    }

    #[test]
    fn a_local_host_or_an_ip_address_is_a_development_link() {
        for link in [
            "http://localhost/",
            "http://app.localhost/",
            "http://127.0.0.1/",
            "http://[::1]/",
            "https://203.0.113.7/",
            "http://LOCALHOST/",
            "http://localhost:3000/a/b",
        ] {
            assert!(is_development(&url(link), &[]), "{link}");
        }
    }

    #[test]
    fn a_public_name_is_not_a_development_link() {
        for link in [
            "https://example.com/",
            "https://localhost.example.com/",
            "https://notlocalhost/",
        ] {
            assert!(!is_development(&url(link), &[]), "{link}");
        }
    }

    #[test]
    fn a_development_domain_matches_itself_and_its_subdomains() {
        let entries = domains(&["example.test"]);

        for link in ["https://example.test/", "https://a.b.example.test:8443/"] {
            assert!(is_development(&url(link), &entries), "{link}");
        }
        for link in [
            "https://notexample.test/",
            "https://example.test.net/",
            "https://localhost.example.com/",
        ] {
            assert!(!is_development(&url(link), &entries), "{link}");
        }
    }

    #[test]
    fn a_link_with_no_host_is_not_a_development_link() {
        assert!(!is_development(
            &url("mailto:someone@example.test"),
            &domains(&["example.test"])
        ));
    }

    #[test]
    fn no_saved_settings_give_the_macos_default_browser() {
        for link in ["https://example.com/", "http://localhost:3000/"] {
            assert_eq!(chosen(link, &Settings::default()), None, "{link}");
        }
    }

    #[test]
    fn a_web_link_opens_in_the_browser() {
        assert_eq!(
            chosen("https://example.com/", &settings(BROWSER, DEV_BROWSER, &[])),
            Some(BROWSER.to_string())
        );
    }

    #[test]
    fn a_development_link_opens_in_the_development_browser() {
        let settings = settings(BROWSER, DEV_BROWSER, &["example.test"]);

        for link in [
            "http://localhost:3000/",
            "http://127.0.0.1:5173/",
            "http://[::1]:8080/",
            "https://app.example.test/",
        ] {
            assert_eq!(
                chosen(link, &settings),
                Some(DEV_BROWSER.to_string()),
                "{link}"
            );
        }
    }

    #[test]
    fn a_browser_that_is_not_installed_gives_the_macos_default_browser() {
        assert_eq!(
            chosen(
                "https://example.com/",
                &settings(NOT_INSTALLED, DEV_BROWSER, &[])
            ),
            None
        );
    }

    #[test]
    fn a_development_browser_that_is_not_installed_gives_the_browser() {
        assert_eq!(
            chosen(
                "http://localhost:3000/",
                &settings(BROWSER, NOT_INSTALLED, &[])
            ),
            Some(BROWSER.to_string())
        );
    }

    #[test]
    fn with_no_development_browser_a_development_link_opens_in_the_browser() {
        assert_eq!(
            chosen("http://localhost:3000/", &settings(BROWSER, "", &[])),
            Some(BROWSER.to_string())
        );
    }

    #[test]
    fn a_get_answers_the_installed_browsers() {
        let answer = serve(&Method::GET, PATH);

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(
            answer.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
        let serde_json::Value::Array(entries) = serde_json::from_slice(answer.body()).unwrap()
        else {
            panic!("the answer is a JSON array");
        };
        // Safari is on every Mac.
        assert!(!entries.is_empty());
        for entry in entries {
            assert!(entry["id"].is_string(), "{entry}");
            assert!(entry["name"].is_string(), "{entry}");
            assert!(entry["default"].is_boolean(), "{entry}");
            assert_eq!(entry.as_object().unwrap().len(), 3, "{entry}");
        }
    }

    #[test]
    fn another_method_is_not_allowed() {
        for method in [Method::POST, Method::PUT, Method::DELETE] {
            let answer = serve(&method, PATH);

            assert_eq!(answer.status(), StatusCode::METHOD_NOT_ALLOWED, "{method}");
            assert!(answer.body().is_empty());
        }
    }

    #[test]
    fn another_path_under_the_route_is_not_found() {
        for path in ["/browsers/", "/browsers/x"] {
            assert_eq!(
                serve(&Method::GET, path).status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
    }

    #[test]
    fn the_route_is_a_whole_segment() {
        assert!(handles("/browsers"));
        assert!(handles("/browsers/x"));
        assert!(!handles("/browsersx"));
        assert!(!handles("/open"));
    }
}
