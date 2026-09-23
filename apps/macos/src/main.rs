//! The macOS window the board runs in.
//!
//! The window is built here rather than declared in `tauri.conf.json`:
//! `on_document_title_changed` is a builder callback with no equivalent once the
//! window exists, and the URL is chosen at startup between the dev server and
//! the custom scheme, which a static configuration array cannot express.
//!
//! `WebviewWindowBuilder::new` inherits nothing from the configuration, so with
//! `app.windows` empty every property below is a builder call. A property
//! written as a configuration key instead is read by nothing.

mod alert;
mod command;
mod daemon;
mod deeplink;
mod elevate;
mod geometry;
mod log;
mod menu;
mod protocol;
mod record;
mod supervisor;
#[cfg(test)]
mod testing;
mod uninstall;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use tauri::utils::config::Color;
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, LogicalSize, Manager as _, RunEvent, Theme, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

/// The window's own origin.
///
/// A webview resolves its own scheme before macOS does, so a scheme registered
/// system-wide must not be spelled the same as this one: a link to it inside the
/// document would land in this handler, which serves no such host.
const SCHEME: &str = "tasma-app";
const HOST: &str = "localhost";

/// The scheme macOS hands the application a link under. `Info.plist` beside the
/// configuration registers it, and a repo test holds the two together.
const LINK_SCHEME: &str = "tasma";

/// The one window, and the label `capabilities/zoom.json` grants against.
const WINDOW: &str = "main";

/// Whether `Cmd+=`, `Cmd+-` and `Cmd+0` resize the board. A packaged window has
/// no browser chrome and macOS has no system text-size setting that scales web
/// content, so without them the board has no enlargement at all.
///
/// The flag alone delivers nothing. wry implements it on Windows only; on macOS
/// Tauri injects a script that invokes `plugin:webview|set_webview_zoom`, and an
/// invoke no capability grants is refused before the webview sees it.
/// `capabilities/zoom.json` is that grant, and a test holds the two together.
const ZOOM_HOTKEYS: bool = true;

/// Which of the two origins a development run opens.
#[cfg(debug_assertions)]
const DEV_SERVER: &str = "TASMA_DEV_SERVER";

/// The board's own page colour, held to `--palette-bg` in `apps/web` by a test
/// in this crate. The window carries it so a launch in dark mode shows no white
/// frame before the bundle paints.
const LIGHT_BACKGROUND: Color = Color(0xfa, 0xfa, 0xfb, 0xff);
const DARK_BACKGROUND: Color = Color(0x16, 0x18, 0x1c, 0xff);

/// Below this the sidebar collapses to its rail and the board columns scroll
/// sideways. Degraded but usable, so it is a comfort floor and not a break
/// point; two zoom steps on the default size reach the same region.
const MIN_WIDTH: f64 = 880.0;
const MIN_HEIGHT: f64 = 600.0;
const MINIMUM: LogicalSize<f64> = LogicalSize::new(MIN_WIDTH, MIN_HEIGHT);

/// The size a first launch opens at.
const DEFAULT_SIZE: LogicalSize<f64> = LogicalSize::new(1280.0, 800.0);

/// The document on the window's own origin.
fn document() -> WebviewUrl {
    WebviewUrl::CustomProtocol(
        format!("{SCHEME}://{HOST}/index.html")
            .parse()
            .expect("the scheme and the host spell a URL"),
    )
}

/// Where the window points.
///
/// The dev server's address is read from the configuration the Tauri CLI also
/// uses, so the two cannot drift. A configuration naming no dev server falls
/// through to the custom scheme.
#[cfg(debug_assertions)]
fn window_url(app: &tauri::App) -> WebviewUrl {
    if std::env::var_os(DEV_SERVER).is_some()
        && let Some(url) = app.config().build.dev_url.clone()
    {
        return WebviewUrl::External(url);
    }

    document()
}

/// A release build reads no variable, so whoever launches the app cannot point
/// the window at another origin.
#[cfg(not(debug_assertions))]
fn window_url(_app: &tauri::App) -> WebviewUrl {
    document()
}

/// Whether the window may navigate to a URL.
///
/// Tauri allows every URL by default, and this window has no address bar and
/// copies the document title into its title bar, so a document from anywhere
/// else would present as the application.
///
/// One hole: Tauri's glue allows a URL `url::Url::parse` rejects without
/// calling this at all. What a document *loads* is held by the `default-src
/// 'none'` meta policy instead, and neither control covers the other's ground.
fn may_navigate(url: &Url, dev_server: Option<&Url>) -> bool {
    if url.scheme() == SCHEME && url.host_str() == Some(HOST) {
        return true;
    }

    // An http origin, so the tuple comparison holds. The arm above is what the
    // custom scheme needs: its origin is opaque, and no two of those are equal.
    dev_server.is_some_and(|dev_server| dev_server.origin() == url.origin())
}

/// The colour behind the document, for the appearance the window reports.
fn background(theme: Option<Theme>) -> Color {
    if matches!(theme, Some(Theme::Dark)) {
        DARK_BACKGROUND
    } else {
        LIGHT_BACKGROUND
    }
}

fn push(window: &WebviewWindow, route: &str) {
    let _ = window.eval(deeplink::push_script(route));
}

/// Moves the board to the task the last accepted link names, or holds that
/// route until the document has loaded, and brings the window forward. A
/// refused link leaves the board where it is and is written to the log, the
/// only place a bundle's own output can be read.
fn open_links(app: &AppHandle, delivery: &Mutex<deeplink::Delivery>, urls: &[Url]) {
    let mut named = None;

    for url in urls {
        match deeplink::route(url) {
            Some(route) => named = Some(route),
            None => {
                let file = log::open(std::env::home_dir().as_deref()).ok();
                log::note(
                    file.as_ref(),
                    &format!("a link names no task: {}", log::quoted(url.as_str())),
                );
            }
        }
    }

    let due = named.and_then(|route| {
        delivery
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .arrive(route)
    });

    // Opened before the window was built, the route is held for its document.
    let Some(window) = app.get_webview_window(WINDOW) else {
        return;
    };

    if let Some(route) = due {
        push(&window, &route);
    }

    // `set_focus` does nothing to a minimized window.
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Links the command when this copy runs from an Applications folder and the
/// link is missing or stale. Only the password dialog appears; any other end
/// is one line in the log.
async fn check_the_command() {
    let Some(executable) = command::installed_executable(command::account_home().as_deref()) else {
        return;
    };

    let problem = match elevate::ensure_link(Path::new(command::LINK), executable).await {
        elevate::Linked::Already
        | elevate::Linked::Now
        | elevate::Linked::Cancelled
        | elevate::Linked::Busy => return,
        elevate::Linked::NotOurs => format!("{} does not belong to Tasma", command::LINK),
        elevate::Linked::Failed(line) => line,
    };

    let file = log::open(std::env::home_dir().as_deref()).ok();
    log::note(
        file.as_ref(),
        &format!(
            "the tasma command was not installed: {}",
            log::quoted(&problem)
        ),
    );
}

/// Whether an exit is held: closing the window during Uninstall must not end
/// the sequence. Only `app.exit` carries a code.
fn holds_exit(uninstalling: bool, code: Option<i32>) -> bool {
    uninstalling && code.is_none()
}

/// The frame to save as the application exits. None during Uninstall, which
/// has deleted the folder it would be written to.
fn exit_frame(
    uninstalling: bool,
    remembered: &Mutex<geometry::Tracker>,
    live: Option<geometry::Frame>,
) -> Option<geometry::Frame> {
    if uninstalling {
        return None;
    }

    remembered
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .finish(live, Instant::now())
}

fn main() {
    // Before Tauri and before any link is read: the process is a child the
    // application started for a step that needs administrator rights.
    if let Some(step) = elevate::requested(std::env::args_os().nth(1).as_deref()) {
        std::process::exit(elevate::run(step));
    }

    let daemon = Arc::new(daemon::Daemon::new());
    let startup = Arc::clone(&daemon);
    let uninstalling = Arc::new(AtomicBool::new(false));
    let shell = menu::Shell {
        daemon: Arc::clone(&daemon),
        uninstalling: Arc::clone(&uninstalling),
    };
    // The last windowed geometry: the close button destroys the window before
    // the application exits, and a zoomed window measures nothing.
    let remembered: Arc<Mutex<geometry::Tracker>> = Arc::default();
    let tracked = Arc::clone(&remembered);
    let delivery: Arc<Mutex<deeplink::Delivery>> = Arc::default();
    let loading = Arc::clone(&delivery);

    tauri::Builder::default()
        .manage(shell)
        .on_menu_event(|app, event| menu::dispatch(app, event.id()))
        // Asynchronous, so a daemon call never holds the main thread.
        .register_asynchronous_uri_scheme_protocol(SCHEME, move |context, request, responder| {
            let app = context.app_handle().clone();
            let daemon = Arc::clone(&daemon);

            tauri::async_runtime::spawn(async move {
                responder.respond(protocol::serve(&app, &daemon, request).await);
            });
        })
        .setup(move |app| {
            menu::build(app.handle())?;

            // On the runtime rather than here, so a spawn never holds the
            // window back. It leaves the daemon warm before the board's first
            // request, and the forward covers the case where it did not.
            tauri::async_runtime::spawn(async move {
                let _ = startup.ensure_serving().await;
            });

            let url = window_url(app);
            let dev_server = match &url {
                WebviewUrl::External(url) => Some(url.clone()),
                _ => None,
            };

            let work_areas = geometry::work_areas(app.handle())?;
            let opening = (!work_areas.is_empty()).then(|| match geometry::load(app.handle()) {
                Some(saved) => geometry::placement(saved, &work_areas, MINIMUM),
                None => geometry::default_placement(
                    DEFAULT_SIZE,
                    geometry::FIRST_RUN_CHROME,
                    &work_areas,
                    MINIMUM,
                ),
            });

            let builder = WebviewWindowBuilder::new(app, WINDOW, url)
                .title("Tasma")
                .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
                .zoom_hotkeys_enabled(ZOOM_HOTKEYS)
                // Tauri does not copy `document.title` into the native title
                // bar, so every screen would otherwise sit under a fixed name.
                .on_document_title_changed(|window, title| {
                    let _ = window.set_title(&title);
                })
                .on_navigation(move |url| may_navigate(url, dev_server.as_ref()))
                .on_page_load(move |window, payload| {
                    let mut delivery = loading.lock().unwrap_or_else(PoisonError::into_inner);
                    let route = match payload.event() {
                        PageLoadEvent::Started => {
                            delivery.started();
                            None
                        }
                        PageLoadEvent::Finished => delivery.finished(),
                    };
                    drop(delivery);

                    if let Some(route) = route {
                        push(&window, &route);
                    }
                })
                // Shown below, once it carries the background colour. The
                // appearance can only be read from a window, and a window shown
                // before it carries the colour is the white frame this avoids.
                .visible(false);
            let window = match opening {
                Some(frame) => builder
                    .inner_size(frame.width, frame.height)
                    .position(frame.x, frame.y),
                // No display is reported, so there is no work area to place in.
                None => builder
                    .inner_size(DEFAULT_SIZE.width, DEFAULT_SIZE.height)
                    .center(),
            }
            .build()?;

            window.set_background_color(Some(background(window.theme().ok())))?;
            window.on_window_event({
                let window = window.clone();
                move |event| match event {
                    // The frame is the shell's own surface, so no token the
                    // document carries follows a later change of appearance
                    // for it.
                    WindowEvent::ThemeChanged(theme) => {
                        let _ = window.set_background_color(Some(background(Some(*theme))));
                    }
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                        tracked
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .report(geometry::of(&window), Instant::now());
                    }
                    WindowEvent::CloseRequested { .. } => {
                        tracked
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .finish(geometry::of(&window), Instant::now());
                    }
                    _ => {}
                }
            });
            window.show()?;

            tauri::async_runtime::spawn(check_the_command());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the window could not be opened")
        .run(move |app, event| match event {
            // Its handler can write a log line, which would make the log
            // folder again after Uninstall deleted it.
            RunEvent::Opened { .. } if uninstalling.load(Ordering::SeqCst) => {}
            RunEvent::Opened { urls } => open_links(app, &delivery, &urls),
            RunEvent::ExitRequested { code, api, .. }
                if holds_exit(uninstalling.load(Ordering::SeqCst), code) =>
            {
                api.prevent_exit();
            }
            RunEvent::Exit => {
                let live = app
                    .get_webview_window(WINDOW)
                    .and_then(|window| geometry::of(&window));
                let frame = exit_frame(uninstalling.load(Ordering::SeqCst), &remembered, live);

                if let Some(frame) = frame
                    && let Err(error) = geometry::save(app, frame)
                {
                    eprintln!("tasma: the window geometry could not be saved: {error}");
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The stylesheet the two background constants stand for. Read at compile
    /// time, so a colour changed there and not here fails the build of the test.
    const THEME: &str = include_str!("../../web/src/styles/theme.css");

    fn hex(colour: &str) -> Color {
        let digits = colour
            .strip_prefix('#')
            .expect("a palette colour is written as hex");
        let byte = |at: usize| {
            u8::from_str_radix(&digits[at..at + 2], 16).expect("a colour is three hex bytes")
        };

        Color(byte(0), byte(2), byte(4), 0xff)
    }

    /// The light and the dark halves of `--palette-bg`.
    fn palette_background() -> (Color, Color) {
        let stated = THEME
            .lines()
            .find_map(|line| line.trim().strip_prefix("--palette-bg:"))
            .expect("the stylesheet states --palette-bg");
        let pair = stated
            .trim()
            .strip_prefix("light-dark(")
            .and_then(|rest| rest.split_once(')'))
            .expect("--palette-bg is a light-dark() pair")
            .0;
        let (light, dark) = pair
            .split_once(',')
            .expect("a light-dark() pair names two colours");

        (hex(light.trim()), hex(dark.trim()))
    }

    #[test]
    fn the_frame_carries_the_board_page_colour() {
        assert_eq!(palette_background(), (LIGHT_BACKGROUND, DARK_BACKGROUND));
    }

    #[test]
    fn the_appearance_decides_the_colour() {
        assert_eq!(background(Some(Theme::Dark)), DARK_BACKGROUND);
        assert_eq!(background(Some(Theme::Light)), LIGHT_BACKGROUND);
        // A window that reports no appearance at all.
        assert_eq!(background(None), LIGHT_BACKGROUND);
    }

    /// The capability the injected zoom script needs granted. Read at compile
    /// time, so a capability moved or renamed fails the build of the test.
    const ZOOM_CAPABILITY: &str = include_str!("../capabilities/zoom.json");

    /// The command `scripts/zoom-hotkey.js` invokes, as its permission is
    /// spelled in the access list.
    const ZOOM_PERMISSION: &str = "core:webview:allow-set-webview-zoom";

    /// Whether the capability grants this window the zoom command.
    fn zoom_is_granted() -> bool {
        let capability: serde_json::Value =
            serde_json::from_str(ZOOM_CAPABILITY).expect("a capability is JSON");
        let names = |key: &str, wanted: &str| {
            capability[key]
                .as_array()
                .expect("a capability states its windows and its permissions")
                .iter()
                .any(|value| value == wanted)
        };

        names("windows", WINDOW) && names("permissions", ZOOM_PERMISSION)
    }

    #[test]
    fn the_zoom_shortcuts_are_granted_the_command_they_invoke() {
        assert_eq!(ZOOM_HOTKEYS, zoom_is_granted());
    }

    #[test]
    fn uninstall_holds_every_exit_but_its_own() {
        assert!(holds_exit(true, None));
        assert!(!holds_exit(true, Some(0)));
        assert!(!holds_exit(false, None));
        assert!(!holds_exit(false, Some(0)));
    }

    #[test]
    fn the_geometry_is_not_saved_during_uninstall() {
        let frame = geometry::Frame {
            x: 10.0,
            y: 20.0,
            width: 900.0,
            height: 700.0,
            chrome: 0.0,
        };
        let remembered = Mutex::new(geometry::Tracker::default());

        assert_eq!(exit_frame(true, &remembered, Some(frame)), None);
        assert_eq!(exit_frame(false, &remembered, Some(frame)), Some(frame));
    }

    fn url(text: &str) -> Url {
        text.parse().unwrap()
    }

    #[test]
    fn the_window_navigates_its_own_origin() {
        assert!(may_navigate(&url("tasma-app://localhost/index.html"), None));
        assert!(may_navigate(
            &url("tasma-app://localhost/assets/index.css"),
            None
        ));
    }

    #[test]
    fn the_window_navigates_nowhere_else() {
        assert!(!may_navigate(&url("https://example.invalid/"), None));
        assert!(!may_navigate(&url("file:///etc/passwd"), None));
        assert!(!may_navigate(
            &url("tasma-app://elsewhere/index.html"),
            None
        ));
        assert!(!may_navigate(&url("http://localhost/index.html"), None));
    }

    #[test]
    fn a_development_run_also_navigates_its_dev_server() {
        let dev_server = url("http://127.0.0.1:8276");

        assert!(may_navigate(
            &url("http://127.0.0.1:8276/index.html"),
            Some(&dev_server)
        ));
        assert!(!may_navigate(
            &url("http://127.0.0.1:9999/"),
            Some(&dev_server)
        ));
        assert!(!may_navigate(
            &url("https://example.invalid/"),
            Some(&dev_server)
        ));
    }
}
