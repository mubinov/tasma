//! The default menu, with "Check for Updates…", "Install Command Line Tool…"
//! and "Uninstall Tasma…" in the Tasma menu, and "Actual Size", "Zoom In" and
//! "Zoom Out" in the View menu.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use tauri::menu::{IsMenuItem, Menu, MenuId, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager as _, Runtime, Wry};

use crate::alert;
use crate::command::{LINK, account_home, installed_executable};
use crate::daemon::Daemon;
use crate::elevate::{self, Linked};
use crate::uninstall;
use crate::update::{Origin, Updater};
use crate::zoom::{self, Change};

const CHECK: &str = "check-for-updates";
const INSTALL: &str = "install-command-line-tool";
const UNINSTALL: &str = "uninstall-tasma";
const ACTUAL_SIZE: &str = "zoom-actual-size";
const ZOOM_IN: &str = "zoom-in";
const ZOOM_OUT: &str = "zoom-out";

const VIEW_MENU: &str = "View";
const WINDOW_MENU: &str = "Window";

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
    actual_size: MenuItem<Wry>,
    zoom_in: MenuItem<Wry>,
    zoom_out: MenuItem<Wry>,
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

/// Where the submenu titled `title` is among the titles of the menu bar.
fn position_of(titles: &[Option<String>], title: &str) -> Option<usize> {
    titles
        .iter()
        .position(|text| text.as_deref() == Some(title))
}

/// Sets the menu. It must stay the default menu plus the six items: copy,
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

    let actual_size =
        MenuItem::with_id(app, ACTUAL_SIZE, "Actual Size", true, Some("CmdOrCtrl+0"))?;
    let zoom_in = MenuItem::with_id(app, ZOOM_IN, "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, ZOOM_OUT, "Zoom Out", true, Some("CmdOrCtrl+-"))?;

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

    add_to_view(app, &menu, &[&actual_size, &zoom_in, &zoom_out])?;

    app.set_menu(menu)?;
    app.manage(Items {
        check,
        install,
        uninstall,
        actual_size,
        zoom_in,
        zoom_out,
    });
    show_zoom(app, app.state::<zoom::Level>().get());

    Ok(())
}

/// Puts the zoom items at the top of the View menu, or in a View menu of their
/// own when the default menu has none: they carry the only zoom shortcuts.
fn add_to_view(
    app: &AppHandle,
    menu: &Menu<Wry>,
    items: &[&dyn IsMenuItem<Wry>],
) -> tauri::Result<()> {
    let submenus = menu.items()?;
    let titles: Vec<Option<String>> = submenus
        .iter()
        .map(|item| item.as_submenu().and_then(|submenu| submenu.text().ok()))
        .collect();

    if let Some(view) = position_of(&titles, VIEW_MENU).and_then(|at| submenus[at].as_submenu()) {
        view.insert_items(items, 0)?;
        return view.insert(&PredefinedMenuItem::separator(app)?, items.len());
    }

    let view = Submenu::with_items(app, VIEW_MENU, true, items)?;

    menu.insert(
        &view,
        position_of(&titles, WINDOW_MENU).unwrap_or(titles.len()),
    )
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

/// Enables each zoom item by the level the window shows. Uninstall and the
/// update leave these items as they are.
pub(crate) fn show_zoom<R: Runtime>(app: &AppHandle<R>, level: u16) {
    let Some(items) = app.try_state::<Items>() else {
        return;
    };
    let (actual_size, zoom_in, zoom_out) = zoom::enabled(level);

    let _ = items.actual_size.set_enabled(actual_size);
    let _ = items.zoom_in.set_enabled(zoom_in);
    let _ = items.zoom_out.set_enabled(zoom_out);
}

/// The change a zoom item makes, or none for any other item.
fn zoom_change(id: &str) -> Option<Change> {
    match id {
        ACTUAL_SIZE => Some(Change::ActualSize),
        ZOOM_IN => Some(Change::In),
        ZOOM_OUT => Some(Change::Out),
        _ => None,
    }
}

pub(crate) fn dispatch(app: &AppHandle, id: &MenuId) {
    if let Some(change) = zoom_change(id.as_ref()) {
        zoom::change(app, change);
        return;
    }

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

    #[test]
    fn a_submenu_is_found_by_its_title() {
        let bar = texts(&[
            Some("Sample"),
            Some("Edit"),
            None,
            Some(VIEW_MENU),
            Some(WINDOW_MENU),
        ]);

        assert_eq!(position_of(&bar, VIEW_MENU), Some(3));
        assert_eq!(position_of(&bar, WINDOW_MENU), Some(4));
    }

    #[test]
    fn a_menu_bar_without_the_title_has_no_such_submenu() {
        assert_eq!(
            position_of(&texts(&[Some("Sample"), None]), VIEW_MENU),
            None
        );
    }

    #[test]
    fn each_zoom_item_makes_its_own_change() {
        assert_eq!(zoom_change(ACTUAL_SIZE), Some(Change::ActualSize));
        assert_eq!(zoom_change(ZOOM_IN), Some(Change::In));
        assert_eq!(zoom_change(ZOOM_OUT), Some(Change::Out));
        assert_eq!(zoom_change(CHECK), None);
    }
}
