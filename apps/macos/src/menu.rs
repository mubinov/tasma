//! The default menu, with "Check for Updates…", "Install Command Line Tool…"
//! and "Uninstall Tasma…" in the Tasma menu.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use tauri::menu::{Menu, MenuId, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{AppHandle, Manager as _, Wry};

use crate::alert;
use crate::command::{LINK, account_home, installed_executable};
use crate::daemon::Daemon;
use crate::elevate::{self, Linked};
use crate::uninstall;
use crate::update::{Origin, Updater};

const CHECK: &str = "check-for-updates";
const INSTALL: &str = "install-command-line-tool";
const UNINSTALL: &str = "uninstall-tasma";

const INSTALLED: &str = "The tasma command is installed.";
const NOT_INSTALLED: &str = "Tasma did not install the tasma command.";
const FAILED: &str = "Tasma could not install the tasma command.";

/// What the menu actions reach beyond the application handle.
pub(crate) struct Shell {
    pub(crate) daemon: Arc<Daemon>,
    pub(crate) uninstalling: Arc<AtomicBool>,
    pub(crate) updater: Arc<Updater>,
}

struct Items {
    check: MenuItem<Wry>,
    install: MenuItem<Wry>,
    uninstall: MenuItem<Wry>,
}

/// Where the items go: directly after the first separator, which follows
/// "About Tasma". Tauri exposes no kind for a predefined item, and a separator
/// is the one predefined item with empty text.
fn after_first_separator(texts: &[Option<String>]) -> Option<usize> {
    texts
        .iter()
        .position(|text| text.as_deref() == Some(""))
        .map(|at| at + 1)
}

/// Sets the menu. It must stay the default menu plus the three items: copy,
/// paste and select-all reach the webview only through it.
pub(crate) fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let check = MenuItem::with_id(app, CHECK, "Check for Updates…", true, None::<&str>)?;
    let install = MenuItem::with_id(
        app,
        INSTALL,
        "Install Command Line Tool…",
        true,
        None::<&str>,
    )?;
    let uninstall = MenuItem::with_id(app, UNINSTALL, "Uninstall Tasma…", true, None::<&str>)?;

    if let Some(MenuItemKind::Submenu(first)) = menu.items()?.into_iter().next() {
        let texts: Vec<Option<String>> = first
            .items()?
            .iter()
            .map(|item| match item {
                MenuItemKind::Predefined(item) => item.text().ok(),
                _ => None,
            })
            .collect();
        let at = after_first_separator(&texts).unwrap_or(texts.len());

        first.insert(&check, at)?;
        first.insert(&install, at + 1)?;
        first.insert(&uninstall, at + 2)?;
        first.insert(&PredefinedMenuItem::separator(app)?, at + 3)?;
    }

    app.set_menu(menu)?;
    app.manage(Items {
        check,
        install,
        uninstall,
    });

    Ok(())
}

/// Which items are enabled: (check, install, uninstall). Uninstall disables
/// all three, and an update that installs or waits for its restart disables
/// the two that would change the bundle.
fn enabled(uninstall_pending: bool, updating: bool) -> (bool, bool, bool) {
    let free = !uninstall_pending && !updating;

    (!uninstall_pending, free, free)
}

/// Enables each item by what Uninstall and the update do now. Called on the
/// main thread, after each change of either.
pub(crate) fn refresh(app: &AppHandle) {
    let (Some(items), Some(shell)) = (app.try_state::<Items>(), app.try_state::<Shell>()) else {
        return;
    };
    let (check, install, uninstall) =
        enabled(shell.updater.uninstall_pending(), shell.updater.busy());

    let _ = items.check.set_enabled(check);
    let _ = items.install.set_enabled(install);
    let _ = items.uninstall.set_enabled(uninstall);
}

pub(crate) fn dispatch(app: &AppHandle, id: &MenuId) {
    let shell = app.state::<Shell>();

    if id == CHECK {
        tauri::async_runtime::spawn(check(app.clone(), Arc::clone(&shell.updater)));
    } else if id == INSTALL {
        tauri::async_runtime::spawn(install(app.clone()));
    } else if id == UNINSTALL {
        tauri::async_runtime::spawn(uninstall::run(
            app.clone(),
            Arc::clone(&shell.daemon),
            Arc::clone(&shell.updater),
            Arc::clone(&shell.uninstalling),
        ));
    }
}

async fn check(app: AppHandle, updater: Arc<Updater>) {
    if let Some((title, text)) = updater.check(Origin::Menu).await {
        alert::notice(&app, title, text).await;
    }
}

async fn install(app: AppHandle) {
    if elevate::busy() {
        alert::waiting_for_password(&app).await;
        return;
    }

    let Some(executable) = installed_executable(account_home().as_deref()) else {
        alert::move_to_applications(&app).await;
        return;
    };

    let (title, text) = match elevate::ensure_link(Path::new(LINK), executable).await {
        Linked::Already => (INSTALLED, format!("{LINK} opens this copy of Tasma.")),
        Linked::Now => (INSTALLED, "Open a new terminal window to use tasma.".into()),
        Linked::Cancelled => return,
        Linked::Busy => {
            alert::waiting_for_password(&app).await;
            return;
        }
        Linked::NotOurs => (
            NOT_INSTALLED,
            format!(
                "{LINK} already exists and does not belong to Tasma. Remove it, then try again."
            ),
        ),
        Linked::Failed(line) => (FAILED, format!("macOS reported this error: {line}")),
    };

    alert::notice(&app, title, text).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(items: &[Option<&str>]) -> Vec<Option<String>> {
        items.iter().map(|text| text.map(str::to_string)).collect()
    }

    #[test]
    fn the_items_go_after_the_first_separator() {
        let menu = texts(&[
            Some("About Sample"),
            Some(""),
            Some("Services"),
            Some(""),
            None,
        ]);

        assert_eq!(after_first_separator(&menu), Some(2));
    }

    #[test]
    fn uninstall_disables_every_item_and_an_update_the_two_that_change_the_bundle() {
        assert_eq!(enabled(false, false), (true, true, true));
        assert_eq!(enabled(true, false), (false, false, false));
        assert_eq!(enabled(false, true), (true, false, false));
        assert_eq!(enabled(true, true), (false, false, false));
    }

    #[test]
    fn a_menu_with_no_separator_has_no_place_for_them() {
        assert_eq!(
            after_first_separator(&texts(&[Some("About Sample"), None])),
            None
        );
    }
}
