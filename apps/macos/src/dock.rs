//! The Dock icon: the state of the agents, in the image set of the appearance.

use std::sync::{Mutex, MutexGuard, PoisonError};

use objc2::{AnyThread as _, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage};
use objc2_foundation::NSData;
use tauri::http::{Method, Response, StatusCode};
use tauri::{AppHandle, Manager as _, Runtime, Theme};

use crate::log;
use crate::update::plain;

/// The route under `/app`. Held to `DOCK_ROUTE` in `apps/web` by a repo test.
pub(crate) const PATH: &str = "/dock";

// The path segments under `PATH`. Held to `AgentState` by a repo test.
const OFF: &str = "off";
const RUNNING: &str = "running";
const NEEDS_YOU: &str = "needs-you";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum State {
    #[default]
    Off,
    Running,
    NeedsYou,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Style {
    #[default]
    Default,
    Dark,
}

impl Style {
    fn of(theme: Option<Theme>) -> Self {
        if matches!(theme, Some(Theme::Dark)) {
            Self::Dark
        } else {
            Self::Default
        }
    }
}

fn image(state: State, style: Style) -> &'static [u8] {
    match (style, state) {
        (Style::Default, State::Off) => include_bytes!("../dock/default/tasma-off.png"),
        (Style::Default, State::Running) => include_bytes!("../dock/default/tasma-running.png"),
        (Style::Default, State::NeedsYou) => include_bytes!("../dock/default/tasma-needs-you.png"),
        (Style::Dark, State::Off) => include_bytes!("../dock/dark/tasma-off.png"),
        (Style::Dark, State::Running) => include_bytes!("../dock/dark/tasma-running.png"),
        (Style::Dark, State::NeedsYou) => include_bytes!("../dock/dark/tasma-needs-you.png"),
    }
}

#[derive(Default)]
struct Shown {
    state: State,
    style: Style,
    applied: Option<(State, Style)>,
}

impl Shown {
    /// The image to apply, or `None` when the Dock already shows the pair.
    fn change(&mut self) -> Option<&'static [u8]> {
        let current = (self.state, self.style);

        if self.applied == Some(current) {
            return None;
        }

        self.applied = Some(current);

        Some(image(self.state, self.style))
    }
}

#[derive(Default)]
pub(crate) struct Dock(Mutex<Shown>);

impl Dock {
    fn lock(&self) -> MutexGuard<'_, Shown> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn apply<R: Runtime>(app: &AppHandle<R>) {
    let Some(bytes) = app.state::<Dock>().lock().change() else {
        return;
    };

    let marker = MainThreadMarker::new().expect("run_on_main_thread runs on the main thread");

    let Some(image) = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes)) else {
        let file = log::open(std::env::home_dir().as_deref()).ok();
        log::note(file.as_ref(), "a Dock image could not be read");
        return;
    };

    // Safety: only `None` may be refused, and this is always `Some`.
    unsafe {
        NSApplication::sharedApplication(marker).setApplicationIconImage(Some(&image));
    }
}

/// The lock is released before the main thread is reached: from the main thread
/// the task runs at once and takes the lock itself.
fn update_and_apply<R: Runtime>(app: &AppHandle<R>, update: impl FnOnce(&mut Shown)) {
    update(&mut app.state::<Dock>().lock());

    let handle = app.clone();
    let _ = app.run_on_main_thread(move || apply(&handle));
}

pub(crate) fn show<R: Runtime>(app: &AppHandle<R>, state: State) {
    update_and_apply(app, |shown| shown.state = state);
}

pub(crate) fn restyle<R: Runtime>(app: &AppHandle<R>, theme: Option<Theme>) {
    update_and_apply(app, |shown| shown.style = Style::of(theme));
}

pub(crate) fn handles(path: &str) -> bool {
    path.strip_prefix(PATH)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn requested(method: &Method, path: &str) -> Result<State, StatusCode> {
    let state = match path
        .strip_prefix(PATH)
        .and_then(|rest| rest.strip_prefix('/'))
    {
        Some(OFF) => State::Off,
        Some(RUNNING) => State::Running,
        Some(NEEDS_YOU) => State::NeedsYou,
        _ => return Err(StatusCode::NOT_FOUND),
    };

    if *method == Method::POST {
        Ok(state)
    } else {
        Err(StatusCode::METHOD_NOT_ALLOWED)
    }
}

/// `POST /app/dock/<state>`. The answer does not wait for the main thread.
pub(crate) fn serve<R: Runtime>(
    app: &AppHandle<R>,
    method: &Method,
    path: &str,
) -> Response<Vec<u8>> {
    match requested(method, path) {
        Ok(state) => {
            show(app, state);
            plain(StatusCode::ACCEPTED)
        }
        Err(status) => plain(status),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashSet;

    use tauri::App;
    use tauri::test::{MockRuntime, mock_app};

    const STATES: [State; 3] = [State::Off, State::Running, State::NeedsYou];
    const STYLES: [Style; 2] = [Style::Default, Style::Dark];
    const PATHS: [&str; 3] = ["/dock/off", "/dock/running", "/dock/needs-you"];

    fn pairs() -> impl Iterator<Item = (State, Style)> {
        STATES
            .into_iter()
            .flat_map(|state| STYLES.into_iter().map(move |style| (state, style)))
    }

    #[test]
    fn a_post_names_one_of_the_three_states() {
        for (path, state) in PATHS.into_iter().zip(STATES) {
            assert_eq!(requested(&Method::POST, path), Ok(state), "{path}");
        }
    }

    #[test]
    fn another_method_on_a_state_is_not_allowed() {
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
            "/dock",
            "/dock/",
            "/dock/paused",
            "/dock/Running",
            "/dock/running/more",
        ] {
            assert_eq!(
                requested(&Method::POST, path),
                Err(StatusCode::NOT_FOUND),
                "{path}"
            );
        }

        assert_eq!(
            requested(&Method::GET, "/dock/paused"),
            Err(StatusCode::NOT_FOUND)
        );
    }

    #[test]
    fn the_route_is_a_whole_segment() {
        assert!(handles("/dock"));
        assert!(handles("/dock/running"));
        assert!(!handles("/dockyard"));
        assert!(!handles("/folder"));
    }

    #[test]
    fn the_appearance_decides_the_image_set() {
        assert_eq!(Style::of(Some(Theme::Dark)), Style::Dark);
        assert_eq!(Style::of(Some(Theme::Light)), Style::Default);
        assert_eq!(Style::of(None), Style::Default);
    }

    #[test]
    fn each_pair_has_an_image_of_its_own() {
        let images: HashSet<&[u8]> = pairs().map(|(state, style)| image(state, style)).collect();

        assert_eq!(images.len(), STATES.len() * STYLES.len());
    }

    #[test]
    fn each_image_is_a_square_png_of_1024() {
        let side = 1024_u32.to_be_bytes();

        for (state, style) in pairs() {
            let bytes = image(state, style);

            assert!(
                bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                "{state:?} {style:?}"
            );
            assert_eq!(&bytes[12..16], b"IHDR", "{state:?} {style:?}");
            assert_eq!(bytes[16..20], side, "{state:?} {style:?}");
            assert_eq!(bytes[20..24], side, "{state:?} {style:?}");
        }
    }

    #[test]
    fn the_first_change_gives_the_off_image_of_the_default_set() {
        assert_eq!(
            Shown::default().change(),
            Some(image(State::Off, Style::Default))
        );
    }

    #[test]
    fn the_same_pair_gives_nothing() {
        let mut shown = Shown::default();

        shown.change();

        assert_eq!(shown.change(), None);
    }

    #[test]
    fn a_new_state_gives_its_image() {
        let mut shown = Shown::default();

        shown.change();
        shown.state = State::NeedsYou;

        assert_eq!(shown.change(), Some(image(State::NeedsYou, Style::Default)));
        assert_eq!(shown.change(), None);
    }

    #[test]
    fn a_new_style_gives_its_image() {
        let mut shown = Shown::default();

        shown.change();
        shown.style = Style::Dark;

        assert_eq!(shown.change(), Some(image(State::Off, Style::Dark)));
        assert_eq!(shown.change(), None);
    }

    /// A call that names the applied pair makes `Shown::change` stop the task
    /// on the mock runtime before it reaches AppKit.
    fn app_wanting(wanted: (State, Style), applied: (State, Style)) -> App<MockRuntime> {
        let app = mock_app();

        app.manage(Dock(Mutex::new(Shown {
            state: wanted.0,
            style: wanted.1,
            applied: Some(applied),
        })));

        app
    }

    #[test]
    fn a_post_stores_its_state_and_answers_with_nothing() {
        let app = app_wanting(
            (State::Off, Style::Default),
            (State::Running, Style::Default),
        );

        let answer = serve(app.handle(), &Method::POST, "/dock/running");

        assert_eq!(answer.status(), StatusCode::ACCEPTED);
        assert!(answer.body().is_empty());
        assert_eq!(app.state::<Dock>().0.lock().unwrap().state, State::Running);
    }

    #[test]
    fn a_refused_request_answers_its_status() {
        let app = mock_app();

        assert_eq!(
            serve(app.handle(), &Method::POST, "/dock/paused").status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn a_change_of_appearance_stores_its_style() {
        let app = app_wanting((State::Off, Style::Default), (State::Off, Style::Dark));

        restyle(app.handle(), Some(Theme::Dark));

        let dock = app.state::<Dock>();
        let shown = dock.0.lock().unwrap();

        assert_eq!(shown.style, Style::Dark);
        assert_eq!(shown.applied, Some((State::Off, Style::Dark)));
    }

    #[test]
    fn a_change_back_before_it_is_applied_gives_nothing() {
        let mut shown = Shown::default();

        shown.change();
        shown.state = State::Running;
        shown.state = State::Off;

        assert_eq!(shown.change(), None);
    }
}
