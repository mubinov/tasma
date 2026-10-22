//! The zoom level of the board, which the zoom items of the View menu change.
//!
//! The window has no browser controls, and macOS has no system text-size
//! setting that scales web content, so zoom is the only way to enlarge the
//! board.

use std::sync::{Mutex, PoisonError};

use tauri::{AppHandle, Manager as _, Runtime, WebviewWindow};

use crate::{WINDOW, log, menu};

const ACTUAL_SIZE: u16 = 100;
const STEP: u16 = 20;
const SMALLEST: u16 = 20;
const LARGEST: u16 = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Change {
    ActualSize,
    In,
    Out,
}

/// The level the window shows, in whole percents so that no float error
/// collects over many steps. Tauri can set the zoom of a webview but cannot
/// read it, so this is the only record of it.
pub(crate) struct Level(Mutex<u16>);

impl Default for Level {
    fn default() -> Self {
        Self(Mutex::new(ACTUAL_SIZE))
    }
}

impl Level {
    pub(crate) fn get(&self) -> u16 {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Gives the next level to `set` as a scale, and holds that level only when
    /// `set` succeeds.
    fn apply<E>(&self, change: Change, set: impl FnOnce(f64) -> Result<(), E>) -> Result<u16, E> {
        let mut level = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let wanted = next(*level, change);

        set(scale(wanted))?;
        *level = wanted;

        Ok(wanted)
    }
}

fn next(level: u16, change: Change) -> u16 {
    match change {
        Change::ActualSize => ACTUAL_SIZE,
        Change::In => level.saturating_add(STEP).min(LARGEST),
        Change::Out => level.saturating_sub(STEP).max(SMALLEST),
    }
}

/// Which zoom items are enabled: (actual size, zoom in, zoom out).
pub(crate) fn enabled(level: u16) -> (bool, bool, bool) {
    (level != ACTUAL_SIZE, level < LARGEST, level > SMALLEST)
}

fn scale(level: u16) -> f64 {
    f64::from(level) / 100.0
}

pub(crate) fn change<R: Runtime>(app: &AppHandle<R>, change: Change) {
    // The window is missing only after Uninstall destroyed it, and a log line
    // then would make the log folder again.
    let Some(window) = app.get_webview_window(WINDOW) else {
        return;
    };

    match app
        .state::<Level>()
        .apply(change, |scale| window.set_zoom(scale))
    {
        Ok(level) => menu::show_zoom(app, level),
        Err(error) => note(&error),
    }
}

/// Sets the held level on the window again. A page load must never leave the
/// window at a zoom other than the one the menu shows.
pub(crate) fn restore<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(error) = window.set_zoom(scale(window.state::<Level>().get())) {
        note(&error);
    }
}

fn note(error: &tauri::Error) {
    let file = log::open(std::env::home_dir().as_deref()).ok();
    log::note(
        file.as_ref(),
        &format!(
            "the zoom could not be set: {}",
            log::quoted(&error.to_string())
        ),
    );
}

#[cfg(test)]
mod tests {
    use tauri::test::{MockRuntime, mock_app};
    use tauri::{App, WebviewUrl, WebviewWindowBuilder};

    use super::*;

    fn app_with_level() -> App<MockRuntime> {
        let app = mock_app();
        app.manage(Level::default());
        app
    }

    fn window_of(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
        WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::default())
            .build()
            .unwrap()
    }

    #[test]
    fn a_step_is_twenty_percent() {
        assert_eq!(next(100, Change::In), 120);
        assert_eq!(next(100, Change::Out), 80);
    }

    #[test]
    fn actual_size_is_one_hundred_percent_from_any_level() {
        for level in [SMALLEST, 80, ACTUAL_SIZE, 140, LARGEST] {
            assert_eq!(next(level, Change::ActualSize), ACTUAL_SIZE);
        }
    }

    #[test]
    fn a_step_stops_at_the_limits() {
        assert_eq!(next(LARGEST, Change::In), LARGEST);
        assert_eq!(next(SMALLEST, Change::Out), SMALLEST);
    }

    #[test]
    fn an_item_is_disabled_where_it_would_change_nothing() {
        assert_eq!(enabled(ACTUAL_SIZE), (false, true, true));
        assert_eq!(enabled(SMALLEST), (true, true, false));
        assert_eq!(enabled(LARGEST), (true, false, true));
        assert_eq!(enabled(140), (true, true, true));
    }

    #[test]
    fn the_window_starts_at_actual_size() {
        assert_eq!(Level::default().get(), ACTUAL_SIZE);
    }

    #[test]
    fn a_level_the_window_takes_is_held() {
        let level = Level::default();
        let mut given = None;

        let applied = level.apply(Change::In, |scale| {
            given = Some(scale);
            Ok::<(), ()>(())
        });

        assert_eq!(applied, Ok(120));
        assert_eq!(given, Some(1.2));
        assert_eq!(level.get(), 120);
    }

    #[test]
    fn a_level_the_window_refuses_is_not_held() {
        let level = Level::default();

        assert_eq!(level.apply(Change::Out, |_| Err("refused")), Err("refused"));
        assert_eq!(level.get(), ACTUAL_SIZE);
    }

    #[test]
    fn a_change_with_no_window_keeps_the_level() {
        let app = app_with_level();

        change(app.handle(), Change::In);

        assert_eq!(app.state::<Level>().get(), ACTUAL_SIZE);
    }

    #[test]
    fn a_change_the_window_takes_is_held() {
        let app = app_with_level();
        window_of(&app);

        change(app.handle(), Change::In);

        assert_eq!(app.state::<Level>().get(), 120);
    }

    #[test]
    fn a_page_load_keeps_the_held_level() {
        let app = app_with_level();
        let window = window_of(&app);
        change(app.handle(), Change::In);

        restore(&window);

        assert_eq!(app.state::<Level>().get(), 120);
    }
}
