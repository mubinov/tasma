//! The appearance of the window, set from the theme setting of the board.
//!
//! Only the window takes it. The Dock icon and the window background follow the
//! appearance of the application, which stays on that of macOS.

use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization as _, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
};
use tauri::http::{Method, Response, StatusCode};
use tauri::{AppHandle, Manager as _, Runtime};

use crate::titlebar;
use crate::update::plain;

/// The route under `/app`. Held to `THEME_ROUTE` in `apps/web` by a repo test.
pub(crate) const PATH: &str = "/theme";

// The path segments under `PATH`. Held to `THEME_PREFERENCES` by a repo test.
const LIGHT: &str = "light";
const DARK: &str = "dark";
const SYSTEM: &str = "system";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Setting {
    Light,
    Dark,
    System,
}

/// `None` gives the window back the appearance of macOS.
fn appearance(setting: Setting) -> Option<Retained<NSAppearance>> {
    // Safety: AppKit defines both names as constant strings.
    let name = unsafe {
        match setting {
            Setting::Light => NSAppearanceNameAqua,
            Setting::Dark => NSAppearanceNameDarkAqua,
            Setting::System => return None,
        }
    };

    NSAppearance::appearanceNamed(name)
}

fn apply<R: Runtime>(app: &AppHandle<R>, setting: Setting) {
    let Some(window) = app.get_webview_window(crate::WINDOW) else {
        return;
    };
    let marker = MainThreadMarker::new().expect("run_on_main_thread runs on the main thread");
    let Some(ns_window) = titlebar::native(marker, &window) else {
        return;
    };

    ns_window.setAppearance(appearance(setting).as_deref());
}

pub(crate) fn handles(path: &str) -> bool {
    path.strip_prefix(PATH)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn requested(method: &Method, path: &str) -> Result<Setting, StatusCode> {
    let setting = match path
        .strip_prefix(PATH)
        .and_then(|rest| rest.strip_prefix('/'))
    {
        Some(LIGHT) => Setting::Light,
        Some(DARK) => Setting::Dark,
        Some(SYSTEM) => Setting::System,
        _ => return Err(StatusCode::NOT_FOUND),
    };

    if *method == Method::POST {
        Ok(setting)
    } else {
        Err(StatusCode::METHOD_NOT_ALLOWED)
    }
}

/// `POST /app/theme/<setting>`. The answer does not wait for the main thread.
pub(crate) fn serve<R: Runtime>(
    app: &AppHandle<R>,
    method: &Method,
    path: &str,
) -> Response<Vec<u8>> {
    match requested(method, path) {
        Ok(setting) => {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || apply(&handle, setting));
            plain(StatusCode::ACCEPTED)
        }
        Err(status) => plain(status),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tauri::test::mock_app;

    const SETTINGS: [Setting; 3] = [Setting::Light, Setting::Dark, Setting::System];
    const PATHS: [&str; 3] = ["/theme/light", "/theme/dark", "/theme/system"];

    #[test]
    fn a_post_names_one_of_the_three_settings() {
        for (path, setting) in PATHS.into_iter().zip(SETTINGS) {
            assert_eq!(requested(&Method::POST, path), Ok(setting), "{path}");
        }
    }

    #[test]
    fn another_method_on_a_setting_is_not_allowed() {
        for path in PATHS {
            for method in [Method::GET, Method::PUT, Method::DELETE] {
                assert_eq!(
                    requested(&method, path),
                    Err(StatusCode::METHOD_NOT_ALLOWED),
                    "{method} {path}"
                );
            }
        }
    }

    #[test]
    fn another_path_under_the_route_is_not_found() {
        for path in [
            "/theme",
            "/theme/",
            "/theme/Dark",
            "/theme/dark/more",
            "/theme/other",
        ] {
            assert_eq!(
                requested(&Method::POST, path),
                Err(StatusCode::NOT_FOUND),
                "{path}"
            );
        }

        assert_eq!(
            requested(&Method::GET, "/theme/other"),
            Err(StatusCode::NOT_FOUND)
        );
    }

    #[test]
    fn the_route_is_a_whole_segment() {
        assert!(handles("/theme"));
        assert!(handles("/theme/x"));
        assert!(!handles("/themes"));
        assert!(!handles("/dock"));
    }

    #[test]
    fn each_setting_names_its_appearance() {
        let names: Vec<Option<String>> = SETTINGS
            .into_iter()
            .map(|setting| appearance(setting).map(|found| found.name().to_string()))
            .collect();

        assert_eq!(
            names,
            [
                Some("NSAppearanceNameAqua".to_string()),
                Some("NSAppearanceNameDarkAqua".to_string()),
                None,
            ]
        );
    }

    #[test]
    fn a_post_with_no_window_answers_with_nothing() {
        let app = mock_app();

        let answer = serve(app.handle(), &Method::POST, "/theme/dark");

        assert_eq!(answer.status(), StatusCode::ACCEPTED);
        assert!(answer.body().is_empty());
    }

    #[test]
    fn a_refused_request_answers_its_status() {
        let app = mock_app();

        assert_eq!(
            serve(app.handle(), &Method::GET, "/theme/dark").status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            serve(app.handle(), &Method::POST, "/theme/other").status(),
            StatusCode::NOT_FOUND
        );
    }
}
