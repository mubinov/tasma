//! Links that a document opens outside the window: in the default browser or
//! the default mail app.

use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSString, NSURL};
use tauri::Url;

use crate::log;

/// `LINK_SCHEMES` in `apps/web/src/lib/markdown.ts`, without the colon.
const SCHEMES: [&str; 3] = ["http", "https", "mailto"];

/// Whether a link goes to the system rather than to the window.
pub fn opens_outside(url: &Url) -> bool {
    SCHEMES.contains(&url.scheme())
}

/// Hands a link to Launch Services. A link that does not open is one line in
/// the log, the only place a bundle's own output can be read.
pub fn open(url: &Url) {
    let opened = NSURL::URLWithString(&NSString::from_str(url.as_str()))
        .is_some_and(|link| NSWorkspace::sharedWorkspace().openURL(&link));

    if !opened {
        let file = log::open(std::env::home_dir().as_deref()).ok();
        log::note(
            file.as_ref(),
            &format!("a link could not be opened: {}", log::quoted(url.as_str())),
        );
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    /// Read at compile time, so a list changed there and not here fails the
    /// test.
    const MARKDOWN: &str = include_str!("../../web/src/lib/markdown.ts");

    fn url(text: &str) -> Url {
        text.parse().unwrap()
    }

    /// The schemes `LINK_SCHEMES` names, without the colon.
    fn link_schemes() -> BTreeSet<&'static str> {
        let list = MARKDOWN
            .lines()
            .find_map(|line| line.trim().strip_prefix("const LINK_SCHEMES = new Set(["))
            .and_then(|rest| rest.split_once("])"))
            .expect("markdown.ts states LINK_SCHEMES as a Set of strings")
            .0;

        list.split(',')
            .map(|name| {
                name.trim()
                    .strip_prefix('"')
                    .and_then(|name| name.strip_suffix(":\""))
                    .expect("a link scheme is a quoted name with a colon")
            })
            .collect()
    }

    #[test]
    fn the_schemes_are_the_ones_the_board_renders_as_links() {
        assert_eq!(link_schemes(), SCHEMES.into_iter().collect());
    }

    #[test]
    fn web_and_mail_links_open_outside() {
        assert!(opens_outside(&url("https://example.invalid/")));
        assert!(opens_outside(&url("http://example.invalid/")));
        assert!(opens_outside(&url("mailto:someone@example.invalid")));
    }

    #[test]
    fn no_other_link_opens_outside() {
        assert!(!opens_outside(&url("file:///etc/passwd")));
        assert!(!opens_outside(&url("javascript:alert(1)")));
        assert!(!opens_outside(&url("data:text/html,x")));
        assert!(!opens_outside(&url(&format!(
            "{}://task/SAGA-1",
            crate::LINK_SCHEME
        ))));
        assert!(!opens_outside(&url("tasma-app://localhost/index.html")));
    }
}
