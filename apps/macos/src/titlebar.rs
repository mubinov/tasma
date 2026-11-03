//! The band that moves the window, and the two lengths the board lays itself
//! out by.
//!
//! Under the overlay title bar the webview reaches the top of the window, so a
//! native view above it takes the presses there. The band is a sibling of the
//! webview: no event it takes reaches the board.

use std::sync::atomic::{AtomicBool, Ordering};

use dispatch2::MainThreadBound;
use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly as _, define_class, msg_send};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSEvent, NSUserInterfaceLayoutDirection, NSView, NSWindow,
    NSWindowButton, NSWindowOrderingMode,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSUserDefaults};
use tauri::{Manager as _, Runtime, WebviewWindow};

use crate::zoom;

/// The custom properties the script sets. `theme.css` gives them their value in
/// a browser, which runs no script.
const BAND_PROPERTY: &str = "--title-band";
const CONTROLS_PROPERTY: &str = "--title-controls";

/// The lengths of macOS 26.4 in points, for the paint before a window is
/// measured.
const DEFAULT_TITLE_BAR: f64 = 28.0;
const DEFAULT_CONTROLS: f64 = 64.0;

/// The room to the right of the zoom button, in points. It keeps the collapsed
/// sidebar 64 pt wide.
const CONTROLS_MARGIN: f64 = 3.0;

/// The system setting "Double-click a window's title bar to".
const DOUBLE_CLICK_SETTING: &str = "AppleActionOnDoubleClick";

/// The title bar of the window, with its lengths in points.
#[derive(Clone, Copy)]
struct TitleBarMetrics {
    title_bar: f64,
    /// The width the three buttons take from the left edge.
    controls: f64,
    full_screen: bool,
    /// AppKit then puts the buttons at the top right, over the empty band.
    right_to_left: bool,
}

/// The lengths the board gets, in CSS px.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Lengths {
    band: f64,
    controls: f64,
}

/// `scale` is the page zoom, which scales a CSS px and not a point.
fn lengths(metrics: TitleBarMetrics, scale: f64) -> Lengths {
    if metrics.full_screen {
        return Lengths {
            band: 0.0,
            controls: 0.0,
        };
    }

    Lengths {
        band: metrics.title_bar / scale,
        controls: if metrics.right_to_left {
            0.0
        } else {
            metrics.controls / scale
        },
    }
}

fn script(lengths: Lengths) -> String {
    let set = |name: &str, length: f64| {
        format!("document.documentElement.style.setProperty(\"{name}\",\"{length}px\");")
    };

    set(BAND_PROPERTY, lengths.band) + &set(CONTROLS_PROPERTY, lengths.controls)
}

/// The script that holds the board's layout still through its first paint.
pub(crate) fn first_script(scale: f64) -> String {
    script(lengths(
        TitleBarMetrics {
            title_bar: DEFAULT_TITLE_BAR,
            controls: DEFAULT_CONTROLS,
            full_screen: false,
            right_to_left: false,
        },
        scale,
    ))
}

#[derive(Debug, PartialEq, Eq)]
enum PressAction {
    Drag,
    Zoom,
    Minimize,
    Nothing,
}

/// AppKit has no public call for `Fill`, and zoom is the nearest action.
fn press_action(click_count: isize, setting: impl FnOnce() -> Option<String>) -> PressAction {
    if click_count != 2 {
        return PressAction::Drag;
    }

    match setting().as_deref() {
        Some("Minimize") => PressAction::Minimize,
        Some("None") => PressAction::Nothing,
        _ => PressAction::Zoom,
    }
}

fn double_click_setting() -> Option<String> {
    NSUserDefaults::standardUserDefaults()
        .stringForKey(&NSString::from_str(DOUBLE_CLICK_SETTING))
        .map(|setting| setting.to_string())
}

/// The parent view is not flipped, so its top is at its height.
fn band_frame(parent: NSSize, title_bar: f64) -> NSRect {
    NSRect::new(
        NSPoint::new(0.0, parent.height - title_bar),
        NSSize::new(parent.width, title_bar),
    )
}

define_class!(
    // Safety: `NSView` has no subclassing requirement, and `Band` has no `Drop`.
    #[unsafe(super(NSView))]
    #[name = "TasmaTitleBand"]
    struct Band;

    impl Band {
        // AppKit would otherwise also move the window and take the double-click.
        #[unsafe(method(mouseDownCanMoveWindow))]
        fn mouse_down_can_move_window(&self) -> bool {
            false
        }

        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            let Some(window) = self.window() else {
                return;
            };

            match press_action(event.clickCount(), double_click_setting) {
                PressAction::Drag => window.performWindowDragWithEvent(event),
                PressAction::Zoom => window.performZoom(None),
                PressAction::Minimize => window.performMiniaturize(None),
                PressAction::Nothing => {}
            }
        }
    }
);

impl Band {
    fn new(marker: MainThreadMarker) -> Retained<Self> {
        let band = Self::alloc(marker).set_ivars(());
        // Safety: `initWithFrame:` is the designated initializer of `NSView`.
        let band: Retained<Self> = unsafe { msg_send![super(band), initWithFrame: NSRect::ZERO] };

        band.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewMinYMargin,
        );

        band
    }
}

/// The full-screen state the board last heard.
#[derive(Default)]
struct LastFullScreen(AtomicBool);

impl LastFullScreen {
    /// Holds the new state, and returns whether it differs from the last one.
    fn replace(&self, full_screen: bool) -> bool {
        self.0.swap(full_screen, Ordering::SeqCst) != full_screen
    }
}

/// Managed once the band is in the window. A sync with no such state does
/// nothing.
struct Installed {
    band: MainThreadBound<Retained<Band>>,
    last_full_screen: LastFullScreen,
}

fn native<R: Runtime>(window: &WebviewWindow<R>) -> Option<Retained<NSWindow>> {
    let pointer = window.ns_window().ok()?;

    // Safety: on the main thread, `ns_window` gives the live `NSWindow` of the
    // webview window.
    unsafe { Retained::retain(pointer.cast::<NSWindow>()) }
}

fn title_bar_height(window: &NSWindow) -> f64 {
    window.frame().size.height - window.contentLayoutRect().size.height
}

fn measure(window: &NSWindow, full_screen: bool) -> TitleBarMetrics {
    let controls = window
        .standardWindowButton(NSWindowButton::ZoomButton)
        .map_or(DEFAULT_CONTROLS, |button| {
            let frame = button.convertRect_toView(button.bounds(), None);

            frame.origin.x + frame.size.width + CONTROLS_MARGIN
        });

    TitleBarMetrics {
        title_bar: title_bar_height(window),
        controls,
        full_screen,
        right_to_left: window.windowTitlebarLayoutDirection()
            == NSUserInterfaceLayoutDirection::RightToLeft,
    }
}

/// Adds the band above the webview. Called on the main thread, once the window
/// holds the parent view of the webview.
pub(crate) fn install(marker: MainThreadMarker, window: &WebviewWindow) {
    let Some(ns_window) = native(window) else {
        return;
    };
    let Some(parent) = ns_window.contentView() else {
        return;
    };
    let band = Band::new(marker);

    band.setFrame(band_frame(
        parent.bounds().size,
        title_bar_height(&ns_window),
    ));
    parent.addSubview_positioned_relativeTo(&band, NSWindowOrderingMode::Above, None);

    window.manage(Installed {
        band: MainThreadBound::new(band, marker),
        last_full_screen: LastFullScreen::default(),
    });
}

fn sync_on_main_thread<R: Runtime>(marker: MainThreadMarker, window: &WebviewWindow<R>) {
    let (Ok(full_screen), Some(ns_window)) = (window.is_fullscreen(), native(window)) else {
        return;
    };
    let installed = window.state::<Installed>();
    let band = installed.band.get(marker);
    let measured = measure(&ns_window, full_screen);

    installed.last_full_screen.replace(full_screen);
    band.setHidden(full_screen);

    if !full_screen && let Some(parent) = ns_window.contentView() {
        band.setFrame(band_frame(parent.bounds().size, measured.title_bar));
    }

    let scale = zoom::scale(window.state::<zoom::Level>().get());
    let _ = window.eval(script(lengths(measured, scale)));
}

/// Hides or shows the band and sets its frame, and gives the board the lengths
/// the window has now.
pub(crate) fn sync<R: Runtime>(window: &WebviewWindow<R>) {
    if window.try_state::<Installed>().is_none() {
        return;
    }

    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let marker = MainThreadMarker::new().expect("run_on_main_thread runs on the main thread");
        sync_on_main_thread(marker, &target);
    });
}

/// Syncs the band and the board when the window has entered or left full
/// screen. tao updates its state before it reports a size, at both ends of the
/// transition.
pub(crate) fn follow_full_screen<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(installed) = window.try_state::<Installed>() else {
        return;
    };

    if window
        .is_fullscreen()
        .is_ok_and(|full_screen| installed.last_full_screen.replace(full_screen))
    {
        sync(window);
    }
}

#[cfg(test)]
mod tests {
    use tauri::test::mock_app;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    use super::*;

    /// The stylesheet that gives both lengths their value in a browser.
    const THEME: &str = include_str!("../../web/src/styles/theme.css");

    const WINDOWED: TitleBarMetrics = TitleBarMetrics {
        title_bar: 28.0,
        controls: 64.0,
        full_screen: false,
        right_to_left: false,
    };

    fn pair(band: f64, controls: f64) -> Lengths {
        Lengths { band, controls }
    }

    #[test]
    fn the_zoom_scale_divides_both_lengths() {
        assert_eq!(lengths(WINDOWED, 1.0), pair(28.0, 64.0));
        assert_eq!(lengths(WINDOWED, 0.5), pair(56.0, 128.0));
        assert_eq!(lengths(WINDOWED, 2.0), pair(14.0, 32.0));
    }

    #[test]
    fn full_screen_has_no_band_and_no_controls() {
        let metrics = TitleBarMetrics {
            full_screen: true,
            ..WINDOWED
        };

        assert_eq!(lengths(metrics, 1.0), pair(0.0, 0.0));
    }

    #[test]
    fn right_to_left_keeps_the_band_and_takes_no_width_from_the_left() {
        let metrics = TitleBarMetrics {
            right_to_left: true,
            ..WINDOWED
        };

        assert_eq!(lengths(metrics, 1.0), pair(28.0, 0.0));
    }

    #[test]
    fn any_other_click_count_drags_and_reads_no_setting() {
        assert_eq!(press_action(1, || unreachable!()), PressAction::Drag);
        assert_eq!(press_action(3, || unreachable!()), PressAction::Drag);
    }

    #[test]
    fn a_double_click_does_what_the_setting_says() {
        let action = |setting: Option<&str>| press_action(2, || setting.map(str::to_owned));

        assert_eq!(action(Some("Maximize")), PressAction::Zoom);
        assert_eq!(action(Some("Fill")), PressAction::Zoom);
        assert_eq!(action(Some("Minimize")), PressAction::Minimize);
        assert_eq!(action(Some("None")), PressAction::Nothing);
        assert_eq!(action(None), PressAction::Zoom);
        assert_eq!(action(Some("Sample")), PressAction::Zoom);
    }

    #[test]
    fn reading_the_double_click_setting_does_not_panic() {
        double_click_setting();
    }

    #[test]
    fn the_script_writes_each_length_as_a_plain_decimal() {
        assert_eq!(
            script(pair(23.5, 0.000_000_1)),
            "document.documentElement.style.setProperty(\"--title-band\",\"23.5px\");\
             document.documentElement.style.setProperty(\"--title-controls\",\"0.0000001px\");"
        );
    }

    #[test]
    fn the_first_script_holds_the_default_lengths_for_the_held_zoom() {
        assert_eq!(first_script(1.0), script(pair(28.0, 64.0)));
        assert_eq!(first_script(0.5), script(pair(56.0, 128.0)));
    }

    #[test]
    fn a_browser_starts_both_lengths_at_zero() {
        assert!(THEME.contains(&format!("{BAND_PROPERTY}: 0px;")));
        assert!(THEME.contains(&format!("{CONTROLS_PROPERTY}: 0px;")));
    }

    #[test]
    fn the_band_spans_the_top_of_a_parent_that_counts_from_the_bottom() {
        let frame = band_frame(NSSize::new(1280.0, 800.0), 28.0);

        assert_eq!(frame.origin, NSPoint::new(0.0, 772.0));
        assert_eq!(frame.size, NSSize::new(1280.0, 28.0));
    }

    #[test]
    fn only_a_new_full_screen_state_counts_as_a_change() {
        let last = LastFullScreen::default();

        assert!(!last.replace(false));
        assert!(last.replace(true));
        assert!(!last.replace(true));
        assert!(last.replace(false));
    }

    #[test]
    fn a_window_with_no_band_syncs_without_a_panic() {
        let app = mock_app();
        let window = WebviewWindowBuilder::new(&app, crate::WINDOW, WebviewUrl::default())
            .build()
            .unwrap();

        sync(&window);
        follow_full_screen(&window);
    }
}
