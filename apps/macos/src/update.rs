//! The update: the check against the latest release on GitHub, the state the
//! sidebar shows, and the install that swaps the release in for the running
//! bundle.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, SystemTime};

use semver::Version;
use serde::Deserialize;
use tauri::http::header::{ACCEPT, CACHE_CONTROL, CONTENT_TYPE};
use tauri::http::{Method, Response, StatusCode};
use tauri::{AppHandle, Manager as _, Url};

use crate::command::{account_home, bundle_of, cli_beside, installed_executable};
use crate::daemon::Daemon;
use crate::daemon_stop::{STOP_LIMIT, STOP_TICK, stop_daemon};
use crate::install::{self, Failure, Scratch, Tools};
use crate::version::version_of;
use crate::{elevate, log, menu};

/// The latest release of the repository the releases are published on, held
/// to `scripts/app-publish.sh` by a repo test.
const LATEST: &str = "https://api.github.com/repos/mubinov/tasma/releases/latest";

/// Replaces `LATEST`, to test against a local server. The signature check
/// stays the same.
const URL_VARIABLE: &str = "TASMA_UPDATE_URL";

/// The DMG of each architecture, held to `scripts/app-publish.sh` by a repo
/// test. A copy that runs under Rosetta keeps the Intel build.
const ARM_IMAGE: &str = "Tasma-arm64.dmg";
const INTEL_IMAGE: &str = "Tasma-x64.dmg";

const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// How often the timer reads the wall clock. The interval runs on a clock that
/// stops while the Mac sleeps, so the 24 hours are measured on the wall clock.
const WAKE: Duration = Duration::from_secs(60 * 60);

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a download may receive nothing before it fails. Without it a
/// stalled connection holds the state at `installing` for good.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the page has to answer a finished install before the app restarts
/// by itself.
const RESTART_LIMIT: Duration = Duration::from_secs(10);

/// How much of the release answer is read. It carries the release notes, so
/// it is far above its usual size.
const ANSWER_LIMIT: usize = 4 * 1024 * 1024;

const IMAGE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

/// The event the page listens for, held to `apps/web` by a repo test.
const EVENT: &str = "tasma:update";

const NOT_IN_APPLICATIONS: &str = "Move Tasma to the Applications folder to get updates.";
const CHECK_FAILED: &str = "Tasma could not check for updates.";
const RESTART_TO_FINISH: &str = "Restart Tasma to finish the update.";

fn image_for(architecture: &str) -> Option<&'static str> {
    match architecture {
        "aarch64" => Some(ARM_IMAGE),
        "x86_64" => Some(INTEL_IMAGE),
        _ => None,
    }
}

/// A release on GitHub: its version, its DMG for this Mac and its page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Release {
    version: Version,
    image: String,
    page: String,
}

/// Why a check found no release.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CheckError {
    Unreachable,
    Limited,
    Status(u16),
    Invalid,
    NoImage,
}

impl CheckError {
    fn reason(&self) -> String {
        match self {
            Self::Unreachable => "GitHub could not be reached.".to_string(),
            Self::Limited => {
                "GitHub allows only a few checks an hour. Try again later.".to_string()
            }
            Self::Status(status) => format!("GitHub answered with HTTP status {status}."),
            Self::Invalid => "The answer from GitHub is not valid.".to_string(),
            Self::NoImage => "The latest release has no download for this Mac.".to_string(),
        }
    }
}

#[derive(Deserialize)]
struct Answer {
    tag_name: String,
    html_url: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

/// An `http` or `https` address, as written.
fn web_address(text: &str) -> Option<String> {
    let url = Url::parse(text).ok()?;

    matches!(url.scheme(), "http" | "https").then(|| text.to_string())
}

/// The release a latest-release answer names, with the DMG called `image`.
fn read_release(bytes: &[u8], image: Option<&str>) -> Result<Release, CheckError> {
    let answer: Answer = serde_json::from_slice(bytes).map_err(|_| CheckError::Invalid)?;
    let version = version_of(&answer.tag_name).ok_or(CheckError::Invalid)?;
    let page = web_address(&answer.html_url).ok_or(CheckError::Invalid)?;
    let asset = answer
        .assets
        .into_iter()
        .find(|asset| Some(asset.name.as_str()) == image)
        .ok_or(CheckError::NoImage)?;
    let image = web_address(&asset.browser_download_url).ok_or(CheckError::Invalid)?;

    Ok(Release {
        version,
        image,
        page,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Phase {
    #[default]
    None,
    Available,
    Installing(u8),
    Ready,
    Failed(Failure),
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Available => "available",
            Self::Installing(_) => "installing",
            Self::Ready => "ready",
            Self::Failed(_) => "failed",
        }
    }

    /// While an install runs or waits for a restart, a check changes nothing.
    fn busy(self) -> bool {
        matches!(self, Self::Installing(_) | Self::Ready)
    }
}

#[derive(Debug, Default)]
struct State {
    phase: Phase,
    release: Option<Release>,
    last_check: Option<SystemTime>,
    /// The page asked the app to wait for its restart.
    waited: bool,
    /// Uninstall runs. It and an install never run together.
    uninstall_pending: bool,
}

impl State {
    /// Whether an automatic check is due at `now`, on the wall clock. A clock
    /// set back counts as due.
    fn due(&self, now: SystemTime, every: Duration) -> bool {
        !self.phase.busy()
            && self.last_check.is_none_or(|last| {
                now.duration_since(last)
                    .map_or(true, |passed| passed >= every)
            })
    }

    /// A release with a higher version was found. Answers whether the state
    /// changed.
    fn found(&mut self, release: Release) -> bool {
        if self.phase.busy()
            || (self.phase == Phase::Available && self.release.as_ref() == Some(&release))
        {
            return false;
        }

        self.phase = Phase::Available;
        self.release = Some(release);

        true
    }

    /// The release to install, when an install may start.
    fn begin_install(&mut self) -> Option<Release> {
        if self.uninstall_pending || !matches!(self.phase, Phase::Available | Phase::Failed(_)) {
            return None;
        }

        let release = self.release.clone()?;
        self.phase = Phase::Installing(0);
        self.waited = false;

        Some(release)
    }

    /// Answers whether the percent shown changed.
    fn progress(&mut self, percent: u8) -> bool {
        match self.phase {
            Phase::Installing(shown) if shown != percent => {
                self.phase = Phase::Installing(percent);

                true
            }
            _ => false,
        }
    }

    fn finish(&mut self, result: Result<(), Failure>) {
        self.phase = match result {
            Ok(()) => Phase::Ready,
            Err(failure) => Phase::Failed(failure),
        };
    }

    fn wait(&mut self) -> bool {
        if self.phase == Phase::Ready {
            self.waited = true;
        }

        self.phase == Phase::Ready
    }

    fn restarts_by_itself(&self) -> bool {
        self.phase == Phase::Ready && !self.waited
    }

    fn version(&self) -> String {
        self.release
            .as_ref()
            .map_or_else(String::new, |release| release.version.to_string())
    }

    /// Marks Uninstall as running, unless an install runs or waits for its
    /// restart: then answers what the alert says instead.
    fn begin_uninstall(&mut self) -> Result<(), Message> {
        if let Some(busy) = self.busy_message() {
            return Err(busy);
        }

        self.uninstall_pending = true;

        Ok(())
    }

    /// What a check from the menu, or Uninstall, says while the state is busy.
    fn busy_message(&self) -> Option<Message> {
        match self.phase {
            Phase::Installing(_) => Some((
                format!("Tasma is installing {}.", self.version()),
                String::new(),
            )),
            Phase::Ready => Some((RESTART_TO_FINISH.to_string(), String::new())),
            _ => None,
        }
    }

    /// `GET /app/update`.
    fn answer(&self, current: &Version) -> serde_json::Value {
        let mut answer = serde_json::Map::new();

        answer.insert("state".into(), self.phase.name().into());
        answer.insert("current".into(), current.to_string().into());

        if let Some(release) = self.release.as_ref().filter(|_| self.phase != Phase::None) {
            answer.insert("version".into(), release.version.to_string().into());
            answer.insert("releaseUrl".into(), release.page.clone().into());
        }

        match self.phase {
            Phase::Installing(percent) => {
                answer.insert("progress".into(), percent.into());
            }
            Phase::Failed(failure) => {
                answer.insert("error".into(), failure.reason().into());
            }
            _ => {}
        }

        answer.into()
    }
}

/// A native alert: its title and its text.
pub(crate) type Message = (String, String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Origin {
    Automatic,
    Menu,
}

/// What the page is told with a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Detail {
    Changed,
    /// A check from the menu found an update: open the update dialog.
    Open,
    /// The install is done: restart, by the restart rule of the page.
    Restart,
}

fn event_script(detail: Detail) -> String {
    let detail = match detail {
        Detail::Changed => "{}",
        Detail::Open => r#"{"open":true}"#,
        Detail::Restart => r#"{"restart":true}"#,
    };

    format!(r#"window.dispatchEvent(new CustomEvent("{EVENT}", {{ detail: {detail} }}))"#)
}

/// What the update reaches of the application outside itself.
pub(crate) trait Host: Send + Sync + 'static {
    fn emit(&self, detail: Detail);
    fn restart(&self);
    /// Enables the menu items again by the state they read.
    fn refresh_menu(&self);
}

pub(crate) struct AppHost(pub(crate) AppHandle);

impl Host for AppHost {
    fn emit(&self, detail: Detail) {
        if let Some(window) = self.0.get_webview_window(crate::WINDOW) {
            let _ = window.eval(event_script(detail));
        }
    }

    fn restart(&self) {
        self.0.request_restart();
    }

    fn refresh_menu(&self) {
        let app = self.0.clone();
        let _ = self.0.run_on_main_thread(move || menu::refresh(&app));
    }
}

fn percent(received: u64, total: u64) -> u8 {
    if total == 0 {
        return 100;
    }

    u8::try_from(received.min(total) * 100 / total).unwrap_or(100)
}

/// Runs a step that blocks off the async runtime's workers.
async fn blocking<T: Send + 'static>(task: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tauri::async_runtime::spawn_blocking(task).await.ok()
}

/// The update of one running application.
pub(crate) struct Updater {
    current: Version,
    url: String,
    client: reqwest::Client,
    daemon: Arc<Daemon>,
    /// This process's executable, when it runs from an Applications folder.
    executable: Option<PathBuf>,
    tools: Tools,
    /// Where an install makes its scratch folder.
    scratch: PathBuf,
    /// Where the log is written.
    home: Option<PathBuf>,
    restart_limit: Duration,
    state: Mutex<State>,
    /// Set once the application runs. Before that nothing is told.
    host: OnceLock<Arc<dyn Host>>,
}

fn client(current: &Version) -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(format!("Tasma/{current}"))
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .expect("a client with the platform's certificates is always buildable")
}

impl Updater {
    pub(crate) fn new(current: Version, daemon: Arc<Daemon>) -> Self {
        Self {
            url: std::env::var(URL_VARIABLE)
                .ok()
                .filter(|url| !url.is_empty())
                .unwrap_or_else(|| LATEST.to_string()),
            client: client(&current),
            current,
            daemon,
            executable: installed_executable(account_home().as_deref()),
            tools: Tools::system(),
            scratch: std::env::temp_dir(),
            home: std::env::home_dir(),
            restart_limit: RESTART_LIMIT,
            state: Mutex::default(),
            host: OnceLock::new(),
        }
    }

    pub(crate) fn attach(&self, host: Arc<dyn Host>) {
        let _ = self.host.set(host);
    }

    fn emit(&self, detail: Detail) {
        if let Some(host) = self.host.get() {
            host.emit(detail);
        }
    }

    fn refresh_menu(&self) {
        if let Some(host) = self.host.get() {
            host.refresh_menu();
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// An install runs or waits for its restart.
    pub(crate) fn busy(&self) -> bool {
        self.lock().phase.busy()
    }

    pub(crate) fn uninstall_pending(&self) -> bool {
        self.lock().uninstall_pending
    }

    pub(crate) fn begin_uninstall(&self) -> Result<(), Message> {
        self.lock().begin_uninstall()
    }

    pub(crate) fn end_uninstall(&self) {
        self.lock().uninstall_pending = false;
    }

    fn note(&self, text: &str) {
        let file = log::open(self.home.as_deref()).ok();
        log::note(file.as_ref(), text);
    }

    pub(crate) fn answer(&self) -> serde_json::Value {
        self.lock().answer(&self.current)
    }

    /// Checks at launch and then each 24 hours, while the app runs from an
    /// Applications folder.
    pub(crate) async fn watch(self: Arc<Self>) {
        if self.executable.is_none() {
            return;
        }

        loop {
            if self.lock().due(SystemTime::now(), CHECK_EVERY) {
                self.check(Origin::Automatic).await;
            }

            tokio::time::sleep(WAKE).await;
        }
    }

    /// Looks for a release with a higher version. A check from the menu
    /// answers the alert it shows, unless the update dialog opens instead.
    pub(crate) async fn check(&self, origin: Origin) -> Option<Message> {
        let menu = origin == Origin::Menu;

        if self.executable.is_none() {
            return menu.then(|| (NOT_IN_APPLICATIONS.to_string(), String::new()));
        }

        {
            let mut state = self.lock();

            if let Some(busy) = state.busy_message() {
                return menu.then_some(busy);
            }

            state.last_check = Some(SystemTime::now());
        }

        match self.latest().await {
            Ok(release) if release.version > self.current => {
                let (changed, busy) = {
                    let mut state = self.lock();
                    (state.found(release), state.busy_message())
                };

                if menu && busy.is_some() {
                    return busy;
                }

                if menu {
                    self.emit(Detail::Open);
                } else if changed {
                    self.emit(Detail::Changed);
                }

                None
            }
            Ok(_) => menu.then(|| {
                (
                    format!("Tasma {} is the latest version.", self.current),
                    String::new(),
                )
            }),
            Err(error) => {
                if menu {
                    return Some((CHECK_FAILED.to_string(), error.reason()));
                }

                self.note(&format!("the update check failed: {}", error.reason()));

                None
            }
        }
    }

    async fn latest(&self) -> Result<Release, CheckError> {
        let mut reply = self
            .client
            .get(&self.url)
            .header(ACCEPT, "application/vnd.github+json")
            .send()
            .await
            .map_err(|_| CheckError::Unreachable)?;
        let status = reply.status();

        // GitHub answers 403 at its rate limit, and 429 for a secondary limit.
        if status == reqwest::StatusCode::FORBIDDEN
            || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            return Err(CheckError::Limited);
        }

        if !status.is_success() {
            return Err(CheckError::Status(status.as_u16()));
        }

        let mut bytes: Vec<u8> = Vec::new();
        while let Some(frame) = reply.chunk().await.map_err(|_| CheckError::Unreachable)? {
            if bytes.len() + frame.len() > ANSWER_LIMIT {
                return Err(CheckError::Invalid);
            }
            bytes.extend_from_slice(&frame);
        }

        read_release(&bytes, image_for(std::env::consts::ARCH))
    }

    /// Starts the install, when the state allows one.
    pub(crate) fn install(self: &Arc<Self>) -> bool {
        let Some(release) = self.lock().begin_install() else {
            return false;
        };

        self.refresh_menu();
        self.emit(Detail::Changed);

        let updater = Arc::clone(self);

        tauri::async_runtime::spawn(async move {
            let result = updater.carry_out(&release).await;

            updater.finish(&release, result);
        });

        true
    }

    fn finish(self: &Arc<Self>, release: &Release, result: Result<(), Failure>) {
        self.daemon.hold(false);

        if let Err(failure) = result {
            self.note(&format!(
                "the update to {} failed: {}",
                release.version,
                failure.reason()
            ));
        }

        self.lock().finish(result);

        if result.is_err() {
            self.refresh_menu();
            self.emit(Detail::Changed);

            return;
        }

        self.emit(Detail::Restart);

        let updater = Arc::clone(self);

        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(updater.restart_limit).await;

            if updater.lock().restarts_by_itself() {
                updater.restart_app();
            }
        });
    }

    fn restart_app(&self) {
        if let Some(host) = self.host.get() {
            host.restart();
        }
    }

    async fn carry_out(&self, release: &Release) -> Result<(), Failure> {
        let executable = self.executable.clone().ok_or(Failure::Replace)?;
        let installed = bundle_of(&executable)
            .ok_or(Failure::Replace)?
            .to_path_buf();

        if install::already_installed(&installed, &release.version) {
            return Ok(());
        }

        let scratch = Scratch::new(&self.scratch, &self.tools).map_err(|_| Failure::Download)?;
        let (scratch, result) = self.replace(scratch, &executable, installed, release).await;

        // Detaches the image, which can take a moment.
        blocking(move || drop(scratch)).await;

        result
    }

    /// Downloads, mounts, checks and swaps, and hands the scratch folder back
    /// for the caller to drop.
    async fn replace(
        &self,
        scratch: Scratch,
        executable: &Path,
        installed: PathBuf,
        release: &Release,
    ) -> (Option<Scratch>, Result<(), Failure>) {
        if let Err(failure) = self.download(&release.image, &scratch.image()).await {
            return (Some(scratch), Err(failure));
        }

        let Some((scratch, mounted)) = blocking(move || {
            let mut scratch = scratch;
            let mounted = scratch.mount();

            (scratch, mounted)
        })
        .await
        else {
            return (None, Err(Failure::Open));
        };

        if let Err(failure) = mounted {
            return (Some(scratch), Err(failure));
        }

        let source = scratch.source();
        let result = if install::writable(&installed) {
            self.replace_as_user(source, installed, &release.version, executable)
                .await
        } else {
            self.replace_as_root(source, &release.version, executable)
                .await
        };

        (Some(scratch), result)
    }

    async fn replace_as_user(
        &self,
        source: PathBuf,
        installed: PathBuf,
        version: &Version,
        executable: &Path,
    ) -> Result<(), Failure> {
        let tools = self.tools.clone();
        let version = version.clone();
        let target = installed.clone();

        blocking(move || install::stage(&tools, &source, &target, &version, None))
            .await
            .unwrap_or(Err(Failure::Replace))?;

        self.hold_and_stop_daemon(executable).await;

        blocking(move || install::swap_in(&installed))
            .await
            .unwrap_or(Err(Failure::Replace))
    }

    async fn replace_as_root(
        &self,
        source: PathBuf,
        version: &Version,
        executable: &Path,
    ) -> Result<(), Failure> {
        let Some(running) = elevate::begin() else {
            return Err(Failure::Busy);
        };

        self.hold_and_stop_daemon(executable).await;

        elevate::perform_update(
            executable.to_path_buf(),
            source,
            version.to_string(),
            &running,
        )
        .await
    }

    /// Stops the daemon with the bundle's own CLI, and holds the
    /// supervisor so that nothing starts the old daemon again before the swap.
    async fn hold_and_stop_daemon(&self, executable: &Path) {
        self.daemon.hold(true);

        let cli = cli_beside(executable);

        blocking(move || stop_daemon(&cli, STOP_LIMIT, STOP_TICK)).await;
    }

    async fn download(&self, url: &str, file: &Path) -> Result<(), Failure> {
        let mut reply = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| Failure::Download)?;

        if !reply.status().is_success() {
            return Err(Failure::Download);
        }

        let total = reply.content_length();
        let mut out = std::fs::File::create(file).map_err(|_| Failure::Download)?;
        let mut received: u64 = 0;

        while let Some(frame) = reply.chunk().await.map_err(|_| Failure::Download)? {
            received += frame.len() as u64;

            if received > IMAGE_LIMIT {
                return Err(Failure::Download);
            }

            out.write_all(&frame).map_err(|_| Failure::Download)?;

            let changed = total.is_some_and(|total| self.lock().progress(percent(received, total)));

            if changed {
                self.emit(Detail::Changed);
            }
        }

        Ok(())
    }

    fn restart(&self) -> bool {
        let ready = self.lock().phase == Phase::Ready;

        if ready {
            self.restart_app();
        }

        ready
    }

    fn wait(&self) -> bool {
        self.lock().wait()
    }
}

fn plain(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain")
        .header(CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .expect("a status and two headers are a response")
}

/// The routes under `/app`, with the prefix removed.
pub(crate) fn serve(updater: &Arc<Updater>, method: &Method, path: &str) -> Response<Vec<u8>> {
    let accepted = match (path, method) {
        ("/update", &Method::GET) => {
            return Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/json")
                .header(CACHE_CONTROL, "no-store")
                .body(updater.answer().to_string().into_bytes())
                .expect("a status and two headers are a response");
        }
        ("/update/install", &Method::POST) => updater.install(),
        ("/update/restart", &Method::POST) => updater.restart(),
        ("/update/wait", &Method::POST) => updater.wait(),
        ("/update" | "/update/install" | "/update/restart" | "/update/wait", _) => {
            return plain(StatusCode::METHOD_NOT_ALLOWED);
        }
        _ => return plain(StatusCode::NOT_FOUND),
    };

    plain(if accepted {
        StatusCode::ACCEPTED
    } else {
        StatusCode::CONFLICT
    })
}

/// An updater for the tests of every module that serves the routes, and a host
/// that records what the update asked of it.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    #[derive(Default)]
    pub(crate) struct Recorder {
        details: Mutex<Vec<Detail>>,
        restarts: Mutex<u32>,
        refreshes: Mutex<u32>,
    }

    impl Host for Recorder {
        fn emit(&self, detail: Detail) {
            self.details.lock().unwrap().push(detail);
        }

        fn restart(&self) {
            *self.restarts.lock().unwrap() += 1;
        }

        fn refresh_menu(&self) {
            *self.refreshes.lock().unwrap() += 1;
        }
    }

    impl Recorder {
        pub(crate) fn details(&self) -> Vec<Detail> {
            self.details.lock().unwrap().clone()
        }

        pub(crate) fn forget(&self) {
            self.details.lock().unwrap().clear();
        }

        pub(crate) fn restarts(&self) -> u32 {
            *self.restarts.lock().unwrap()
        }

        pub(crate) fn refreshes(&self) -> u32 {
            *self.refreshes.lock().unwrap()
        }
    }

    /// Attaches a new recorder to the updater, and answers it.
    pub(crate) fn attach(updater: &Updater) -> Arc<Recorder> {
        let recorder = Arc::new(Recorder::default());
        updater.attach(recorder.clone());

        recorder
    }

    /// An updater of version 1.0.0 with nothing installed, which reaches no
    /// network.
    pub(crate) fn updater(test: &str) -> Updater {
        let folder = crate::testing::directory(test);

        Updater {
            current: Version::new(1, 0, 0),
            url: "http://127.0.0.1:9/".to_string(),
            client: client(&Version::new(1, 0, 0)),
            daemon: Arc::new(crate::daemon::fixtures::daemon_on_a_dead_port(test)),
            executable: None,
            tools: Tools::system(),
            scratch: folder.clone(),
            home: Some(folder),
            restart_limit: RESTART_LIMIT,
            state: Mutex::default(),
            host: OnceLock::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;
    use std::time::Instant;

    use super::fixtures::*;
    use super::*;
    use crate::install::IDENTIFIER;
    use crate::install::fixtures::{bundle, tools};
    use crate::supervisor::fixtures::{listening, ok};
    use crate::testing::{directory, script_file};

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    fn release(text: &str) -> Release {
        Release {
            version: version(text),
            image: "https://example.invalid/Tasma-arm64.dmg".to_string(),
            page: format!("https://example.invalid/releases/tag/v{text}"),
        }
    }

    fn block_on<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn each_architecture_downloads_its_own_image() {
        assert_eq!(image_for("aarch64"), Some("Tasma-arm64.dmg"));
        assert_eq!(image_for("x86_64"), Some("Tasma-x64.dmg"));
        assert_eq!(image_for("riscv64"), None);
    }

    fn answer_naming(tag: &str, assets: &str) -> String {
        format!(
            r#"{{"tag_name":"{tag}","html_url":"https://example.invalid/releases/tag/{tag}","assets":[{assets}],"body":"notes"}}"#
        )
    }

    const ASSETS: &str = r#"{"name":"Tasma-arm64.dmg","browser_download_url":"https://example.invalid/a.dmg"},{"name":"Tasma-x64.dmg","browser_download_url":"https://example.invalid/x.dmg"}"#;

    #[test]
    fn a_release_answer_names_the_version_the_image_and_the_page() {
        let read = |tag: &str, image: &str| {
            read_release(answer_naming(tag, ASSETS).as_bytes(), Some(image))
        };

        assert_eq!(
            read("v0.2.0", ARM_IMAGE),
            Ok(Release {
                version: version("0.2.0"),
                image: "https://example.invalid/a.dmg".to_string(),
                page: "https://example.invalid/releases/tag/v0.2.0".to_string(),
            }),
        );
        assert_eq!(
            read("0.2.0", INTEL_IMAGE).map(|release| (release.version, release.image)),
            Ok((
                version("0.2.0"),
                "https://example.invalid/x.dmg".to_string()
            )),
        );
    }

    #[test]
    fn a_release_answer_without_the_image_or_that_is_not_valid_is_refused() {
        assert_eq!(
            read_release(answer_naming("v0.2.0", "").as_bytes(), Some(ARM_IMAGE)),
            Err(CheckError::NoImage)
        );
        assert_eq!(
            read_release(answer_naming("v0.2.0", ASSETS).as_bytes(), None),
            Err(CheckError::NoImage)
        );
        assert_eq!(
            read_release(answer_naming("latest", ASSETS).as_bytes(), Some(ARM_IMAGE)),
            Err(CheckError::Invalid)
        );
        assert_eq!(
            read_release(b"not json", Some(ARM_IMAGE)),
            Err(CheckError::Invalid)
        );
        assert_eq!(
            read_release(br#"{"tag_name":"v0.2.0"}"#, Some(ARM_IMAGE)),
            Err(CheckError::Invalid)
        );

        let file_page = r#"{"tag_name":"v0.2.0","html_url":"file:///etc/passwd","assets":[]}"#;
        assert_eq!(
            read_release(file_page.as_bytes(), Some(ARM_IMAGE)),
            Err(CheckError::Invalid)
        );

        let file_image = answer_naming(
            "v0.2.0",
            r#"{"name":"Tasma-arm64.dmg","browser_download_url":"file:///tmp/a.dmg"}"#,
        );
        assert_eq!(
            read_release(file_image.as_bytes(), Some(ARM_IMAGE)),
            Err(CheckError::Invalid)
        );
        assert_eq!(web_address("not a url"), None);
    }

    #[test]
    fn each_check_error_has_a_reason() {
        for error in [
            CheckError::Unreachable,
            CheckError::Limited,
            CheckError::Status(500),
            CheckError::Invalid,
            CheckError::NoImage,
        ] {
            assert!(error.reason().ends_with('.'), "{error:?}");
        }
        assert_eq!(
            CheckError::Status(502).reason(),
            "GitHub answered with HTTP status 502."
        );
    }

    #[test]
    fn the_24_hours_are_measured_on_the_wall_clock() {
        let now = SystemTime::now();
        let mut state = State::default();

        assert!(
            state.due(now, CHECK_EVERY),
            "the first check is due at once"
        );

        state.last_check = Some(now);
        assert!(!state.due(now + Duration::from_secs(23 * 60 * 60), CHECK_EVERY));
        assert!(state.due(now + CHECK_EVERY, CHECK_EVERY));
        assert!(
            state.due(now - Duration::from_secs(60), CHECK_EVERY),
            "a clock set back counts as due"
        );
    }

    #[test]
    fn an_automatic_check_waits_while_an_install_runs_or_waits_for_a_restart() {
        let now = SystemTime::now();

        for phase in [Phase::Installing(5), Phase::Ready] {
            let mut state = State {
                phase,
                release: Some(release("1.1.0")),
                ..State::default()
            };

            assert!(!state.due(now, CHECK_EVERY));
            assert!(!state.found(release("1.2.0")));
            assert_eq!(state.phase, phase);
        }
    }

    #[test]
    fn a_found_release_makes_the_state_available_once() {
        let mut state = State::default();

        assert!(state.found(release("1.1.0")));
        assert!(!state.found(release("1.1.0")));
        assert!(state.found(release("1.2.0")));
        assert_eq!(state.phase, Phase::Available);

        state.phase = Phase::Failed(Failure::Download);
        assert!(state.found(release("1.2.0")));
        assert_eq!(state.phase, Phase::Available);
    }

    #[test]
    fn only_an_available_or_a_failed_update_can_be_installed() {
        let begins = |phase: Phase| {
            let mut state = State {
                phase,
                release: Some(release("1.1.0")),
                waited: true,
                ..State::default()
            };
            let begun = state.begin_install();

            (begun.is_some(), state.phase, state.waited)
        };

        assert_eq!(
            begins(Phase::Available),
            (true, Phase::Installing(0), false)
        );
        assert_eq!(
            begins(Phase::Failed(Failure::Disk)),
            (true, Phase::Installing(0), false)
        );
        for phase in [Phase::None, Phase::Installing(3), Phase::Ready] {
            assert_eq!(begins(phase), (false, phase, true));
        }

        let mut empty = State {
            phase: Phase::Available,
            ..State::default()
        };
        assert_eq!(empty.begin_install(), None);
    }

    #[test]
    fn only_a_finished_install_can_restart_or_wait() {
        for phase in [
            Phase::None,
            Phase::Available,
            Phase::Installing(1),
            Phase::Failed(Failure::Busy),
        ] {
            let mut state = State {
                phase,
                ..State::default()
            };

            assert!(!state.wait());
            assert!(!state.restarts_by_itself());
        }

        let mut state = State {
            phase: Phase::Ready,
            ..State::default()
        };

        assert!(state.restarts_by_itself());
        assert!(state.wait());
        assert!(!state.restarts_by_itself());
    }

    #[test]
    fn uninstall_and_an_install_never_run_together() {
        let updater = Arc::new(updater("uninstall-gate"));
        updater.lock().found(release("1.1.0"));

        assert_eq!(updater.begin_uninstall(), Ok(()));
        assert!(updater.uninstall_pending());
        assert!(!updater.busy());
        assert_eq!(
            served(&updater, Method::POST, "/update/install").0,
            StatusCode::CONFLICT
        );

        updater.end_uninstall();
        assert!(!updater.uninstall_pending());

        for (phase, said) in [
            (Phase::Installing(4), "Tasma is installing 1.1.0."),
            (Phase::Ready, RESTART_TO_FINISH),
        ] {
            updater.lock().phase = phase;

            assert!(updater.busy());
            assert_eq!(
                updater.begin_uninstall(),
                Err((said.to_string(), String::new()))
            );
            assert!(!updater.uninstall_pending());
        }
    }

    #[test]
    fn the_progress_changes_only_during_an_install() {
        let mut state = State {
            phase: Phase::Installing(0),
            ..State::default()
        };

        assert!(state.progress(42));
        assert!(!state.progress(42));
        assert_eq!(state.phase, Phase::Installing(42));

        state.phase = Phase::Ready;
        assert!(!state.progress(50));

        assert_eq!(percent(50, 200), 25);
        assert_eq!(percent(300, 200), 100);
        assert_eq!(percent(0, 0), 100);
    }

    #[test]
    fn the_answer_carries_what_each_state_shows() {
        let current = version("1.0.0");
        let mut state = State::default();

        assert_eq!(
            state.answer(&current),
            serde_json::json!({ "state": "none", "current": "1.0.0" })
        );

        state.found(release("1.1.0"));
        assert_eq!(
            state.answer(&current),
            serde_json::json!({
                "state": "available",
                "current": "1.0.0",
                "version": "1.1.0",
                "releaseUrl": "https://example.invalid/releases/tag/v1.1.0",
            })
        );

        state.phase = Phase::Installing(42);
        assert_eq!(state.answer(&current)["progress"], 42);

        state.phase = Phase::Failed(Failure::Unsigned);
        assert_eq!(
            state.answer(&current)["error"],
            "The update is not signed by the Tasma developer."
        );
        assert_eq!(state.answer(&current).get("progress"), None);

        state.phase = Phase::Ready;
        assert_eq!(state.answer(&current)["state"], "ready");
    }

    #[test]
    fn a_busy_state_names_what_a_menu_check_says() {
        let mut state = State {
            phase: Phase::Installing(7),
            release: Some(release("1.1.0")),
            ..State::default()
        };

        assert_eq!(
            state.busy_message(),
            Some(("Tasma is installing 1.1.0.".to_string(), String::new()))
        );

        state.phase = Phase::Ready;
        assert_eq!(
            state.busy_message(),
            Some((RESTART_TO_FINISH.to_string(), String::new()))
        );

        state.phase = Phase::Available;
        assert_eq!(state.busy_message(), None);
        assert_eq!(State::default().version(), "");
    }

    #[test]
    fn the_event_carries_its_detail() {
        assert_eq!(
            event_script(Detail::Changed),
            r#"window.dispatchEvent(new CustomEvent("tasma:update", { detail: {} }))"#
        );
        assert!(event_script(Detail::Open).contains(r#"{ detail: {"open":true} }"#));
        assert!(event_script(Detail::Restart).contains(r#"{ detail: {"restart":true} }"#));
    }

    /// A server of a latest-release answer for `tag`, whose image is `image`
    /// bytes long and served by a second listener.
    fn releases(tag: &str, image: usize) -> String {
        let bytes = "x".repeat(image);
        let image_port = listening(move |_| {
            format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{bytes}",
                bytes.len()
            )
        });
        let assets = format!(
            r#"{{"name":"{ARM_IMAGE}","browser_download_url":"http://127.0.0.1:{image_port}/a.dmg"}},{{"name":"{INTEL_IMAGE}","browser_download_url":"http://127.0.0.1:{image_port}/x.dmg"}}"#
        );
        let answer = answer_naming(tag, &assets);
        let port = listening(move |_| ok(&answer));

        format!("http://127.0.0.1:{port}/latest")
    }

    fn installed_updater(test: &str, url: String) -> Updater {
        let folder = directory(test);
        let applications = folder.join("Applications");
        std::fs::create_dir(&applications).unwrap();
        let installed = bundle(&applications, "My Sample.app", IDENTIFIER, "1.0.0");

        Updater {
            url,
            executable: Some(installed.join("Contents/MacOS/Sample")),
            scratch: folder.clone(),
            home: Some(folder),
            ..updater(&format!("{test}-base"))
        }
    }

    #[test]
    fn an_automatic_check_that_finds_an_update_shows_the_item() {
        let updater = installed_updater("check-found", releases("v1.1.0", 1));
        let host = attach(&updater);

        assert_eq!(block_on(updater.check(Origin::Automatic)), None);
        assert_eq!(updater.answer()["state"], "available");
        assert_eq!(updater.answer()["version"], "1.1.0");
        assert_eq!(host.details(), [Detail::Changed]);

        // The same release again changes nothing.
        assert_eq!(block_on(updater.check(Origin::Automatic)), None);
        assert_eq!(host.details(), [Detail::Changed]);
    }

    #[test]
    fn a_menu_check_that_finds_an_update_opens_the_dialog() {
        let updater = installed_updater("check-menu-found", releases("v1.1.0", 1));
        let host = attach(&updater);

        assert_eq!(block_on(updater.check(Origin::Menu)), None);
        assert_eq!(host.details(), [Detail::Open]);
    }

    #[test]
    fn a_menu_check_that_finds_no_update_says_so() {
        let host = Arc::new(Recorder::default());

        for (test, tag) in [("check-same", "v1.0.0"), ("check-lower", "v0.9.0")] {
            let updater = installed_updater(test, releases(tag, 1));
            updater.attach(host.clone());

            assert_eq!(
                block_on(updater.check(Origin::Menu)),
                Some((
                    "Tasma 1.0.0 is the latest version.".to_string(),
                    String::new()
                ))
            );
            assert_eq!(block_on(updater.check(Origin::Automatic)), None);
            assert_eq!(updater.answer()["state"], "none");
        }

        assert!(host.details().is_empty());
    }

    fn answering_status(status: &'static str) -> String {
        let port = listening(move |_| {
            format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
        });

        format!("http://127.0.0.1:{port}/latest")
    }

    #[test]
    fn a_check_that_fails_alerts_from_the_menu_and_logs_otherwise() {
        let host = Arc::new(Recorder::default());
        let cases = [
            (
                "check-unreachable",
                format!("http://127.0.0.1:{}/latest", crate::testing::dead_port()),
                CheckError::Unreachable,
            ),
            (
                "check-limited",
                answering_status("403 Forbidden"),
                CheckError::Limited,
            ),
            (
                "check-too-many",
                answering_status("429 Too Many Requests"),
                CheckError::Limited,
            ),
            (
                "check-status",
                answering_status("500 Internal Server Error"),
                CheckError::Status(500),
            ),
            (
                "check-invalid",
                {
                    let port = listening(|_| ok("not json"));
                    format!("http://127.0.0.1:{port}/latest")
                },
                CheckError::Invalid,
            ),
            (
                "check-huge",
                {
                    let port = listening(|_| ok(&"x".repeat(ANSWER_LIMIT + 1)));
                    format!("http://127.0.0.1:{port}/latest")
                },
                CheckError::Invalid,
            ),
        ];

        for (test, url, error) in cases {
            let updater = installed_updater(test, url);
            updater.attach(host.clone());

            assert_eq!(
                block_on(updater.check(Origin::Menu)),
                Some((CHECK_FAILED.to_string(), error.reason())),
                "{test}"
            );
            assert_eq!(block_on(updater.check(Origin::Automatic)), None);

            let logged =
                std::fs::read_to_string(log::path(updater.home.as_deref().unwrap())).unwrap();
            assert_eq!(
                logged.trim(),
                format!("{} the update check failed: {}", log::MARK, error.reason()),
                "{test}"
            );
        }

        assert!(host.details().is_empty());
    }

    #[test]
    fn a_copy_outside_an_applications_folder_never_checks() {
        let updater = updater("check-not-installed");
        let host = attach(&updater);

        assert_eq!(
            block_on(updater.check(Origin::Menu)),
            Some((NOT_IN_APPLICATIONS.to_string(), String::new()))
        );
        assert_eq!(block_on(updater.check(Origin::Automatic)), None);
        assert_eq!(updater.lock().last_check, None);
        assert!(host.details().is_empty());

        // The timer ends at once rather than sleeping for an hour.
        block_on(Arc::new(updater).watch());
    }

    #[test]
    fn a_check_during_an_install_says_what_runs() {
        let updater = installed_updater("check-busy", releases("v1.2.0", 1));
        let host = attach(&updater);

        updater.lock().phase = Phase::Installing(3);
        updater.lock().release = Some(release("1.1.0"));

        assert_eq!(
            block_on(updater.check(Origin::Menu)),
            Some(("Tasma is installing 1.1.0.".to_string(), String::new()))
        );
        assert_eq!(block_on(updater.check(Origin::Automatic)), None);
        assert_eq!(updater.lock().last_check, None);
        assert!(host.details().is_empty());
    }

    fn wait_for(updater: &Updater, done: impl Fn(Phase) -> bool) -> Phase {
        let started = Instant::now();

        loop {
            let phase = updater.lock().phase;

            if done(phase) || started.elapsed() > Duration::from_secs(20) {
                return phase;
            }

            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn settled(phase: Phase) -> bool {
        matches!(phase, Phase::Ready | Phase::Failed(_))
    }

    /// An updater with a release found, its image served, a mounted bundle
    /// of `identifier` and version 1.1.0, and a CLI that records each stop.
    fn ready_to_install(
        test: &str,
        identifier: &str,
        signed: bool,
    ) -> (Arc<Updater>, PathBuf, Arc<Recorder>) {
        let updater = installed_updater(test, releases("v1.1.0", 300));
        let folder = updater.scratch.clone();
        let release = folder.join("release");
        std::fs::create_dir(&release).unwrap();
        let mounted = bundle(&release, install::IMAGE_BUNDLE, identifier, "1.1.0");
        let installed = bundle_of(updater.executable.as_deref().unwrap())
            .unwrap()
            .to_path_buf();

        script_file(
            &installed.join("Contents/MacOS/tasma-cli"),
            &format!("echo \"$1 $2\" >> {}", folder.join("stopped").display()),
        );

        let updater = Arc::new(Updater {
            tools: tools(&folder, &mounted, signed),
            restart_limit: Duration::from_millis(300),
            ..updater
        });
        let host = attach(&updater);

        block_on(updater.check(Origin::Automatic));
        assert_eq!(updater.answer()["state"], "available");
        host.forget();

        (updater, installed, host)
    }

    fn scratch_folders(folder: &Path) -> usize {
        std::fs::read_dir(folder)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("tasma-update-")
            })
            .count()
    }

    #[test]
    fn an_install_swaps_the_release_in_and_restarts_by_itself() {
        let (updater, installed, host) = ready_to_install("install", IDENTIFIER, true);
        let folder = updater.scratch.clone();

        assert!(updater.install());
        assert_eq!(wait_for(&updater, settled), Phase::Ready);

        assert_eq!(install::bundle_version(&installed), Some(version("1.1.0")));
        assert_eq!(
            std::fs::read_to_string(folder.join("stopped")).unwrap(),
            "daemon stop\n"
        );
        assert_eq!(scratch_folders(&folder), 0);
        assert!(folder.join("detached").exists());

        let details = host.details();
        assert_eq!(details.first(), Some(&Detail::Changed));
        assert_eq!(details.last(), Some(&Detail::Restart));
        assert!(details.len() > 2, "the progress is reported: {details:?}");
        assert_eq!(
            host.refreshes(),
            1,
            "the menu is locked once and stays locked"
        );

        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(host.restarts(), 1);
    }

    #[test]
    fn a_page_that_asks_to_wait_holds_the_restart() {
        let (updater, _, host) = ready_to_install("install-wait", IDENTIFIER, true);

        assert!(updater.install());
        assert_eq!(wait_for(&updater, settled), Phase::Ready);
        assert!(updater.wait());

        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(host.restarts(), 0);

        assert!(updater.restart());
        assert_eq!(host.restarts(), 1);
    }

    #[test]
    fn an_install_that_fails_keeps_the_installed_app_and_names_the_reason() {
        let (updater, installed, host) = ready_to_install("install-unsigned", IDENTIFIER, false);
        let folder = updater.scratch.clone();

        assert!(updater.install());
        assert_eq!(
            wait_for(&updater, settled),
            Phase::Failed(Failure::Unsigned)
        );

        assert_eq!(install::bundle_version(&installed), Some(version("1.0.0")));
        assert!(
            !folder.join("stopped").exists(),
            "the daemon was not stopped"
        );
        assert_eq!(scratch_folders(&folder), 0);
        assert_eq!(host.refreshes(), 2, "the menu is locked and unlocked");
        assert_eq!(host.details().last(), Some(&Detail::Changed));
        assert!(
            std::fs::read_to_string(log::path(&folder))
                .unwrap()
                .contains(
                    "the update to 1.1.0 failed: The update is not signed by the Tasma developer."
                )
        );

        // A failed install can be tried again.
        assert!(updater.install());
        assert_eq!(
            wait_for(&updater, settled),
            Phase::Failed(Failure::Unsigned)
        );
    }

    #[test]
    fn a_download_that_fails_is_named() {
        let (updater, installed, _) = ready_to_install("install-download", IDENTIFIER, true);
        updater.lock().release.as_mut().unwrap().image =
            format!("http://127.0.0.1:{}/a.dmg", crate::testing::dead_port());

        assert!(updater.install());
        assert_eq!(
            wait_for(&updater, settled),
            Phase::Failed(Failure::Download)
        );
        assert_eq!(install::bundle_version(&installed), Some(version("1.0.0")));
    }

    #[test]
    fn an_image_answer_that_is_not_a_success_is_a_failed_download() {
        let (updater, _, _) = ready_to_install("install-404", IDENTIFIER, true);
        updater.lock().release.as_mut().unwrap().image = answering_status("404 Not Found");

        assert!(updater.install());
        assert_eq!(
            wait_for(&updater, settled),
            Phase::Failed(Failure::Download)
        );
    }

    #[test]
    fn an_image_that_cannot_be_mounted_is_named() {
        let updater = installed_updater("install-mount", releases("v1.1.0", 1));
        let updater = Arc::new(Updater {
            tools: Tools {
                hdiutil: script_file(&updater.scratch.join("hdiutil"), "exit 1"),
                codesign: script_file(&updater.scratch.join("codesign"), "exit 0"),
                ..Tools::system()
            },
            ..updater
        });
        block_on(updater.check(Origin::Automatic));

        assert!(updater.install());
        assert_eq!(wait_for(&updater, settled), Phase::Failed(Failure::Open));
        assert_eq!(scratch_folders(&updater.scratch), 0);
    }

    #[test]
    fn an_install_into_a_folder_the_user_cannot_write_asks_for_the_password() {
        let _slot = elevate::SLOT.lock().unwrap_or_else(PoisonError::into_inner);
        let (updater, installed, _) = ready_to_install("install-elevated", IDENTIFIER, true);
        let folder = updater.scratch.clone();
        let executable = updater.executable.clone().unwrap();
        // The elevated child, which cancels the password prompt.
        script_file(
            &executable,
            &format!(
                "[ \"$1\" = {} ] || exit 1\nexit {}",
                install::ELEVATED_ARGUMENT,
                Failure::Password.code()
            ),
        );
        let applications = installed.parent().unwrap().to_path_buf();
        std::fs::set_permissions(&applications, std::fs::Permissions::from_mode(0o555)).unwrap();

        assert!(updater.install());
        let phase = wait_for(&updater, settled);
        std::fs::set_permissions(&applications, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(phase, Phase::Failed(Failure::Password));
        assert_eq!(
            std::fs::read_to_string(folder.join("stopped")).unwrap(),
            "daemon stop\n"
        );
        assert_eq!(install::bundle_version(&installed), Some(version("1.0.0")));
    }

    #[test]
    fn an_install_while_another_password_prompt_is_open_fails_at_once() {
        let _slot = elevate::SLOT.lock().unwrap_or_else(PoisonError::into_inner);
        let (updater, installed, _) = ready_to_install("install-busy", IDENTIFIER, true);
        let folder = updater.scratch.clone();
        let applications = installed.parent().unwrap().to_path_buf();
        std::fs::set_permissions(&applications, std::fs::Permissions::from_mode(0o555)).unwrap();
        let held = elevate::begin().expect("no child runs yet");

        assert!(updater.install());
        let phase = wait_for(&updater, settled);
        drop(held);
        std::fs::set_permissions(&applications, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(phase, Phase::Failed(Failure::Busy));
        assert!(
            !folder.join("stopped").exists(),
            "the daemon was not stopped"
        );
    }

    #[test]
    fn a_release_another_user_already_installed_goes_straight_to_the_restart() {
        let (updater, installed, host) = ready_to_install("install-already", IDENTIFIER, true);
        bundle(
            installed.parent().unwrap(),
            "My Sample.app",
            IDENTIFIER,
            "1.1.0",
        );
        updater.lock().release.as_mut().unwrap().image = "http://127.0.0.1:9/never".to_string();

        assert!(updater.install());
        assert_eq!(wait_for(&updater, settled), Phase::Ready);
        assert_eq!(host.details().last(), Some(&Detail::Restart));
        assert_eq!(scratch_folders(&updater.scratch), 0);
    }

    #[test]
    fn an_install_with_no_installed_copy_cannot_replace_it() {
        let updater = Arc::new(updater("install-nowhere"));
        updater.lock().found(release("1.1.0"));

        assert!(updater.install());
        assert_eq!(wait_for(&updater, settled), Phase::Failed(Failure::Replace));
    }

    fn served(updater: &Arc<Updater>, method: Method, path: &str) -> (StatusCode, Vec<u8>) {
        let answer = serve(updater, &method, path);

        (answer.status(), answer.body().clone())
    }

    #[test]
    fn the_routes_answer_by_state() {
        let updater = Arc::new(updater("routes"));

        let (status, body) = served(&updater, Method::GET, "/update");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({ "state": "none", "current": "1.0.0" })
        );

        for path in ["/update/install", "/update/restart", "/update/wait"] {
            assert_eq!(
                served(&updater, Method::POST, path).0,
                StatusCode::CONFLICT,
                "{path}"
            );
        }

        updater.lock().phase = Phase::Ready;
        assert_eq!(
            served(&updater, Method::POST, "/update/wait").0,
            StatusCode::ACCEPTED
        );
        assert_eq!(
            served(&updater, Method::POST, "/update/restart").0,
            StatusCode::ACCEPTED
        );
        assert_eq!(
            served(&updater, Method::POST, "/update/install").0,
            StatusCode::CONFLICT
        );
    }

    #[test]
    fn a_route_answers_only_its_own_method_and_an_unknown_route_is_not_found() {
        let updater = Arc::new(updater("routes-methods"));

        assert_eq!(
            served(&updater, Method::POST, "/update").0,
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            served(&updater, Method::GET, "/update/install").0,
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            served(&updater, Method::GET, "/other").0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(served(&updater, Method::GET, "/").0, StatusCode::NOT_FOUND);
    }

    #[test]
    fn an_install_from_the_route_starts_and_shows_its_progress() {
        let (updater, _, _) = ready_to_install("routes-install", IDENTIFIER, true);

        assert_eq!(
            served(&updater, Method::POST, "/update/install").0,
            StatusCode::ACCEPTED
        );
        assert_eq!(
            served(&updater, Method::POST, "/update/install").0,
            StatusCode::CONFLICT
        );
        assert_eq!(wait_for(&updater, settled), Phase::Ready);
    }
}
