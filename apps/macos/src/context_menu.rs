//! The native context menu of the web view. WebKit fills it with page, link,
//! lookup and system items; only the text items stay, and a menu with no item
//! left does not open.
//!
//! macOS adds Services and AutoFill after `willOpenMenu:withEvent:`, so the
//! filter never sees them, and `allowsContextMenuPlugIns` set there is too late.

use std::mem;
use std::ptr;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, NSObjectProtocol as _, Sel};
use objc2::{MainThreadMarker, MainThreadOnly as _, ffi, msg_send, sel};
use objc2_app_kit::{NSMenu, NSMenuItem, NSUserInterfaceItemIdentification as _};
use objc2_foundation::ns_string;
use objc2_web_kit::WKWebView;
use tauri::{Runtime, WebviewWindow};

use crate::log;

// The tags WebKit sets on its items, the values of the legacy `WebMenuItemTag`
// enum in `WebKit/WebUIDelegate.h`.
const COPY: isize = 8;
const CUT: isize = 13;
const PASTE: isize = 14;
const SPELLING_GUESS: isize = 15;

/// The value of WebKit's exported constant `_WKMenuItemIdentifierInspectElement`.
/// No public enum holds the tag of the item.
const INSPECT_ELEMENT: &str = "WKMenuItemIdentifierInspectElement";

/// One item of a menu, as the keep rule reads it.
#[derive(Debug)]
struct Item {
    tag: isize,
    identifier: Option<String>,
    separator: bool,
}

/// What stays of a menu.
#[derive(Debug, PartialEq, Eq)]
struct Kept {
    /// The indexes of the items that stay, in their order.
    items: Vec<usize>,
    /// The index of Select All in the menu that stays, when it is added.
    select_all: Option<usize>,
}

fn stays(item: &Item) -> bool {
    matches!(item.tag, COPY | CUT | PASTE | SPELLING_GUESS)
        || item.identifier.as_deref() == Some(INSPECT_ELEMENT)
}

/// The keep rule. A separator stays only between two items that stay, and Select
/// All goes directly after Paste.
fn keep(items: &[Item]) -> Kept {
    let mut kept = Vec::new();
    let mut pending_separator = None;
    let mut select_all = None;

    for (index, item) in items.iter().enumerate() {
        if item.separator {
            if !kept.is_empty() {
                pending_separator = Some(index);
            }
        } else if stays(item) {
            kept.extend(pending_separator.take());
            kept.push(index);

            if item.tag == PASTE {
                select_all = Some(kept.len());
            }
        }
    }

    Kept {
        items: kept,
        select_all,
    }
}

/// The same as the items of WebKit: no target, so the first responder gets
/// `selectAll:`, and no key equivalent.
fn select_all_item(mtm: MainThreadMarker) -> Retained<NSMenuItem> {
    // Safety: `selectAll:` takes one object, the sender, as a menu action does.
    unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            ns_string!("Select All"),
            Some(sel!(selectAll:)),
            ns_string!(""),
        )
    }
}

fn filter(menu: &NSMenu) {
    let items: Vec<Item> = menu
        .itemArray()
        .to_vec()
        .iter()
        .map(|item| Item {
            tag: item.tag(),
            identifier: item.identifier().map(|identifier| identifier.to_string()),
            separator: item.isSeparatorItem(),
        })
        .collect();
    let kept = keep(&items);

    for index in (0..items.len()).rev() {
        if !kept.items.contains(&index) {
            menu.removeItemAtIndex(index.cast_signed());
        }
    }

    if let Some(index) = kept.select_all {
        menu.insertItem_atIndex(&select_all_item(menu.mtm()), index.cast_signed());
    }

    // From macOS 15.2.
    if menu.respondsToSelector(sel!(setAutomaticallyInsertsWritingToolsItems:)) {
        menu.setAutomaticallyInsertsWritingToolsItems(false);
    }

    if kept.items.is_empty() {
        menu.cancelTrackingWithoutAnimation();
    }
}

type WillOpenMenu = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, &NSMenu, *mut AnyObject);

/// The implementation of the superclass of the hooked class. It is never looked
/// up from the instance: KVO gives the web view a subclass of the hooked class,
/// whose superclass is the hooked class itself.
static INHERITED: OnceLock<WillOpenMenu> = OnceLock::new();

fn selector() -> Sel {
    sel!(willOpenMenu:withEvent:)
}

/// AppKit calls it on the main thread, on the view that a menu opens for, just
/// before the menu opens.
unsafe extern "C-unwind" fn will_open_menu(
    view: *mut AnyObject,
    cmd: Sel,
    menu: &NSMenu,
    event: *mut AnyObject,
) {
    if let Some(inherited) = INHERITED.get() {
        // Safety: the arguments are those AppKit passed, for the same selector.
        unsafe { inherited(view, cmd, menu, event) };
    }

    filter(menu);
}

/// Adds the filter to `class`, and answers the implementation of the superclass
/// that the filter calls first.
fn hook(class: &AnyClass) -> Result<WillOpenMenu, String> {
    let name = class.name().to_string_lossy();
    let inherited = class
        .superclass()
        .and_then(|superclass| superclass.instance_method(selector()))
        .ok_or_else(|| format!("{name} inherits no willOpenMenu:withEvent:"))?;
    // Safety: the method of `willOpenMenu:withEvent:` takes these arguments.
    let inherited = unsafe { mem::transmute::<Imp, WillOpenMenu>(inherited.implementation()) };

    // Safety: the class is registered, and the encoding names the types of
    // `will_open_menu`: no result, the receiver, the selector and two objects.
    let added = unsafe {
        ffi::class_addMethod(
            ptr::from_ref(class).cast_mut(),
            selector(),
            mem::transmute::<WillOpenMenu, Imp>(will_open_menu),
            c"v@:@@".as_ptr(),
        )
    };

    if !added.as_bool() {
        return Err(format!("{name} has its own willOpenMenu:withEvent:"));
    }

    Ok(inherited)
}

fn hook_in(webview: Option<Retained<WKWebView>>) -> Result<(), String> {
    let webview = webview.ok_or_else(|| "no web view".to_string())?;
    // Safety: `class` takes no argument. It answers the class that wry made,
    // where the run-time class can be a subclass that KVO made and can remove.
    let class: &'static AnyClass = unsafe { msg_send![&webview, class] };
    let inherited = hook(class)?;

    INHERITED.get_or_init(|| inherited);

    Ok(())
}

fn stays_unfiltered(cause: &str) {
    let file = log::open(std::env::home_dir().as_deref()).ok();
    log::note(
        file.as_ref(),
        &format!("the context menu stays unfiltered: {cause}"),
    );
}

/// Filters each context menu of the web view of the window. Called on the main
/// thread, where the closure runs before this returns. A failure keeps the menu
/// of WebKit and writes one line to the log.
pub(crate) fn install<R: Runtime>(window: &WebviewWindow<R>) {
    let installed = window.with_webview(|webview| {
        // Safety: on the main thread, `inner` gives the live `WKWebView` of the
        // window, or null.
        let webview = unsafe { Retained::retain(webview.inner().cast::<WKWebView>()) };

        if let Err(cause) = hook_in(webview) {
            stays_unfiltered(&cause);
        }
    });

    if let Err(error) = installed {
        stays_unfiltered(&log::quoted(&error.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use objc2::ClassType as _;
    use objc2::define_class;
    use objc2::runtime::NSObject;
    use objc2_foundation::NSString;
    use tauri::test::mock_app;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    use super::*;

    const BACK: isize = 9;
    const FORWARD: isize = 10;
    const RELOAD: isize = 12;
    const NO_GUESSES_FOUND: isize = 16;
    const IGNORE_SPELLING: isize = 17;
    const LEARN_SPELLING: isize = 18;
    const OTHER: isize = 19;
    const SEARCH_WEB: isize = 21;
    const LOOK_UP: isize = 22;
    const OPEN_LINK_IN_NEW_WINDOW: isize = 1;
    const DOWNLOAD_LINKED_FILE: isize = 2;
    const COPY_LINK: isize = 3;

    fn item(tag: isize) -> Item {
        Item {
            tag,
            identifier: None,
            separator: false,
        }
    }

    fn separator() -> Item {
        Item {
            tag: 0,
            identifier: None,
            separator: true,
        }
    }

    fn inspect_element() -> Item {
        Item {
            tag: 0,
            identifier: Some(INSPECT_ELEMENT.to_string()),
            separator: false,
        }
    }

    fn kept(items: &[usize], select_all: Option<usize>) -> Kept {
        Kept {
            items: items.to_vec(),
            select_all,
        }
    }

    #[test]
    fn the_page_menu_keeps_nothing() {
        let menu = [item(BACK), item(FORWARD), item(RELOAD)];

        assert_eq!(keep(&menu), kept(&[], None));
    }

    #[test]
    fn the_menu_of_selected_text_keeps_only_copy() {
        let menu = [
            item(LOOK_UP),
            item(OTHER),
            separator(),
            item(SEARCH_WEB),
            separator(),
            item(COPY),
            separator(),
            item(OTHER),
        ];

        assert_eq!(keep(&menu), kept(&[5], None));
    }

    #[test]
    fn the_menu_of_a_text_field_keeps_the_suggestions_and_the_edit_items() {
        let menu = [
            item(SPELLING_GUESS),
            item(SPELLING_GUESS),
            separator(),
            item(IGNORE_SPELLING),
            item(LEARN_SPELLING),
            separator(),
            item(LOOK_UP),
            separator(),
            item(CUT),
            item(COPY),
            item(PASTE),
            separator(),
            item(OTHER),
        ];

        assert_eq!(keep(&menu), kept(&[0, 1, 7, 8, 9, 10], Some(6)));
    }

    #[test]
    fn the_menu_of_a_link_keeps_nothing() {
        let menu = [
            item(OPEN_LINK_IN_NEW_WINDOW),
            item(DOWNLOAD_LINKED_FILE),
            separator(),
            item(COPY_LINK),
            separator(),
            item(OTHER),
        ];

        assert_eq!(keep(&menu), kept(&[], None));
    }

    #[test]
    fn inspect_element_stays_after_one_separator() {
        let menu = [
            item(COPY),
            separator(),
            item(OTHER),
            separator(),
            separator(),
            inspect_element(),
        ];

        assert_eq!(keep(&menu), kept(&[0, 4, 5], None));
    }

    #[test]
    fn inspect_element_stays_alone() {
        let menu = [item(BACK), item(RELOAD), separator(), inspect_element()];

        assert_eq!(keep(&menu), kept(&[3], None));
    }

    #[test]
    fn select_all_goes_directly_after_paste() {
        let menu = [
            item(CUT),
            item(COPY),
            item(PASTE),
            separator(),
            inspect_element(),
        ];

        assert_eq!(keep(&menu), kept(&[0, 1, 2, 3, 4], Some(3)));
    }

    #[test]
    fn no_separator_stays_at_the_start_or_the_end() {
        let menu = [separator(), item(COPY), separator()];

        assert_eq!(keep(&menu), kept(&[1], None));
    }

    #[test]
    fn no_separator_stays_where_no_item_stays_on_one_side() {
        let menu = [
            item(LOOK_UP),
            separator(),
            item(COPY),
            separator(),
            item(OTHER),
        ];

        assert_eq!(keep(&menu), kept(&[2], None));
    }

    #[test]
    fn no_guesses_found_goes() {
        let menu = [item(NO_GUESSES_FOUND), separator(), item(CUT), item(COPY)];

        assert_eq!(keep(&menu), kept(&[2, 3], None));
    }

    #[test]
    fn webkit_exports_the_identifier_of_inspect_element() {
        // Safety: the name is a C string, and WebKit is linked in.
        let symbol = unsafe {
            libc::dlsym(
                libc::RTLD_DEFAULT,
                c"_WKMenuItemIdentifierInspectElement".as_ptr(),
            )
        };
        assert!(!symbol.is_null());

        // Safety: the symbol is an `NSString *const`, set at load time.
        let identifier = unsafe { &**symbol.cast::<*const NSString>() };

        assert_eq!(identifier.to_string(), INSPECT_ELEMENT);
    }

    #[test]
    fn the_web_view_inherits_will_open_menu() {
        assert!(WKWebView::class().instance_method(selector()).is_some());
    }

    define_class!(
        // Safety: `NSObject` has no subclassing requirement, and the class has
        // no `Drop`.
        #[unsafe(super(NSObject))]
        #[name = "TasmaSampleMenuView"]
        struct SampleMenuView;

        impl SampleMenuView {
            #[unsafe(method(willOpenMenu:withEvent:))]
            fn will_open_menu(&self, _menu: *mut AnyObject, _event: *mut AnyObject) {}
        }
    );

    define_class!(
        // Safety: as above.
        #[unsafe(super(SampleMenuView, NSObject))]
        #[name = "TasmaSampleWebView"]
        struct SampleWebView;
    );

    define_class!(
        // Safety: as above.
        #[unsafe(super(SampleMenuView, NSObject))]
        #[name = "TasmaSampleOwnMenuView"]
        struct SampleOwnMenuView;

        impl SampleOwnMenuView {
            #[unsafe(method(willOpenMenu:withEvent:))]
            fn will_open_menu(&self, _menu: *mut AnyObject, _event: *mut AnyObject) {}
        }
    );

    fn implementation(class: &AnyClass) -> Imp {
        class.instance_method(selector()).unwrap().implementation()
    }

    #[test]
    fn the_filter_is_added_and_answers_the_inherited_implementation() {
        let inherited = hook(SampleWebView::class()).unwrap();

        assert_eq!(
            inherited as usize,
            implementation(SampleMenuView::class()) as usize
        );
        assert_eq!(
            implementation(SampleWebView::class()) as usize,
            (will_open_menu as WillOpenMenu) as usize
        );
    }

    #[test]
    fn a_class_with_its_own_method_is_left_alone() {
        let own = implementation(SampleOwnMenuView::class());

        assert_eq!(
            hook(SampleOwnMenuView::class()).map(|_| ()),
            Err("TasmaSampleOwnMenuView has its own willOpenMenu:withEvent:".to_string())
        );
        assert_eq!(
            implementation(SampleOwnMenuView::class()) as usize,
            own as usize
        );
    }

    #[test]
    fn a_class_that_inherits_no_method_is_left_alone() {
        assert_eq!(
            hook(SampleMenuView::class()).map(|_| ()),
            Err("TasmaSampleMenuView inherits no willOpenMenu:withEvent:".to_string())
        );
    }

    #[test]
    fn a_null_web_view_is_left_alone() {
        assert_eq!(hook_in(None), Err("no web view".to_string()));
    }

    #[test]
    fn install_is_a_no_op_on_the_mock_runtime() {
        let app = mock_app();
        let window = WebviewWindowBuilder::new(&app, crate::WINDOW, WebviewUrl::default())
            .build()
            .unwrap();

        install(&window);
    }
}
