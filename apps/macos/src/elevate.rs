//! The step that needs administrator rights, run in a child process of the
//! application's own executable.
//!
//! The password dialog names the process that runs the AppleScript, so the
//! child is `Tasma` and not `/usr/bin/osascript`. A child also keeps the
//! window responsive while the dialog is open, and keeps `NSAppleScript` off
//! the application's main thread.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::AnyObject;
use objc2::{AnyThread as _, msg_send};
use objc2_foundation::{
    NSAppleEventDescriptor, NSAppleScript, NSAppleScriptErrorMessage, NSAppleScriptErrorNumber,
    NSDictionary, NSNumber, NSString,
};

use crate::command::{LINK, LinkState, account_home, cli_beside, installed_location, link_state};

const INSTALL_ARGUMENT: &str = "--install-command-line-tool";
const REMOVE_ARGUMENT: &str = "--remove-command-line-tool";

/// The AppleScript error of a cancelled password dialog.
const USER_CANCELED: isize = -128;

/// The shell exit status the install script gives when a file or a folder that
/// is not a link stands at the link path.
const SCRIPT_OCCUPIED: isize = 3;

/// The child's exit codes.
const EXIT_DONE: i32 = 0;
const EXIT_CANCELLED: i32 = 1;
const EXIT_FAILED: i32 = 2;
const EXIT_OCCUPIED: i32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Step {
    Install,
    Remove,
}

impl Step {
    fn argument(self) -> &'static str {
        match self {
            Self::Install => INSTALL_ARGUMENT,
            Self::Remove => REMOVE_ARGUMENT,
        }
    }
}

/// The step the first argument asks the process to run instead of the window.
pub(crate) fn requested(argument: Option<&OsStr>) -> Option<Step> {
    [Step::Install, Step::Remove]
        .into_iter()
        .find(|step| argument == Some(OsStr::new(step.argument())))
}

/// `text` as the inside of an AppleScript string literal.
fn literal(text: &str) -> String {
    text.replace('\\', r"\\").replace('"', "\\\"")
}

/// The AppleScript a step runs. `quoted form of` quotes the target for the
/// shell, so only the literal around it needs escaping here.
fn script(step: Step, target: &str) -> String {
    match step {
        Step::Install => format!(
            r#"do shell script "mkdir -p /usr/local/bin && if [ -e {LINK} ] && [ ! -L {LINK} ]; then exit {SCRIPT_OCCUPIED}; fi && ln -sfn " & quoted form of "{}" & " {LINK}" with prompt "Tasma wants to install the tasma command in /usr/local/bin." with administrator privileges"#,
            literal(target),
        ),
        Step::Remove => format!(
            r#"do shell script "if [ -L {LINK} ]; then rm {LINK}; fi" with prompt "Tasma wants to remove the tasma command from /usr/local/bin." with administrator privileges"#,
        ),
    }
}

/// Runs a step in the child and answers its exit code. Never starts Tauri.
pub(crate) fn run(step: Step) -> i32 {
    match std::env::current_exe() {
        Ok(executable) => run_as(&executable, account_home().as_deref(), step, execute),
        Err(error) => failed(&format!("the executable cannot be found: {error}")),
    }
}

fn run_as(
    executable: &Path,
    account: Option<&Path>,
    step: Step,
    execute: impl FnOnce(&str) -> Result<(), (isize, String)>,
) -> i32 {
    // Checked again here, so a copy outside an Applications folder can never
    // link itself, whoever starts it with this argument.
    if !installed_location(executable, account) {
        return failed("Tasma is not in an Applications folder");
    }

    let target = cli_beside(executable);
    let Some(target) = target.to_str() else {
        return failed("the path of Tasma is not valid UTF-8");
    };

    match execute(&script(step, target)) {
        Ok(()) => EXIT_DONE,
        Err((USER_CANCELED, _)) => EXIT_CANCELLED,
        Err((SCRIPT_OCCUPIED, _)) if step == Step::Install => EXIT_OCCUPIED,
        Err((_, message)) => failed(&message),
    }
}

fn failed(message: &str) -> i32 {
    eprintln!("{}", message.replace(['\r', '\n'], " "));

    EXIT_FAILED
}

/// Runs AppleScript source, and answers its error number and message.
fn execute(source: &str) -> Result<(), (isize, String)> {
    autoreleasepool(|_| {
        let source = NSString::from_str(source);
        let script = NSAppleScript::initWithSource(NSAppleScript::alloc(), &source)
            .ok_or((0, "the AppleScript could not be built".to_string()))?;
        let mut info: Option<Retained<NSDictionary<NSString, AnyObject>>> = None;

        // Through `msg_send!`, because the binding declares the result
        // non-null and the method answers nil on an error.
        let result: Option<Retained<NSAppleEventDescriptor>> =
            unsafe { msg_send![&script, executeAndReturnError: Some(&mut info)] };

        if result.is_some() {
            return Ok(());
        }

        let Some(info) = info else {
            return Err((0, "the AppleScript failed with no error".to_string()));
        };

        // Safety: both keys are the documented `NSString` constants.
        let (number_key, message_key) =
            unsafe { (NSAppleScriptErrorNumber, NSAppleScriptErrorMessage) };
        let number = info
            .objectForKey(number_key)
            .and_then(|value| value.downcast::<NSNumber>().ok())
            .map_or(0, |number| number.integerValue());
        let message = info
            .objectForKey(message_key)
            .and_then(|value| value.downcast::<NSString>().ok())
            .map_or_else(
                || format!("AppleScript error {number}"),
                |text| text.to_string(),
            );

        Err((number, message))
    })
}

/// How a child ended, as the parent reads it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Done,
    Cancelled,
    /// A file or a folder that is not a link stands at the link path.
    Occupied,
    Failed(String),
}

/// The outcome of an exit code and the child's stderr. A child ended by a
/// signal has no code, and counts as a failure.
fn outcome(code: Option<i32>, stderr: &[u8]) -> Outcome {
    match code {
        Some(EXIT_DONE) => Outcome::Done,
        Some(EXIT_CANCELLED) => Outcome::Cancelled,
        Some(EXIT_OCCUPIED) => Outcome::Occupied,
        _ => {
            let text = String::from_utf8_lossy(stderr);
            let line = text.lines().find(|line| !line.trim().is_empty());

            Outcome::Failed(match (line, code) {
                (Some(line), _) => line.trim().to_string(),
                (None, Some(code)) => format!("the helper process exited with code {code}"),
                (None, None) => "the helper process was stopped by a signal".to_string(),
            })
        }
    }
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Proof that this caller holds the one child slot. Dropped, it frees it.
pub(crate) struct Running(());

impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Takes the one child slot, unless a child already runs: its password dialog
/// is open, and a second dialog would stack on it.
pub(crate) fn begin() -> Option<Running> {
    RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .ok()
        .map(|_| Running(()))
}

pub(crate) fn busy() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// Runs a step in a child process of `executable`, waiting off the main thread.
pub(crate) async fn perform(executable: PathBuf, step: Step, _running: &Running) -> Outcome {
    let waited = tauri::async_runtime::spawn_blocking(move || {
        Command::new(executable)
            .arg(step.argument())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
    })
    .await;

    match waited {
        Ok(Ok(output)) => outcome(output.status.code(), &output.stderr),
        Ok(Err(error)) => Outcome::Failed(format!("the helper process could not start: {error}")),
        Err(error) => Outcome::Failed(format!("the helper process was lost: {error}")),
    }
}

/// How an install ended.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Linked {
    Already,
    Now,
    Cancelled,
    /// Another child's password dialog is open.
    Busy,
    /// Something Tasma did not make stands at the link.
    NotOurs,
    Failed(String),
}

/// Links `link` to the CLI beside `executable`, when it is missing or stale.
/// Only the password dialog appears.
pub(crate) async fn ensure_link(link: &Path, executable: PathBuf) -> Linked {
    match link_state(link, &cli_beside(&executable)) {
        LinkState::Installed => Linked::Already,
        LinkState::Foreign => Linked::NotOurs,
        LinkState::Unreadable(line) => Linked::Failed(line),
        LinkState::Missing | LinkState::Stale { .. } => {
            let Some(running) = begin() else {
                return Linked::Busy;
            };

            match perform(executable, Step::Install, &running).await {
                Outcome::Done => Linked::Now,
                Outcome::Cancelled => Linked::Cancelled,
                Outcome::Occupied => Linked::NotOurs,
                Outcome::Failed(line) => Linked::Failed(line),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::ffi::OsStrExt as _;
    use std::os::unix::fs::symlink;

    use super::*;
    use crate::testing::{directory, script_file};

    fn linked(link: &Path, executable: &Path) -> Linked {
        tauri::async_runtime::block_on(ensure_link(link, executable.to_path_buf()))
    }

    #[test]
    fn a_state_that_needs_no_child_is_answered_without_one() {
        let root = directory("ensure-link");
        let executable = root.join("Sample");
        let link = root.join("tasma");

        symlink(cli_beside(&executable), &link).unwrap();
        assert_eq!(linked(&link, &executable), Linked::Already);

        std::fs::remove_file(&link).unwrap();
        std::fs::write(&link, "").unwrap();
        assert_eq!(linked(&link, &executable), Linked::NotOurs);

        // A file where a folder is expected.
        assert!(matches!(
            linked(&link.join("tasma"), &executable),
            Linked::Failed(_)
        ));
    }

    #[test]
    fn the_first_argument_selects_a_step() {
        assert_eq!(
            requested(Some(OsStr::new("--install-command-line-tool"))),
            Some(Step::Install)
        );
        assert_eq!(
            requested(Some(OsStr::new("--remove-command-line-tool"))),
            Some(Step::Remove)
        );
    }

    #[test]
    fn any_other_argument_starts_the_window() {
        assert_eq!(requested(None), None);
        assert_eq!(requested(Some(OsStr::new("-psn_0_12345"))), None);
        assert_eq!(requested(Some(OsStr::new("--install"))), None);
    }

    #[test]
    fn the_install_script_quotes_the_target_for_applescript_and_the_shell() {
        let text = script(
            Step::Install,
            r#"/Applications/My "Tools"/A\B's/Sample.app/Contents/MacOS/tasma-cli"#,
        );

        assert_eq!(
            text,
            r#"do shell script "mkdir -p /usr/local/bin && if [ -e /usr/local/bin/tasma ] && [ ! -L /usr/local/bin/tasma ]; then exit 3; fi && ln -sfn " & quoted form of "/Applications/My \"Tools\"/A\\B's/Sample.app/Contents/MacOS/tasma-cli" & " /usr/local/bin/tasma" with prompt "Tasma wants to install the tasma command in /usr/local/bin." with administrator privileges"#,
        );
    }

    #[test]
    fn the_remove_script_removes_only_a_link() {
        assert_eq!(
            script(Step::Remove, "/unused"),
            r#"do shell script "if [ -L /usr/local/bin/tasma ]; then rm /usr/local/bin/tasma; fi" with prompt "Tasma wants to remove the tasma command from /usr/local/bin." with administrator privileges"#,
        );
    }

    #[test]
    fn an_applescript_error_carries_its_number_and_message() {
        assert_eq!(execute(r#"return "x""#), Ok(()));
        assert_eq!(
            execute(r#"error "planted failure" number 42"#),
            Err((42, "planted failure".to_string())),
        );
        assert_eq!(
            execute("error number 43").map_err(|(number, _)| number),
            Err(43)
        );
        assert_eq!(
            execute("error number -128").map_err(|(number, _)| number),
            Err(USER_CANCELED),
        );
        assert!(execute("this is not ( applescript").is_err());
    }

    #[test]
    fn an_exit_code_maps_to_an_outcome() {
        assert_eq!(outcome(Some(0), b""), Outcome::Done);
        assert_eq!(outcome(Some(1), b""), Outcome::Cancelled);
        assert_eq!(outcome(Some(3), b""), Outcome::Occupied);
        assert_eq!(
            outcome(Some(2), b"\nthe disk is locked\nmore\n"),
            Outcome::Failed("the disk is locked".to_string()),
        );
        assert_eq!(
            outcome(Some(9), b""),
            Outcome::Failed("the helper process exited with code 9".to_string()),
        );
    }

    #[test]
    fn a_child_ended_by_a_signal_counts_as_a_failure() {
        assert_eq!(
            outcome(None, b""),
            Outcome::Failed("the helper process was stopped by a signal".to_string()),
        );
        assert_eq!(
            outcome(None, b"half a line"),
            Outcome::Failed("half a line".to_string()),
        );
    }

    #[test]
    fn a_failure_message_is_one_line() {
        assert_eq!(failed("one\ntwo\rthree"), EXIT_FAILED);
    }

    #[test]
    fn a_step_outside_an_applications_folder_fails() {
        // The test executable stands under `target/`.
        assert_eq!(run(Step::Install), EXIT_FAILED);
    }

    const HOME: &str = "/Users/someone";
    const INSTALLED: &str = "/Users/someone/Applications/Sample.app/Contents/MacOS/Sample";

    fn run_installed(step: Step, result: Result<(), (isize, String)>) -> i32 {
        run_as(
            Path::new(INSTALLED),
            Some(Path::new(HOME)),
            step,
            |source| {
                assert_eq!(
                    source,
                    script(
                        step,
                        "/Users/someone/Applications/Sample.app/Contents/MacOS/tasma-cli"
                    )
                );
                result
            },
        )
    }

    #[test]
    fn the_script_result_maps_to_the_exit_code() {
        assert_eq!(run_installed(Step::Install, Ok(())), EXIT_DONE);
        assert_eq!(
            run_installed(Step::Remove, Err((USER_CANCELED, "cancelled".into()))),
            EXIT_CANCELLED
        );
        assert_eq!(
            run_installed(Step::Install, Err((SCRIPT_OCCUPIED, "exit 3".into()))),
            EXIT_OCCUPIED
        );
        assert_eq!(
            run_installed(Step::Remove, Err((SCRIPT_OCCUPIED, "exit 3".into()))),
            EXIT_FAILED
        );
        assert_eq!(
            run_installed(Step::Install, Err((-60005, "wrong password".into()))),
            EXIT_FAILED
        );
    }

    #[test]
    fn a_path_that_is_not_utf8_fails_before_any_script() {
        let executable = Path::new(OsStr::from_bytes(
            b"/Applications/\xff.app/Contents/MacOS/Sample",
        ));

        let code = run_as(executable, None, Step::Install, |_| {
            panic!("no script runs for a path it cannot name")
        });

        assert_eq!(code, EXIT_FAILED);
    }

    #[test]
    fn only_one_child_runs_at_a_time() {
        let first = begin().expect("no child runs yet");

        assert!(begin().is_none());
        assert!(busy());

        let executable = script_file(
            &directory("one-child").join("helper"),
            r#"[ "$1" = --remove-command-line-tool ] || exit 7
echo 'the disk is locked' >&2
exit 2"#,
        );
        let ended = tauri::async_runtime::block_on(perform(executable, Step::Remove, &first));

        assert_eq!(ended, Outcome::Failed("the disk is locked".to_string()));

        drop(first);
        let again = begin();

        assert!(again.is_some());

        let ended = tauri::async_runtime::block_on(perform(
            Path::new("/nonexistent/helper").to_path_buf(),
            Step::Install,
            again.as_ref().unwrap(),
        ));

        assert!(
            matches!(&ended, Outcome::Failed(line) if line.starts_with("the helper process could not start")),
            "{ended:?}"
        );
    }
}
