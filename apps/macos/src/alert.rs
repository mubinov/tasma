//! Native alerts, run on the main thread.

use objc2::rc::Retained;
use objc2::{MainThreadMarker, sel};
use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSApplication, NSButton, NSView};
use objc2_foundation::{NSObjectProtocol as _, NSString};
use tauri::{AppHandle, Runtime};

/// The key a button answers.
#[derive(Clone, Copy)]
pub(crate) enum Key {
    /// What `NSAlert` gives it: Return for the first button, Escape for a
    /// later button titled "Cancel".
    Default,
    Escape,
    None,
}

#[derive(Clone, Copy)]
pub(crate) struct Button {
    pub(crate) title: &'static str,
    pub(crate) key: Key,
    pub(crate) destructive: bool,
}

pub(crate) const OK: Button = Button {
    title: "OK",
    key: Key::Default,
    destructive: false,
};

/// Runs `task` on the main thread and answers what it returns. The wait is
/// off the async runtime's workers, so an alert that stays open holds none.
pub(crate) async fn on_main<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    task: impl FnOnce(MainThreadMarker) -> T + Send + 'static,
) -> Option<T> {
    let (sender, receiver) = std::sync::mpsc::channel();

    app.run_on_main_thread(move || {
        let marker = MainThreadMarker::new().expect("run_on_main_thread runs on the main thread");
        let _ = sender.send(task(marker));
    })
    .ok()?;

    tauri::async_runtime::spawn_blocking(move || receiver.recv().ok())
        .await
        .ok()
        .flatten()
}

/// Shows one alert with one OK button.
pub(crate) async fn notice<R: Runtime>(app: &AppHandle<R>, title: &'static str, text: String) {
    on_main(app, move |marker| {
        show(marker, title, &text, &[OK], None);
    })
    .await;
}

pub(crate) async fn move_to_applications<R: Runtime>(app: &AppHandle<R>) {
    notice(
        app,
        "Move Tasma to the Applications folder.",
        "Then open Tasma again and try again.".into(),
    )
    .await;
}

/// The dialog belongs to a system process that Command-Tab does not list, so
/// the person may not see where it went.
pub(crate) async fn waiting_for_password<R: Runtime>(app: &AppHandle<R>) {
    notice(
        app,
        "Tasma is waiting for the administrator password.",
        "Answer the password dialog first.".into(),
    )
    .await;
}

/// Asks macOS to make this the active application. Most alerts follow a
/// dialog of another process or a closed window, and an alert of an inactive
/// application is not the key window: VoiceOver skips it and Return goes
/// elsewhere. macOS may refuse while the person works in another application.
fn activate(marker: MainThreadMarker) {
    let application = NSApplication::sharedApplication(marker);

    if application.respondsToSelector(sel!(activate)) {
        application.activate();
    } else {
        #[allow(deprecated)]
        application.activateIgnoringOtherApps(true);
    }
}

/// Shows one alert and answers the index of the button chosen. With
/// `focus`, keyboard focus starts on that button rather than where AppKit
/// puts it.
pub(crate) fn show(
    marker: MainThreadMarker,
    title: &str,
    text: &str,
    buttons: &[Button],
    focus: Option<usize>,
) -> usize {
    activate(marker);

    let alert = NSAlert::new(marker);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(text));

    let made: Vec<Retained<NSButton>> = buttons
        .iter()
        .map(|button| {
            let made = alert.addButtonWithTitle(&NSString::from_str(button.title));

            match button.key {
                Key::Default => {}
                Key::Escape => made.setKeyEquivalent(&NSString::from_str("\u{1b}")),
                Key::None => made.setKeyEquivalent(&NSString::from_str("")),
            }

            // From macOS 11.
            if button.destructive && made.respondsToSelector(sel!(setHasDestructiveAction:)) {
                made.setHasDestructiveAction(true);
            }

            made
        })
        .collect();

    if let Some(button) = focus.and_then(|index| made.get(index)) {
        alert.layout();
        let view: &NSView = button;
        alert.window().setInitialFirstResponder(Some(view));
    }

    let chosen = alert.runModal() - NSAlertFirstButtonReturn;

    usize::try_from(chosen).unwrap_or(0)
}
