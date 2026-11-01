//! The folder panel the board asks for, shown as a sheet on the window.

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2_app_kit::{
    NSModalResponse, NSModalResponseCancel, NSModalResponseOK, NSOpenPanel, NSWindow,
};
use objc2_foundation::NSString;
use tauri::http::{Method, Response, StatusCode};
use tauri::{AppHandle, Manager as _, Runtime};

use crate::alert::on_main;
use crate::log;
use crate::update::{json, plain};

/// The route under `/app`. Held to `FOLDER_ROUTE` in `apps/web` by a repo
/// test.
pub(crate) const PATH: &str = "/folder";

static OPEN: AtomicBool = AtomicBool::new(false);

/// Held by every test that touches the one sheet, so tests that run in
/// parallel never find it busy.
#[cfg(test)]
static SLOT: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Proof that this pick holds the one sheet. Dropped, it frees it.
struct Open(());

impl Drop for Open {
    fn drop(&mut self) {
        OPEN.store(false, Ordering::SeqCst);
    }
}

/// Takes the one sheet, unless a pick already holds it.
fn begin() -> Option<Open> {
    OPEN.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .ok()
        .map(|_| Open(()))
}

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Folder(String),
    Cancelled,
    /// The cause, for the log: the board gets an empty `500`.
    Failed(String),
}

fn failed(cause: &str) -> Outcome {
    Outcome::Failed(cause.to_string())
}

/// How a pick ended, from the panel's response and the path of its URL.
fn outcome(response: NSModalResponse, path: Option<String>) -> Outcome {
    match path {
        Some(path) if response == NSModalResponseOK => Outcome::Folder(path),
        None if response == NSModalResponseOK => failed("the panel chose no path"),
        _ if response == NSModalResponseCancel => Outcome::Cancelled,
        _ => Outcome::Failed(format!("the panel answered {response}")),
    }
}

/// What the completion handler holds. Dropped unfinished, it frees the sheet
/// and closes the channel, which reads as a failure.
struct Reply {
    sender: Sender<Outcome>,
    open: Cell<Option<Open>>,
}

impl Reply {
    /// Frees the sheet before the outcome is sent, so a pick that starts on
    /// the answer never finds it busy.
    fn finish(&self, outcome: Outcome) {
        drop(self.open.take());
        let _ = self.sender.send(outcome);
    }
}

fn answer(outcome: Outcome) -> Response<Vec<u8>> {
    match outcome {
        Outcome::Folder(path) => json(&serde_json::json!({ "path": path })),
        Outcome::Cancelled => json(&serde_json::json!({ "path": null })),
        Outcome::Failed(_) => plain(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Opens the panel as a sheet on the window and returns at once. A failure
/// before the sheet opens finishes the reply.
fn present<R: Runtime>(marker: MainThreadMarker, app: &AppHandle<R>, reply: Reply) {
    let Some(window) = app.get_webview_window(crate::WINDOW) else {
        reply.finish(failed("no window holds the sheet"));
        return;
    };
    let pointer = match window.ns_window() {
        Ok(pointer) => pointer,
        Err(error) => {
            reply.finish(Outcome::Failed(format!(
                "the window has no NSWindow: {}",
                log::quoted(&error.to_string())
            )));
            return;
        }
    };
    // Safety: on the main thread, `ns_window` gives the live `NSWindow` of the
    // webview window.
    let Some(window) = (unsafe { Retained::retain(pointer.cast::<NSWindow>()) }) else {
        reply.finish(failed("the NSWindow is null"));
        return;
    };

    // No directory is set, so the panel opens on the folder of the last pick.
    let panel = NSOpenPanel::openPanel(marker);
    panel.setCanChooseDirectories(true);
    panel.setCanChooseFiles(false);
    panel.setAllowsMultipleSelection(false);
    panel.setCanCreateDirectories(true);
    panel.setPrompt(Some(&NSString::from_str("Choose")));

    // Nothing here may panic: an unwind out of a block aborts the process.
    let handler = RcBlock::new({
        let panel = panel.clone();

        move |response: NSModalResponse| {
            let path = if response == NSModalResponseOK {
                panel
                    .URL()
                    .and_then(|url| url.path())
                    .map(|path| path.to_string())
            } else {
                None
            };

            reply.finish(outcome(response, path));
        }
    });

    panel.beginSheetModalForWindow_completionHandler(&window, &handler);
}

/// `POST /app/folder`: the absolute path of the folder picked, or `null` on
/// Cancel.
pub(crate) async fn serve<R: Runtime>(app: &AppHandle<R>, method: &Method) -> Response<Vec<u8>> {
    if *method != Method::POST {
        return plain(StatusCode::METHOD_NOT_ALLOWED);
    }

    let Some(open) = begin() else {
        return plain(StatusCode::CONFLICT);
    };

    let (sender, receiver) = mpsc::channel();
    let reply = Reply {
        sender,
        open: Cell::new(Some(open)),
    };
    let handle = app.clone();

    let outcome = if on_main(app, move |marker| present(marker, &handle, reply))
        .await
        .is_none()
    {
        failed("the main thread did not run the panel")
    } else {
        // Off the async runtime's workers, so a sheet that stays open holds none.
        tauri::async_runtime::spawn_blocking(move || receiver.recv())
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_else(|| failed("the panel gave no answer"))
    };

    if let Outcome::Failed(cause) = &outcome {
        let file = log::open(std::env::home_dir().as_deref()).ok();
        log::note(file.as_ref(), &format!("a folder pick failed: {cause}"));
    }

    answer(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    use tauri::http::header::{CACHE_CONTROL, CONTENT_TYPE};
    use tauri::test::mock_app;

    fn slot() -> std::sync::MutexGuard<'static, ()> {
        SLOT.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn served(method: Method) -> Response<Vec<u8>> {
        let app = mock_app();

        tauri::async_runtime::block_on(serve(app.handle(), &method))
    }

    fn reply(open: Open) -> (Reply, mpsc::Receiver<Outcome>) {
        let (sender, receiver) = mpsc::channel();

        (
            Reply {
                sender,
                open: Cell::new(Some(open)),
            },
            receiver,
        )
    }

    fn parsed(answer: &Response<Vec<u8>>) -> serde_json::Value {
        serde_json::from_slice(answer.body()).unwrap()
    }

    #[test]
    fn a_method_other_than_post_is_not_allowed() {
        for method in [Method::GET, Method::PUT, Method::DELETE] {
            let answer = served(method.clone());

            assert_eq!(answer.status(), StatusCode::METHOD_NOT_ALLOWED, "{method}");
            assert_eq!(answer.headers().get(CONTENT_TYPE).unwrap(), "text/plain");
            assert_eq!(answer.headers().get(CACHE_CONTROL).unwrap(), "no-store");
            assert!(answer.body().is_empty());
        }
    }

    #[test]
    fn a_pick_while_the_sheet_is_open_is_refused() {
        let _slot = slot();
        let open = begin().expect("no sheet is open yet");

        let answer = served(Method::POST);

        assert_eq!(answer.status(), StatusCode::CONFLICT);
        assert!(answer.body().is_empty());
        assert!(begin().is_none(), "the refused pick leaves the sheet held");

        drop(open);
    }

    #[test]
    fn a_dropped_guard_frees_the_sheet() {
        let _slot = slot();
        let open = begin().expect("no sheet is open yet");

        assert!(begin().is_none());

        drop(open);

        assert!(begin().is_some());
    }

    #[test]
    fn a_reply_dropped_unfinished_frees_the_sheet_and_reads_as_a_failure() {
        let _slot = slot();
        let (reply, receiver) = reply(begin().expect("no sheet is open yet"));

        drop(reply);

        assert!(receiver.recv().is_err());
        assert!(begin().is_some());
    }

    #[test]
    fn a_finished_reply_frees_the_sheet_before_it_sends() {
        let _slot = slot();
        let (reply, receiver) = reply(begin().expect("no sheet is open yet"));

        reply.finish(Outcome::Cancelled);

        assert_eq!(receiver.recv(), Ok(Outcome::Cancelled));
        let newer = begin().expect("the finished pick freed the sheet");

        // The block of the old pick is released after a newer pick holds the
        // sheet.
        drop(reply);

        assert!(
            begin().is_none(),
            "the old reply leaves the newer pick's sheet held"
        );

        drop(newer);
    }

    #[test]
    fn a_pick_with_no_window_finishes_with_its_cause() {
        let _slot = slot();
        let app = mock_app();
        let (reply, receiver) = reply(begin().expect("no sheet is open yet"));
        // Safety: with no window, `present` returns before it reaches AppKit.
        let marker = unsafe { MainThreadMarker::new_unchecked() };

        present(marker, app.handle(), reply);

        assert_eq!(receiver.recv(), Ok(failed("no window holds the sheet")));
        assert!(begin().is_some());
    }

    #[test]
    fn the_outcome_follows_the_response_of_the_panel() {
        let path = || Some("/Users/someone/Projects/alpha".to_string());

        assert_eq!(
            outcome(NSModalResponseOK, path()),
            Outcome::Folder("/Users/someone/Projects/alpha".to_string())
        );
        assert_eq!(outcome(NSModalResponseCancel, None), Outcome::Cancelled);
        assert_eq!(
            outcome(NSModalResponseOK, None),
            failed("the panel chose no path")
        );
        assert_eq!(outcome(-1001, None), failed("the panel answered -1001"));
        assert_eq!(outcome(-1001, path()), failed("the panel answered -1001"));
    }

    #[test]
    fn a_folder_is_answered_with_its_path() {
        let answer = answer(Outcome::Folder("/Users/someone/a \"b\"".to_string()));

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(
            answer.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert_eq!(answer.headers().get(CACHE_CONTROL).unwrap(), "no-store");
        assert_eq!(
            parsed(&answer),
            serde_json::json!({ "path": "/Users/someone/a \"b\"" })
        );
    }

    #[test]
    fn a_cancel_is_answered_with_no_path() {
        let answer = answer(Outcome::Cancelled);

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(
            answer.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert_eq!(answer.headers().get(CACHE_CONTROL).unwrap(), "no-store");
        assert_eq!(parsed(&answer), serde_json::json!({ "path": null }));
    }

    #[test]
    fn a_failure_is_answered_with_a_server_error() {
        let answer = answer(failed("the panel gave no answer"));

        assert_eq!(answer.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(answer.headers().get(CONTENT_TYPE).unwrap(), "text/plain");
        assert_eq!(answer.headers().get(CACHE_CONTROL).unwrap(), "no-store");
        assert!(answer.body().is_empty());
    }
}
