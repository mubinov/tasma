//! The restart after an update.
//!
//! macOS refuses to activate a copy that starts after this one has exited:
//! another application is active by then. So the running copy launches the
//! new copy through Launch Services. An active copy exits once the new copy is
//! active, or at `HANDOVER_LIMIT`. A copy that is not active exits as soon as
//! the launch completes.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2_app_kit::{
    NSApplication, NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSString, NSURL};
use tauri::{AppHandle, Manager as _};

use crate::{WINDOW, alert, command, menu};

const HANDOVER_TICK: Duration = Duration::from_millis(50);
const HANDOVER_LIMIT: Duration = Duration::from_secs(10);

/// The words of `RESTART_FAILED` in `apps/web`, held to it by a test.
const FAILED_TITLE: &str = "Tasma could not restart.";
const FAILED_TEXT: &str = "Quit Tasma and open it again.";

const NO_BUNDLE: &str = "the bundle of this copy is not known";
const NO_ANSWER: &str = "macOS gave no answer to the launch";

/// The new copy, or why it did not launch.
type Launch = Result<Retained<NSRunningApplication>, String>;

/// Marks the one hand-over that runs.
#[derive(Default)]
pub(crate) struct Handover(AtomicBool);

impl Handover {
    /// Whether a hand-over may start. It is then marked as running.
    fn begin(&self) -> bool {
        self.0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    fn end(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// What the hand-over does to the application.
trait Steps: Sync {
    type Launched: Sync;

    /// Saves the window frame, then hides the window.
    fn put_away(&self) -> impl Future<Output = ()> + Send;

    fn show(&self) -> impl Future<Output = ()> + Send;

    /// Reads whether this copy is active and launches `bundle` with
    /// `activates` set to that, in one call on the main thread.
    fn launch(
        &self,
        bundle: PathBuf,
    ) -> impl Future<Output = Result<(bool, Self::Launched), String>> + Send;

    fn is_active(&self, launched: &Self::Launched) -> impl Future<Output = bool> + Send;

    /// Logs `reason`, marks the update as waited and shows the alert.
    fn fail(&self, reason: String) -> impl Future<Output = ()> + Send;

    fn exit(&self);
}

/// Launches `bundle` and exits once the new copy has taken over. A failure
/// keeps this copy running, with its window shown again.
async fn hand_over<S: Steps>(steps: &S, running: &Handover, bundle: Option<PathBuf>) {
    if !running.begin() {
        return;
    }

    let Some(bundle) = bundle else {
        steps.fail(NO_BUNDLE.to_string()).await;
        running.end();
        return;
    };

    steps.put_away().await;

    match steps.launch(bundle).await {
        Ok((active, launched)) => {
            if active {
                wait_for(steps, &launched, HANDOVER_TICK, HANDOVER_LIMIT).await;
            }

            steps.exit();
        }
        Err(reason) => {
            steps.show().await;
            steps.fail(reason).await;
            running.end();
        }
    }
}

/// Waits until the new copy is active, or for `limit`.
async fn wait_for<S: Steps>(steps: &S, launched: &S::Launched, tick: Duration, limit: Duration) {
    let _ = tokio::time::timeout(limit, async {
        while !steps.is_active(launched).await {
            tokio::time::sleep(tick).await;
        }
    })
    .await;
}

/// The arguments after the first, in order. `NSString` cannot hold an
/// argument that is not UTF-8, so it is left out.
fn launch_arguments(arguments: impl IntoIterator<Item = OsString>) -> Vec<String> {
    arguments
        .into_iter()
        .skip(1)
        .filter_map(|argument| argument.into_string().ok())
        .collect()
}

/// Every variable whose name and value are UTF-8.
fn launch_environment(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(String, String)> {
    variables
        .into_iter()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

/// Starts the hand-over, unless one runs.
pub(crate) fn start(app: &AppHandle) {
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let bundle = std::env::current_exe()
            .ok()
            .and_then(|executable| command::bundle_of(&executable).map(Path::to_path_buf));

        hand_over(&Application(app.clone()), &app.state::<Handover>(), bundle).await;
    });
}

struct Application(AppHandle);

impl Steps for Application {
    type Launched = Retained<NSRunningApplication>;

    async fn put_away(&self) {
        let app = self.0.clone();

        alert::on_main(&self.0, move |_| {
            crate::save_frame(&app);

            if let Some(window) = app.get_webview_window(WINDOW) {
                let _ = window.hide();
            }
        })
        .await;
    }

    async fn show(&self) {
        if let Some(window) = self.0.get_webview_window(WINDOW) {
            let _ = window.show();
        }
    }

    async fn launch(&self, bundle: PathBuf) -> Result<(bool, Self::Launched), String> {
        let (sender, receiver) = mpsc::channel();
        let active = alert::on_main(&self.0, move |marker| {
            let active = NSApplication::sharedApplication(marker).isActive();
            open(&bundle, active, sender);

            active
        })
        .await;
        let answer = tauri::async_runtime::spawn_blocking(move || receiver.recv().ok())
            .await
            .ok()
            .flatten();

        match (active, answer) {
            (Some(active), Some(Ok(launched))) => Ok((active, launched)),
            (_, Some(Err(reason))) => Err(reason),
            _ => Err(NO_ANSWER.to_string()),
        }
    }

    async fn is_active(&self, launched: &Self::Launched) -> bool {
        let launched = launched.clone();

        alert::on_main(&self.0, move |_| launched.isActive())
            .await
            .unwrap_or(false)
    }

    async fn fail(&self, reason: String) {
        self.0
            .state::<menu::Shell>()
            .updater
            .restart_failed(&reason);
        alert::notice(&self.0, FAILED_TITLE, FAILED_TEXT.to_string()).await;
    }

    fn exit(&self) {
        self.0.exit(0);
    }
}

fn configuration(
    activates: bool,
    arguments: &[String],
    environment: &[(String, String)],
) -> Retained<NSWorkspaceOpenConfiguration> {
    let configuration = NSWorkspaceOpenConfiguration::configuration();
    configuration.setCreatesNewApplicationInstance(true);
    // Another running copy with the same bundle id, in a second Applications
    // folder, is never used in place of this bundle.
    configuration.setAllowsRunningApplicationSubstitution(false);
    configuration.setActivates(activates);
    configuration.setAddsToRecentItems(false);
    // Launch Services shows its own dialog for a launch error and covers the
    // alert that `fail` shows.
    configuration.setPromptsUserIfNeeded(false);

    let arguments: Vec<_> = arguments
        .iter()
        .map(|argument| NSString::from_str(argument))
        .collect();
    configuration.setArguments(&NSArray::from_retained_slice(&arguments));

    let (names, values): (Vec<_>, Vec<_>) = environment
        .iter()
        .map(|(name, value)| (NSString::from_str(name), NSString::from_str(value)))
        .unzip();
    let names: Vec<&NSString> = names.iter().map(|name| &**name).collect();
    configuration.setEnvironment(&NSDictionary::from_retained_objects(&names, &values));

    configuration
}

/// Launches a new copy of `bundle` with the arguments and the environment of
/// this process. `done` gets the result on a queue that macOS chooses.
fn open(bundle: &Path, activates: bool, done: Sender<Launch>) {
    let Some(url) = NSURL::from_directory_path(bundle) else {
        let _ = done.send(Err(NO_BUNDLE.to_string()));
        return;
    };

    let configuration = configuration(
        activates,
        &launch_arguments(std::env::args_os()),
        &launch_environment(std::env::vars_os()),
    );

    // Nothing here may panic: an unwind out of a block aborts the process.
    let handler = RcBlock::new(
        move |launched: *mut NSRunningApplication, error: *mut NSError| {
            // Safety: macOS hands over null or a live object for each.
            let result = match unsafe { error.as_ref() } {
                Some(error) => Err(error.localizedDescription().to_string()),
                None => unsafe { Retained::retain(launched) }.ok_or_else(|| NO_ANSWER.to_string()),
            };
            let _ = done.send(result);
        },
    );

    NSWorkspace::sharedWorkspace().openApplicationAtURL_configuration_completionHandler(
        &url,
        &configuration,
        Some(&handler),
    );
}

#[cfg(test)]
mod tests {
    use std::os::unix::ffi::OsStringExt as _;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicU32;
    use std::time::Instant;

    use super::*;

    /// Read at compile time, so words changed there and not here fail the
    /// test.
    const PAGE: &str = include_str!("../../web/src/components/update-events.tsx");

    #[test]
    fn the_alert_says_what_the_page_says() {
        assert!(PAGE.contains(&format!(
            r#"const RESTART_FAILED = "{FAILED_TITLE} {FAILED_TEXT}";"#
        )));
    }

    fn not_utf8() -> OsString {
        OsString::from_vec(vec![b'a', 0xff])
    }

    #[test]
    fn the_launch_carries_the_utf8_arguments_after_the_first() {
        let arguments = [
            OsString::from("/Applications/Example.app/Contents/MacOS/Example"),
            OsString::from("--first"),
            not_utf8(),
            OsString::from("second value"),
        ];

        assert_eq!(
            launch_arguments(arguments),
            vec!["--first".to_string(), "second value".to_string()]
        );
    }

    #[test]
    fn the_launch_carries_every_utf8_variable() {
        let variables = [
            (OsString::from("HOME"), OsString::from("/tmp/example-home")),
            (not_utf8(), OsString::from("value")),
            (OsString::from("NAME"), not_utf8()),
            (OsString::from("EMPTY"), OsString::new()),
        ];

        assert_eq!(
            launch_environment(variables),
            vec![
                ("HOME".to_string(), "/tmp/example-home".to_string()),
                ("EMPTY".to_string(), String::new()),
            ]
        );
    }

    #[test]
    fn the_configuration_starts_a_new_copy_and_no_dialog_of_macos() {
        let arguments = ["--first".to_string()];
        let environment = [("HOME".to_string(), "/tmp/example-home".to_string())];

        for activates in [true, false] {
            let configuration = configuration(activates, &arguments, &environment);

            assert!(!configuration.promptsUserIfNeeded());
            assert!(configuration.createsNewApplicationInstance());
            assert!(!configuration.allowsRunningApplicationSubstitution());
            assert_eq!(configuration.activates(), activates);
            assert!(!configuration.addsToRecentItems());

            let given: Vec<String> = configuration
                .arguments()
                .iter()
                .map(|argument| argument.to_string())
                .collect();
            assert_eq!(given, arguments);

            let given = configuration.environment();
            assert_eq!(given.count(), 1);
            assert_eq!(
                given
                    .objectForKey(&NSString::from_str("HOME"))
                    .map(|value| value.to_string()),
                Some("/tmp/example-home".to_string())
            );
        }
    }

    #[test]
    fn only_one_hand_over_runs_at_a_time() {
        let running = Handover::default();

        assert!(running.begin());
        assert!(!running.begin());

        running.end();
        assert!(running.begin());
    }

    /// Records each step, and answers a launch as told.
    struct Recorder {
        launch: Result<bool, String>,
        /// The probe at which the new copy is active.
        active_at: u32,
        probes: AtomicU32,
        done: Mutex<Vec<String>>,
    }

    impl Recorder {
        fn new(launch: Result<bool, String>, active_at: u32) -> Self {
            Self {
                launch,
                active_at,
                probes: AtomicU32::new(0),
                done: Mutex::default(),
            }
        }

        fn record(&self, step: impl Into<String>) {
            self.done.lock().unwrap().push(step.into());
        }

        fn done(&self) -> Vec<String> {
            self.done.lock().unwrap().clone()
        }
    }

    impl Steps for Recorder {
        type Launched = ();

        async fn put_away(&self) {
            self.record("put away");
        }

        async fn show(&self) {
            self.record("show");
        }

        async fn launch(&self, bundle: PathBuf) -> Result<(bool, ()), String> {
            self.record(format!("launch {}", bundle.display()));
            self.launch.clone().map(|active| (active, ()))
        }

        async fn is_active(&self, (): &()) -> bool {
            self.record("probe");
            self.probes.fetch_add(1, Ordering::SeqCst) + 1 >= self.active_at
        }

        async fn fail(&self, reason: String) {
            self.record(format!("fail: {reason}"));
        }

        fn exit(&self) {
            self.record("exit");
        }
    }

    fn bundle() -> Option<PathBuf> {
        Some(PathBuf::from("/Applications/Example.app"))
    }

    fn run(steps: &Recorder, running: &Handover, bundle: Option<PathBuf>) {
        tauri::async_runtime::block_on(hand_over(steps, running, bundle));
    }

    #[test]
    fn an_inactive_copy_exits_at_once_after_the_launch() {
        let running = Handover::default();
        let steps = Recorder::new(Ok(false), 1);

        run(&steps, &running, bundle());

        assert_eq!(
            steps.done(),
            ["put away", "launch /Applications/Example.app", "exit"]
        );
        assert!(!running.begin());
    }

    #[test]
    fn an_active_copy_exits_once_the_new_copy_is_active() {
        let running = Handover::default();
        let steps = Recorder::new(Ok(true), 3);

        run(&steps, &running, bundle());

        assert_eq!(
            steps.done(),
            [
                "put away",
                "launch /Applications/Example.app",
                "probe",
                "probe",
                "probe",
                "exit"
            ]
        );
        assert!(!running.begin());
    }

    #[test]
    fn the_wait_ends_at_its_limit() {
        let steps = Recorder::new(Ok(true), u32::MAX);
        let limit = Duration::from_millis(30);
        let started = Instant::now();

        tauri::async_runtime::block_on(wait_for(&steps, &(), Duration::from_millis(1), limit));

        assert!(started.elapsed() >= limit);
        assert!(steps.probes.load(Ordering::SeqCst) > 1);
    }

    #[test]
    fn a_failed_launch_shows_the_window_and_a_later_restart_runs() {
        let running = Handover::default();
        let steps = Recorder::new(Err("no app".to_string()), 1);

        run(&steps, &running, bundle());

        assert_eq!(
            steps.done(),
            [
                "put away",
                "launch /Applications/Example.app",
                "show",
                "fail: no app"
            ]
        );

        let again = Recorder::new(Ok(false), 1);
        run(&again, &running, bundle());

        assert_eq!(again.done().last().map(String::as_str), Some("exit"));
    }

    #[test]
    fn an_unknown_bundle_fails_before_the_window_is_hidden() {
        let running = Handover::default();
        let steps = Recorder::new(Ok(false), 1);

        run(&steps, &running, None);

        assert_eq!(steps.done(), [format!("fail: {NO_BUNDLE}")]);
        assert!(running.begin());
    }

    #[test]
    fn a_restart_during_a_hand_over_does_nothing() {
        let running = Handover::default();
        let steps = Recorder::new(Ok(false), 1);

        assert!(running.begin());
        run(&steps, &running, bundle());

        assert!(steps.done().is_empty());
    }
}
