//! The default menu, with "Install Command Line Tool…" and "Uninstall
//! Tasma…" in the Tasma menu.

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

const INSTALL: &str = "install-command-line-tool";
const UNINSTALL: &str = "uninstall-tasma";

const INSTALLED: &str = "The tasma command is installed.";
const NOT_INSTALLED: &str = "Tasma did not install the tasma command.";
const FAILED: &str = "Tasma could not install the tasma command.";

/// What the menu actions reach beyond the application handle.
pub(crate) struct Shell {
    pub(crate) daemon: Arc<Daemon>,
    pub(crate) uninstalling: Arc<AtomicBool>,
}

struct Items {
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

/// Sets the menu. It must stay the default menu plus the two items: copy,
/// paste and select-all reach the webview only through it.
pub(crate) fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
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

        first.insert(&install, at)?;
        first.insert(&uninstall, at + 1)?;
        first.insert(&PredefinedMenuItem::separator(app)?, at + 2)?;
    }

    app.set_menu(menu)?;
    app.manage(Items { install, uninstall });

    Ok(())
}

/// Enables or disables both items. Called on the main thread.
pub(crate) fn enable(app: &AppHandle, enabled: bool) {
    if let Some(items) = app.try_state::<Items>() {
        let _ = items.install.set_enabled(enabled);
        let _ = items.uninstall.set_enabled(enabled);
    }
}

pub(crate) fn dispatch(app: &AppHandle, id: &MenuId) {
    if id == INSTALL {
        tauri::async_runtime::spawn(install(app.clone()));
    } else if id == UNINSTALL {
        let shell = app.state::<Shell>();

        tauri::async_runtime::spawn(uninstall::run(
            app.clone(),
            Arc::clone(&shell.daemon),
            Arc::clone(&shell.uninstalling),
        ));
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
    fn a_menu_with_no_separator_has_no_place_for_them() {
        assert_eq!(
            after_first_separator(&texts(&[Some("About Sample"), None])),
            None
        );
    }
}
