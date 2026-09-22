//! The window geometry that outlives a quit, and where the window opens.
//!
//! The geometry is decided before the window exists and handed to the builder.
//! On macOS a built window cannot be corrected in the same call stack: its
//! setters are queued on the main thread while its getters read the frame at
//! once.

use std::io::{Read as _, Write as _};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, LogicalSize, Manager as _, PhysicalPosition, PhysicalRect, PhysicalSize, Runtime,
    WebviewWindow,
};

/// The record, under the application's configuration directory.
const FILE: &str = "window.json";

/// The name a save writes to before it renames the file onto `FILE`.
const PENDING: &str = "window.json.pending";

/// How much of the record is read. A record is a few dozen bytes, and the
/// directory it stands in is writable by any process of the account.
const LIMIT: u64 = 4096;

/// How long a frame stands before it counts. A zoom reports each step of its
/// animation a few milliseconds after the last.
const SETTLE: Duration = Duration::from_millis(250);

/// The window geometry, in points. Every display shares one space of points,
/// while a pixel is half the distance on a display twice as dense.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub(crate) struct Frame {
    /// The top-left of the frame, as `outer_position` answers it and the
    /// builder takes it.
    pub(crate) x: f64,
    pub(crate) y: f64,
    /// The size of the content, as the builder takes it.
    pub(crate) width: f64,
    pub(crate) height: f64,
    /// How much taller the frame is than the content: a work area bounds the
    /// frame, and the builder takes the content. Zero under the default title
    /// bar style, which draws the content under the title bar.
    pub(crate) chrome: f64,
}

impl Frame {
    /// The whole window.
    fn outer(self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height + self.chrome,
        }
    }

    fn from_outer(outer: Rect, chrome: f64) -> Self {
        Self {
            x: outer.x,
            y: outer.y,
            width: outer.width,
            height: outer.height - chrome,
            chrome,
        }
    }
}

/// A rectangle in points.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Rect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// The `chrome` a first launch places with, before a window exists to measure
/// one. The window keeps the default title bar style, so its content fills the
/// frame. A style that sets the title bar above the content needs that height
/// here.
pub(crate) const FIRST_RUN_CHROME: f64 = 0.0;

/// The remembered frame, or nothing.
pub(crate) fn load<R: Runtime>(app: &AppHandle<R>) -> Option<Frame> {
    read(&app.path().app_config_dir().ok()?)
}

/// Writes the frame, replacing whatever was there.
pub(crate) fn save<R: Runtime>(app: &AppHandle<R>, frame: Frame) -> tauri::Result<()> {
    write(&app.path().app_config_dir()?, frame)
}

/// The record in a directory. A missing, malformed or oversized one is
/// nothing, and so is a name that holds no regular file: `O_NOFOLLOW` refuses a
/// link, and `O_NONBLOCK` opens a pipe without waiting for a writer.
fn read(directory: &Path) -> Option<Frame> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(directory.join(FILE))
        .ok()?;

    if !file.metadata().ok()?.is_file() {
        return None;
    }

    let mut text = String::new();

    // One byte past the limit, so a read that fills it states a larger file.
    if file.take(LIMIT + 1).read_to_string(&mut text).ok()? as u64 > LIMIT {
        return None;
    }

    let frame: Frame = serde_json::from_str(&text).ok()?;

    // A negative value would let the content grow past the work area.
    Some(Frame {
        chrome: frame.chrome.max(0.0),
        ..frame
    })
}

/// Writes the record to `PENDING` and renames it onto `FILE`. The rename
/// replaces a link at `FILE` rather than writing through it.
fn write(directory: &Path, frame: Frame) -> tauri::Result<()> {
    std::fs::create_dir_all(directory)?;

    let pending = directory.join(PENDING);

    // Removes a link or a file left at the name. `create_new` then refuses
    // anything that stands there again, so it is never written through.
    let _ = std::fs::remove_file(&pending);

    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending)?
        .write_all(serde_json::to_string(&frame)?.as_bytes())?;
    std::fs::rename(&pending, directory.join(FILE))?;

    Ok(())
}

/// The frame of a live window, or nothing for a zoomed, minimised or
/// full-screen one: that is not where the user put it.
pub(crate) fn of<R: Runtime>(window: &WebviewWindow<R>) -> Option<Frame> {
    if window.is_maximized().ok()? || window.is_minimized().ok()? || window.is_fullscreen().ok()? {
        return None;
    }

    Some(measured(
        window.outer_position().ok()?,
        window.inner_size().ok()?,
        window.outer_size().ok()?,
        window.scale_factor().ok()?,
    ))
}

/// A frame from a window's own readings, in its own scale factor.
fn measured(
    position: PhysicalPosition<i32>,
    content: PhysicalSize<u32>,
    outer: PhysicalSize<u32>,
    scale: f64,
) -> Frame {
    let position = position.to_logical::<f64>(scale);
    let content = content.to_logical::<f64>(scale);
    let outer = outer.to_logical::<f64>(scale);

    Frame {
        x: position.x,
        y: position.y,
        width: content.width,
        height: content.height,
        chrome: outer.height - content.height,
    }
}

/// The last frame of the session to remember.
///
/// A zoom animation reports each of its steps, and `of` measures every step
/// before the last, which is not yet zoomed. So a frame counts only once no
/// other has followed it for `SETTLE`, and one that has not yet counted is
/// dropped when the window stops measuring.
#[derive(Default)]
pub(crate) struct Tracker {
    settled: Option<Frame>,
    latest: Option<(Frame, Instant)>,
}

impl Tracker {
    /// The window moved or resized to `frame`, or to a frame `of` does not
    /// measure.
    pub(crate) fn report(&mut self, frame: Option<Frame>, at: Instant) {
        self.settle(at);
        self.latest = frame.map(|frame| (frame, at));
    }

    /// The frame to remember as the session ends. A frame the window still
    /// measures counts at once.
    pub(crate) fn finish(&mut self, frame: Option<Frame>, at: Instant) -> Option<Frame> {
        match frame {
            Some(frame) => {
                self.settled = Some(frame);
                self.latest = None;
            }
            None => self.settle(at),
        }

        self.settled
    }

    fn settle(&mut self, at: Instant) {
        if let Some((frame, since)) = self.latest
            && at.duration_since(since) >= SETTLE
        {
            self.settled = Some(frame);
        }
    }
}

/// The work area of every display present, the primary first.
pub(crate) fn work_areas<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Vec<Rect>> {
    let primary = app.primary_monitor()?;
    let all = app.available_monitors()?;

    Ok(distinct(primary.iter().chain(&all).map(|monitor| {
        points(monitor.work_area(), monitor.scale_factor())
    })))
}

/// A work area in points. Divided by its own monitor's scale factor, it is
/// back in the global space of points that every display shares.
fn points(area: &PhysicalRect<i32, u32>, scale: f64) -> Rect {
    let position = area.position.to_logical::<f64>(scale);
    let size = area.size.to_logical::<f64>(scale);

    Rect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    }
}

/// The work areas in order, each once: the primary is also in the list of all.
fn distinct(areas: impl IntoIterator<Item = Rect>) -> Vec<Rect> {
    let mut distinct = Vec::new();

    for area in areas {
        if !distinct.contains(&area) {
            distinct.push(area);
        }
    }

    distinct
}

/// Where a remembered window opens. `work_areas` holds the primary first and
/// is not empty.
///
/// The title bar always lands inside a work area: macOS offers no way to drag
/// a window whose title bar is off screen.
pub(crate) fn placement(saved: Frame, work_areas: &[Rect], minimum: LogicalSize<f64>) -> Frame {
    debug_assert!(!work_areas.is_empty(), "a placement needs a display");

    let outer = saved.outer();
    let area = display(outer, work_areas);
    let size = bound(
        LogicalSize::new(outer.width, outer.height),
        area,
        outer_size(minimum, saved.chrome),
    );
    let kept = Rect {
        width: size.width,
        height: size.height,
        ..outer
    };
    let placed = if fits(kept, area) {
        kept
    } else {
        centred(size, area)
    };

    Frame::from_outer(placed, saved.chrome)
}

/// Where the window opens when nothing is remembered: the default size,
/// centred on the primary display and bounded as a remembered frame is.
pub(crate) fn default_placement(
    default: LogicalSize<f64>,
    chrome: f64,
    work_areas: &[Rect],
    minimum: LogicalSize<f64>,
) -> Frame {
    debug_assert!(!work_areas.is_empty(), "a placement needs a display");

    let area = work_areas[0];
    let size = bound(
        outer_size(default, chrome),
        area,
        outer_size(minimum, chrome),
    );

    Frame::from_outer(centred(size, area), chrome)
}

/// The size of the whole window around a content size.
fn outer_size(content: LogicalSize<f64>, chrome: f64) -> LogicalSize<f64> {
    LogicalSize::new(content.width, content.height + chrome)
}

/// The work area holding most of the window, or the primary when none holds
/// any of it.
fn display(outer: Rect, work_areas: &[Rect]) -> Rect {
    let mut chosen = work_areas[0];
    let mut most = 0.0;

    for area in work_areas {
        let shared = overlap(outer, *area);

        if shared > most {
            chosen = *area;
            most = shared;
        }
    }

    chosen
}

fn overlap(a: Rect, b: Rect) -> f64 {
    let width = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let height = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);

    width.max(0.0) * height.max(0.0)
}

/// A window size within the work area, and never below the floor: the floor
/// wins on a work area smaller than it.
fn bound(size: LogicalSize<f64>, area: Rect, floor: LogicalSize<f64>) -> LogicalSize<f64> {
    LogicalSize::new(
        size.width.min(area.width).max(floor.width),
        size.height.min(area.height).max(floor.height),
    )
}

fn fits(outer: Rect, area: Rect) -> bool {
    outer.x >= area.x
        && outer.y >= area.y
        && outer.x + outer.width <= area.x + area.width
        && outer.y + outer.height <= area.y + area.height
}

/// A window of this size centred in the work area. A window larger than the
/// work area takes its top-left corner, so the title bar stays on screen.
fn centred(size: LogicalSize<f64>, area: Rect) -> Rect {
    let x = area.x + (area.width - size.width) / 2.0;
    let y = area.y + (area.height - size.height) / 2.0;

    // `min` then `max`, never `clamp`: for a frame larger than the work area
    // the upper bound falls below the lower one, and `clamp` panics there.
    Rect {
        x: x.min(area.x + area.width - size.width).max(area.x),
        y: y.min(area.y + area.height - size.height).max(area.y),
        width: size.width,
        height: size.height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{directory, temp_file};

    const CHROME: f64 = 28.0;
    const MINIMUM: LogicalSize<f64> = LogicalSize::new(400.0, 300.0);
    const DEFAULT_SIZE: LogicalSize<f64> = LogicalSize::new(1280.0, 800.0);

    fn after(start: Instant, milliseconds: u64) -> Instant {
        start + Duration::from_millis(milliseconds)
    }

    fn frame(x: f64, y: f64, width: f64, height: f64) -> Frame {
        Frame {
            x,
            y,
            width,
            height,
            chrome: CHROME,
        }
    }

    fn area(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    /// A display with a menu bar above its work area and a Dock below it.
    fn laptop() -> Rect {
        area(0.0, 25.0, 1440.0, 800.0)
    }

    #[test]
    fn a_frame_that_fits_keeps_its_place() {
        let saved = frame(100.0, 100.0, 800.0, 500.0);

        assert_eq!(placement(saved, &[laptop()], MINIMUM), saved);
    }

    #[test]
    fn a_frame_flush_against_the_edges_keeps_its_place() {
        let top_left = frame(0.0, 25.0, 800.0, 500.0);
        let bottom_right = frame(640.0, 297.0, 800.0, 500.0);

        assert_eq!(placement(top_left, &[laptop()], MINIMUM), top_left);
        assert_eq!(placement(bottom_right, &[laptop()], MINIMUM), bottom_right);
    }

    #[test]
    fn a_frame_wider_than_its_work_area_is_bounded_and_centred() {
        let saved = frame(100.0, 100.0, 2000.0, 400.0);

        assert_eq!(
            placement(saved, &[laptop()], MINIMUM),
            frame(0.0, 211.0, 1440.0, 400.0),
        );
    }

    #[test]
    fn a_frame_taller_than_its_work_area_is_bounded_and_centred() {
        let saved = frame(100.0, 100.0, 600.0, 1000.0);

        assert_eq!(
            placement(saved, &[laptop()], MINIMUM),
            frame(420.0, 25.0, 600.0, 772.0),
        );
    }

    #[test]
    fn a_frame_below_the_comfort_floor_is_raised_to_it() {
        let saved = frame(100.0, 100.0, 200.0, 100.0);

        assert_eq!(
            placement(saved, &[laptop()], MINIMUM),
            frame(100.0, 100.0, 400.0, 300.0),
        );
    }

    #[test]
    fn a_work_area_shorter_than_the_floor_takes_the_frame_at_its_top() {
        let short = area(0.0, 25.0, 1440.0, 250.0);
        let saved = frame(100.0, 100.0, 600.0, 400.0);

        assert_eq!(
            placement(saved, &[short], MINIMUM),
            frame(420.0, 25.0, 600.0, 300.0),
        );
    }

    #[test]
    fn a_work_area_narrower_than_the_floor_takes_the_frame_at_its_left_edge() {
        let narrow = area(0.0, 25.0, 300.0, 800.0);
        let saved = frame(50.0, 100.0, 600.0, 400.0);

        assert_eq!(
            placement(saved, &[narrow], MINIMUM),
            frame(0.0, 211.0, 400.0, 400.0),
        );
    }

    #[test]
    fn the_content_is_bounded_by_the_work_area_less_the_title_bar() {
        let saved = frame(0.0, 25.0, 800.0, 800.0);

        let placed = placement(saved, &[laptop()], MINIMUM);

        assert_eq!(placed.height, laptop().height - CHROME);
    }

    #[test]
    fn a_frame_above_its_work_area_is_centred_in_it() {
        let saved = frame(100.0, -400.0, 800.0, 500.0);

        assert_eq!(
            placement(saved, &[laptop()], MINIMUM),
            frame(320.0, 161.0, 800.0, 500.0),
        );
    }

    #[test]
    fn a_title_bar_taller_than_the_work_area_keeps_the_frame_at_its_top() {
        let saved = Frame {
            chrome: 5000.0,
            ..frame(100.0, 100.0, 800.0, 500.0)
        };

        assert_eq!(
            placement(saved, &[laptop()], MINIMUM),
            Frame {
                chrome: 5000.0,
                ..frame(320.0, 25.0, 800.0, 300.0)
            },
        );
    }

    #[test]
    fn the_display_holding_most_of_the_frame_is_chosen() {
        let external = area(1440.0, 0.0, 1920.0, 1080.0);
        let saved = frame(1300.0, 100.0, 800.0, 500.0);

        assert_eq!(
            placement(saved, &[laptop(), external], MINIMUM),
            frame(2000.0, 276.0, 800.0, 500.0),
        );
    }

    #[test]
    fn a_frame_on_a_display_now_gone_opens_centred_on_the_primary() {
        let external = area(1440.0, 0.0, 1920.0, 1080.0);
        let saved = frame(-2000.0, 100.0, 800.0, 500.0);

        assert_eq!(
            placement(saved, &[laptop(), external], MINIMUM),
            frame(320.0, 161.0, 800.0, 500.0),
        );
    }

    #[test]
    fn a_frame_that_fits_only_without_its_title_bar_is_centred() {
        let saved = frame(100.0, 325.0, 800.0, 490.0);

        assert_eq!(
            placement(saved, &[laptop()], MINIMUM),
            frame(320.0, 166.0, 800.0, 490.0),
        );
    }

    #[test]
    fn the_first_launch_centres_the_default_size() {
        let large = area(0.0, 25.0, 1920.0, 1100.0);

        assert_eq!(
            default_placement(DEFAULT_SIZE, CHROME, &[large], MINIMUM),
            frame(320.0, 161.0, 1280.0, 800.0),
        );
    }

    #[test]
    fn the_first_launch_bounds_the_default_size_to_a_smaller_work_area() {
        assert_eq!(
            default_placement(DEFAULT_SIZE, CHROME, &[laptop()], MINIMUM),
            frame(80.0, 25.0, 1280.0, 772.0),
        );
    }

    #[test]
    fn the_first_launch_on_a_work_area_shorter_than_the_floor_opens_at_its_top() {
        let short = area(0.0, 25.0, 1440.0, 250.0);

        assert_eq!(
            default_placement(DEFAULT_SIZE, CHROME, &[short], MINIMUM),
            frame(80.0, 25.0, 1280.0, 300.0),
        );
    }

    #[test]
    fn the_first_launch_centres_the_whole_window() {
        let display = area(54.0, 33.0, 1674.0, 1084.0);

        assert_eq!(
            default_placement(DEFAULT_SIZE, FIRST_RUN_CHROME, &[display], MINIMUM),
            Frame {
                chrome: 0.0,
                ..frame(251.0, 175.0, 1280.0, 800.0)
            },
        );
    }

    #[test]
    fn the_steps_of_a_zoom_animation_are_not_remembered() {
        let start = Instant::now();
        let placed = frame(360.0, 190.0, 1050.0, 680.0);
        let mut tracker = Tracker::default();

        tracker.report(Some(placed), start);
        tracker.report(Some(frame(200.0, 110.0, 1360.0, 880.0)), after(start, 5000));
        tracker.report(Some(frame(59.0, 36.0, 1663.0, 1049.0)), after(start, 5016));
        // The last step: the window is zoomed and measures nothing.
        tracker.report(None, after(start, 5032));

        assert_eq!(tracker.finish(None, after(start, 9000)), Some(placed));
    }

    #[test]
    fn a_frame_counts_once_nothing_has_followed_it_for_the_settle_time() {
        let start = Instant::now();
        let placed = frame(100.0, 100.0, 800.0, 500.0);
        let mut tracker = Tracker::default();

        tracker.report(Some(placed), start);

        assert_eq!(
            tracker.finish(None, start + SETTLE - Duration::from_millis(1)),
            None
        );
        assert_eq!(tracker.finish(None, start + SETTLE), Some(placed));
    }

    #[test]
    fn a_settled_frame_outlives_a_window_that_stops_measuring() {
        let start = Instant::now();
        let placed = frame(100.0, 100.0, 800.0, 500.0);
        let mut tracker = Tracker::default();

        tracker.report(Some(placed), start);
        // Minimised, so not remembered.
        tracker.report(None, start + SETTLE);

        assert_eq!(tracker.finish(None, after(start, 9000)), Some(placed));
    }

    #[test]
    fn a_frame_the_window_measures_at_the_end_counts_at_once() {
        let start = Instant::now();
        let closing = frame(700.0, 400.0, 900.0, 640.0);
        let mut tracker = Tracker::default();

        tracker.report(Some(frame(100.0, 100.0, 800.0, 500.0)), start);

        assert_eq!(
            tracker.finish(Some(closing), after(start, 10)),
            Some(closing)
        );
        assert_eq!(
            tracker.finish(None, after(start, 10) + SETTLE),
            Some(closing)
        );
    }

    #[test]
    fn a_live_window_is_measured_in_points() {
        let measured = measured(
            PhysicalPosition::new(200, 100),
            PhysicalSize::new(1600, 1000),
            PhysicalSize::new(1600, 1056),
            2.0,
        );

        assert_eq!(measured, frame(100.0, 50.0, 800.0, 500.0));
    }

    #[test]
    fn a_work_area_is_measured_in_points() {
        let physical = PhysicalRect {
            position: PhysicalPosition::new(2880, 50),
            size: PhysicalSize::new(3024, 1800),
        };

        assert_eq!(points(&physical, 2.0), area(1440.0, 25.0, 1512.0, 900.0));
    }

    #[test]
    fn each_work_area_is_listed_once_in_order() {
        let external = area(1440.0, 0.0, 1920.0, 1080.0);

        assert_eq!(
            distinct([laptop(), laptop(), external, laptop()]),
            vec![laptop(), external],
        );
    }

    #[test]
    fn a_frame_survives_the_record() {
        let saved = frame(100.5, -20.0, 800.0, 500.0);
        let text = serde_json::to_string(&saved).unwrap();

        assert_eq!(serde_json::from_str::<Frame>(&text).unwrap(), saved);
    }

    #[test]
    fn a_written_frame_is_read_back() {
        let directory = directory("a_written_frame_is_read_back");
        let saved = Frame {
            chrome: 20.0,
            ..frame(100.0, 100.0, 800.0, 500.0)
        };

        write(&directory, saved).unwrap();

        assert_eq!(read(&directory), Some(saved));
    }

    #[test]
    fn a_negative_title_bar_is_read_as_zero() {
        let directory = directory("a_negative_title_bar_is_read_as_zero");
        let saved = Frame {
            chrome: -5.0,
            ..frame(100.0, 100.0, 800.0, 500.0)
        };

        write(&directory, saved).unwrap();

        assert_eq!(read(&directory).map(|frame| frame.chrome), Some(0.0));
    }

    #[test]
    fn a_missing_or_malformed_record_is_nothing() {
        let directory = directory("a_missing_or_malformed_record_is_nothing");

        assert_eq!(read(&directory), None);

        std::fs::write(directory.join(FILE), "{\"x\": 1}").unwrap();

        assert_eq!(read(&directory), None);
    }

    #[test]
    fn a_link_at_the_record_is_replaced_rather_than_written_through() {
        let directory = directory("a_link_at_the_record_is_replaced_rather_than_written_through");
        let elsewhere = directory.join("elsewhere");
        let saved = frame(100.0, 100.0, 800.0, 500.0);

        std::fs::write(&elsewhere, "someone else's file").unwrap();
        std::os::unix::fs::symlink(&elsewhere, directory.join(FILE)).unwrap();

        write(&directory, saved).unwrap();

        assert_eq!(
            std::fs::read_to_string(&elsewhere).unwrap(),
            "someone else's file"
        );
        assert_eq!(read(&directory), Some(saved));
    }

    #[test]
    fn a_link_at_the_pending_name_is_not_written_through() {
        let directory = directory("a_link_at_the_pending_name_is_not_written_through");
        let elsewhere = directory.join("elsewhere");
        let saved = frame(100.0, 100.0, 800.0, 500.0);

        std::fs::write(&elsewhere, "someone else's file").unwrap();
        std::os::unix::fs::symlink(&elsewhere, directory.join(PENDING)).unwrap();

        write(&directory, saved).unwrap();

        assert_eq!(
            std::fs::read_to_string(&elsewhere).unwrap(),
            "someone else's file"
        );
        assert_eq!(read(&directory), Some(saved));
    }

    #[test]
    fn a_save_that_did_not_finish_does_not_stop_the_next() {
        let directory = directory("a_save_that_did_not_finish_does_not_stop_the_next");
        let saved = frame(100.0, 100.0, 800.0, 500.0);

        std::fs::write(directory.join(PENDING), "{\"x\": 1").unwrap();

        write(&directory, saved).unwrap();

        assert_eq!(read(&directory), Some(saved));
        assert!(!directory.join(PENDING).exists());
    }

    #[test]
    fn a_link_at_the_record_is_nothing() {
        let elsewhere = directory("a_link_at_the_record_is_nothing-elsewhere");
        let directory = directory("a_link_at_the_record_is_nothing");

        write(&elsewhere, frame(100.0, 100.0, 800.0, 500.0)).unwrap();
        std::os::unix::fs::symlink(elsewhere.join(FILE), directory.join(FILE)).unwrap();

        assert_eq!(read(&directory), None);
    }

    #[test]
    fn a_pipe_at_the_record_is_nothing() {
        use std::os::unix::ffi::OsStrExt as _;

        let directory = directory("a_pipe_at_the_record_is_nothing");
        let pipe = std::ffi::CString::new(directory.join(FILE).as_os_str().as_bytes()).unwrap();

        // Safety: the name lives across the call.
        assert_eq!(unsafe { libc::mkfifo(pipe.as_ptr(), 0o600) }, 0);

        // On a thread, so a read that waits for a writer fails the test rather
        // than holding the run.
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || sender.send(read(&directory)));

        assert_eq!(
            receiver.recv_timeout(std::time::Duration::from_secs(5)),
            Ok(None)
        );
    }

    #[test]
    fn a_record_larger_than_the_limit_is_nothing() {
        let directory = directory("a_record_larger_than_the_limit_is_nothing");
        let saved = frame(100.0, 100.0, 800.0, 500.0);
        let text = serde_json::to_string(&saved).unwrap();
        let padded = |length: u64| format!("{text:<width$}", width = length as usize);

        std::fs::write(directory.join(FILE), padded(LIMIT)).unwrap();
        assert_eq!(read(&directory), Some(saved));

        std::fs::write(directory.join(FILE), padded(LIMIT + 1)).unwrap();
        assert_eq!(read(&directory), None);
    }

    #[test]
    fn a_record_that_cannot_be_written_is_an_error() {
        let file = temp_file("geometry-a-file-not-a-directory");
        std::fs::write(&file, "").unwrap();

        assert!(write(&file.join("config"), frame(0.0, 0.0, 800.0, 500.0)).is_err());
    }
}
