//! Backspace outside an editable field. A macOS web view turns it into a step
//! back in the history, and Shift+Backspace into a step forward, unless its
//! preferences turn that off.

use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol as _, Sel};
use objc2::{msg_send, sel};
use objc2_web_kit::WKWebView;
use tauri::{Runtime, WebviewWindow};

use crate::log;

/// The setter of a private `WKPreferences` setting, on by default in a macOS
/// web view.
fn setter() -> Sel {
    sel!(_setBackspaceKeyNavigationEnabled:)
}

/// Turns the setting off on a `WKPreferences`, or answers why it cannot.
fn turn_off(preferences: &NSObject) -> Result<(), String> {
    if !preferences.respondsToSelector(setter()) {
        return Err("WebKit has no _setBackspaceKeyNavigationEnabled:".to_string());
    }

    // Safety: the object answers the selector, which takes one `BOOL`.
    let () = unsafe { msg_send![preferences, _setBackspaceKeyNavigationEnabled: false] };

    Ok(())
}

/// `configuration` answers a copy, but the copy holds the preferences object
/// of the live web view.
fn turn_off_in(webview: Option<Retained<WKWebView>>) -> Result<(), String> {
    let webview = webview.ok_or_else(|| "no web view".to_string())?;
    // Safety: on the main thread, both getters answer live objects.
    let preferences = unsafe { webview.configuration().preferences() };

    turn_off(&preferences)
}

fn stays_on(cause: &str) {
    let file = log::open(std::env::home_dir().as_deref()).ok();
    log::note(
        file.as_ref(),
        &format!("backspace navigation stays on: {cause}"),
    );
}

/// Turns off Backspace navigation in the web view of the window. Called on the
/// main thread, where the closure runs before this returns. A failure keeps
/// the navigation and writes one line to the log.
pub(crate) fn install<R: Runtime>(window: &WebviewWindow<R>) {
    let installed = window.with_webview(|webview| {
        // Safety: on the main thread, `inner` gives the live `WKWebView` of the
        // window, or null.
        let webview = unsafe { Retained::retain(webview.inner().cast::<WKWebView>()) };

        if let Err(cause) = turn_off_in(webview) {
            stays_on(&cause);
        }
    });

    if let Err(error) = installed {
        stays_on(&log::quoted(&error.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use objc2::{AnyThread as _, ClassType as _, DefinedClass as _, define_class};
    use objc2_web_kit::WKPreferences;
    use tauri::test::mock_app;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    use super::*;

    define_class!(
        // Safety: `NSObject` has no subclassing requirement, and the class has
        // no `Drop`.
        #[unsafe(super(NSObject))]
        #[name = "TasmaSamplePreferences"]
        #[ivars = Cell<Option<bool>>]
        struct SamplePreferences;

        impl SamplePreferences {
            #[unsafe(method(_setBackspaceKeyNavigationEnabled:))]
            fn set_backspace_key_navigation_enabled(&self, enabled: bool) {
                self.ivars().set(Some(enabled));
            }
        }
    );

    impl SamplePreferences {
        fn new() -> Retained<Self> {
            let sample = Self::alloc().set_ivars(Cell::new(None));

            // Safety: `init` is the designated initializer of `NSObject`.
            unsafe { msg_send![super(sample), init] }
        }
    }

    #[test]
    fn webkit_preferences_answer_the_setter() {
        assert!(WKPreferences::class().responds_to(setter()));
    }

    #[test]
    fn the_setting_is_turned_off() {
        let preferences = SamplePreferences::new();

        assert_eq!(turn_off(&preferences), Ok(()));
        assert_eq!(preferences.ivars().get(), Some(false));
    }

    #[test]
    fn an_object_without_the_setter_is_left_alone() {
        assert_eq!(
            turn_off(&NSObject::new()),
            Err("WebKit has no _setBackspaceKeyNavigationEnabled:".to_string())
        );
    }

    #[test]
    fn a_null_web_view_is_left_alone() {
        assert_eq!(turn_off_in(None), Err("no web view".to_string()));
    }

    #[test]
    fn install_is_a_no_op_on_the_mock_runtime() {
        let app = mock_app();
        let window = WebviewWindowBuilder::new(&app, crate::WINDOW, WebviewUrl::default())
            .build()
            .unwrap();

        install(&window);
    }
}
