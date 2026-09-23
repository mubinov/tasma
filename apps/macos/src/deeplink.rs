//! The `tasma://task/<TAG>-<number>` link, and where it takes the board.

use percent_encoding::percent_decode_str;
use tauri::Url;

use crate::LINK_SCHEME;

/// The one kind of thing a link names.
const TASK: &str = "task";

/// The board's route for one task, as `apps/web` declares it. Held to it by a
/// repo test.
const TASK_ROUTE: &str = "/tasks/$project/$task";

/// The length `TAG_RULE` in `packages/engine` allows. Held to it by a repo test.
const TAG_LENGTH: std::ops::RangeInclusive<usize> = 2..=8;

/// `TAG_RULE`: a letter, then letters or digits.
fn is_tag(tag: &str) -> bool {
    let mut characters = tag.chars();

    TAG_LENGTH.contains(&tag.len())
        && characters
            .next()
            .is_some_and(|character| character.is_ascii_uppercase())
        && characters.all(|character| character.is_ascii_uppercase() || character.is_ascii_digit())
}

/// The board route a link names, or `None` for a link outside the grammar.
///
/// The route carries no `#`. The caller writes the one its call needs, and
/// `##/…` routes to an empty path with no error.
pub fn route(url: &Url) -> Option<String> {
    // `Url` keeps the host of a scheme it does not know as written.
    let names_a_task = url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case(TASK));

    if url.scheme() != LINK_SCHEME
        || !names_a_task
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }

    let segment = url.path().strip_prefix('/')?;
    // Link detectors append one.
    let segment = segment.strip_suffix('/').unwrap_or(segment);
    // Read decoded, so an escaped separator is refused rather than forging a
    // second segment.
    let id = percent_decode_str(segment).decode_utf8().ok()?;
    let (tag, number) = id.split_once('-')?;
    let tag = tag.to_ascii_uppercase();

    if !is_tag(&tag) || number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    let id = format!("{tag}-{number}");

    Some(TASK_ROUTE.replace("$project", &tag).replace("$task", &id))
}

/// The function that moves the board to a route. A repo test runs it.
///
/// - It waits for `<main>`. Pushed before the board has mounted, the route is
///   the first paint, and the board announces a navigation only by moving focus
///   to `<main>` after that paint. A board that has not mounted when the wait
///   runs out is moved anyway.
/// - It takes focus off `<main>` before the route changes, because focusing
///   the element that has focus fires no event and nothing is announced.
/// - `@tanstack/history` patches `pushState` and never listens to
///   `hashchange`, so a `location.hash` write would move the address and not
///   the board.
const OPEN_ROUTE: &str = r#"(route) => {
  const move = () => {
    const main = document.querySelector("main");
    const shown = location.hash.slice(1).split(/[?#]/)[0];

    if (main !== null && main === document.activeElement && shown !== route) {
      main.blur();
    }

    history.pushState(null, "", `#${route}`);
  };

  if (document.querySelector("main") !== null) {
    move();
    return;
  }

  const settle = () => {
    mounted.disconnect();
    clearTimeout(limit);
    move();
  };
  const mounted = new MutationObserver(() => {
    if (document.querySelector("main") !== null) {
      settle();
    }
  });
  const limit = setTimeout(settle, 10000);

  mounted.observe(document, { childList: true, subtree: true });
}"#;

/// The script that moves the board to a route.
///
/// The route is written as a JSON string, which is also a JavaScript one. The
/// document this runs in reaches every route of the daemon, and a plain
/// `&str` carries none of the validation `route()` applies.
pub fn push_script(route: &str) -> String {
    let route = serde_json::Value::from(route);

    format!("({OPEN_ROUTE})({route})")
}

/// The route a link names, held until the document can take it.
///
/// A link that starts the application arrives before the board has mounted, and
/// a script run then is discarded with the document.
#[derive(Debug, Default)]
pub struct Delivery {
    loaded: bool,
    held: Option<String>,
}

impl Delivery {
    /// The route to push now, or `None` when it is held for the document. A
    /// route already held is replaced.
    pub fn arrive(&mut self, route: String) -> Option<String> {
        if self.loaded {
            return Some(route);
        }

        self.held = Some(route);
        None
    }

    /// A document replaces the one on show, and has not loaded yet.
    pub fn started(&mut self) {
        self.loaded = false;
    }

    /// The document has loaded: the route held for it, if any.
    pub fn finished(&mut self) -> Option<String> {
        self.loaded = true;
        self.held.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routed(link: &str) -> Option<String> {
        route(&link.parse().expect("the test link is a URL"))
    }

    #[test]
    fn a_task_link_names_the_task_route() {
        assert_eq!(
            routed("tasma://task/SAGA-1").as_deref(),
            Some("/tasks/SAGA/SAGA-1")
        );
        assert_eq!(
            routed("tasma://task/SAGA7-9999").as_deref(),
            Some("/tasks/SAGA7/SAGA7-9999")
        );
    }

    #[test]
    fn a_lower_case_tag_is_read_upper_case() {
        assert_eq!(
            routed("tasma://task/saga-1").as_deref(),
            Some("/tasks/SAGA/SAGA-1")
        );
        assert_eq!(
            routed("tasma://task/Saga-1").as_deref(),
            Some("/tasks/SAGA/SAGA-1")
        );
    }

    #[test]
    fn the_host_is_read_in_any_case() {
        assert_eq!(
            routed("tasma://TASK/SAGA-1").as_deref(),
            Some("/tasks/SAGA/SAGA-1")
        );
    }

    #[test]
    fn one_trailing_separator_is_tolerated() {
        assert_eq!(
            routed("tasma://task/SAGA-1/").as_deref(),
            Some("/tasks/SAGA/SAGA-1")
        );
        assert_eq!(routed("tasma://task/SAGA-1//"), None);
    }

    #[test]
    fn the_id_is_read_decoded() {
        assert_eq!(
            routed("tasma://task/SAGA%2D1").as_deref(),
            Some("/tasks/SAGA/SAGA-1")
        );
        assert_eq!(routed("tasma://task/SAGA%2F1"), None);
        assert_eq!(routed("tasma://task/SAGA-1%2Fextra"), None);
        assert_eq!(routed("tasma://task/SAGA-%FF"), None);
    }

    #[test]
    fn an_id_without_a_separator_is_refused() {
        assert_eq!(routed("tasma://task/SAGA1"), None);
    }

    #[test]
    fn a_second_segment_is_refused() {
        assert_eq!(routed("tasma://task/SAGA-1/extra"), None);
    }

    #[test]
    fn a_query_or_a_fragment_is_refused() {
        assert_eq!(routed("tasma://task/SAGA-1?x=1"), None);
        assert_eq!(routed("tasma://task/SAGA-1?"), None);
        assert_eq!(routed("tasma://task/SAGA-1#c3"), None);
        assert_eq!(routed("tasma://task/SAGA-1#"), None);
    }

    #[test]
    fn a_link_with_no_segment_is_refused() {
        assert_eq!(routed("tasma://task/"), None);
        assert_eq!(routed("tasma://task"), None);
    }

    #[test]
    fn a_host_other_than_task_is_refused() {
        assert_eq!(routed("tasma://project/SAGA"), None);
        assert_eq!(routed("tasma://SAGA-1"), None);
        assert_eq!(routed("tasma:task/SAGA-1"), None);
    }

    #[test]
    fn credentials_or_a_port_are_refused() {
        assert_eq!(routed("tasma://someone@task/SAGA-1"), None);
        assert_eq!(routed("tasma://:secret@task/SAGA-1"), None);
        assert_eq!(routed("tasma://task:1/SAGA-1"), None);
    }

    #[test]
    fn another_scheme_is_refused() {
        assert_eq!(routed("tasma-app://task/SAGA-1"), None);
        assert_eq!(routed("https://task/SAGA-1"), None);
    }

    #[test]
    fn a_tag_outside_the_rule_is_refused() {
        assert_eq!(routed("tasma://task/-1"), None);
        assert_eq!(routed("tasma://task/S-1"), None);
        assert_eq!(routed("tasma://task/SAGABOOKS-1"), None);
        assert_eq!(routed("tasma://task/1SAGA-1"), None);
        assert_eq!(routed("tasma://task/SA_GA-1"), None);
        assert_eq!(routed("tasma://task/SAG%C3%80-1"), None);
    }

    #[test]
    fn a_number_that_is_not_digits_is_refused() {
        assert_eq!(routed("tasma://task/SAGA-"), None);
        assert_eq!(routed("tasma://task/SAGA-1a"), None);
        assert_eq!(routed("tasma://task/SAGA--1"), None);
        assert_eq!(routed("tasma://task/SAGA-+1"), None);
        assert_eq!(routed("tasma://task/SAGA-%D9%A1"), None);
    }

    #[test]
    fn a_route_needs_no_escaping_in_a_fragment_or_a_script() {
        for link in [
            "tasma://task/SAGA-1",
            "tasma://task/saga-12",
            "tasma://task/SAGA%2D1/",
        ] {
            let route = routed(link).expect("the link is in the grammar");

            assert!(route.starts_with('/'), "{route} carries its own `#`");
            assert!(
                route.chars().all(|character| {
                    character.is_ascii_alphanumeric() || character == '/' || character == '-'
                }),
                "{route} holds a character to escape"
            );
        }
    }

    #[test]
    fn the_script_is_called_with_the_route() {
        assert_eq!(
            push_script("/tasks/SAGA/SAGA-1"),
            format!("({OPEN_ROUTE})(\"/tasks/SAGA/SAGA-1\")")
        );
    }

    #[test]
    fn a_route_that_could_end_the_literal_is_encoded() {
        assert_eq!(
            push_script("/tasks/SAGA/\"');drop()//\n"),
            format!("({OPEN_ROUTE})(\"/tasks/SAGA/\\\"');drop()//\\n\")")
        );
        assert_eq!(
            push_script("/tasks/SAGA/\\"),
            format!("({OPEN_ROUTE})(\"/tasks/SAGA/\\\\\")")
        );
    }

    #[test]
    fn a_route_before_the_document_loads_waits_for_it() {
        let mut delivery = Delivery::default();

        assert_eq!(delivery.arrive("/tasks/SAGA/SAGA-1".into()), None);
        assert_eq!(delivery.finished().as_deref(), Some("/tasks/SAGA/SAGA-1"));
        assert_eq!(delivery.finished(), None);
    }

    #[test]
    fn a_later_route_replaces_the_one_waiting() {
        let mut delivery = Delivery::default();

        delivery.arrive("/tasks/SAGA/SAGA-1".into());
        delivery.arrive("/tasks/SAGA/SAGA-2".into());

        assert_eq!(delivery.finished().as_deref(), Some("/tasks/SAGA/SAGA-2"));
    }

    #[test]
    fn a_route_after_the_document_loads_is_taken_at_once() {
        let mut delivery = Delivery::default();

        assert_eq!(delivery.finished(), None);
        assert_eq!(
            delivery.arrive("/tasks/SAGA/SAGA-1".into()).as_deref(),
            Some("/tasks/SAGA/SAGA-1")
        );
        assert_eq!(delivery.finished(), None);
    }

    #[test]
    fn a_document_loading_again_holds_the_route_until_it_finishes() {
        let mut delivery = Delivery::default();

        delivery.finished();
        delivery.started();

        assert_eq!(delivery.arrive("/tasks/SAGA/SAGA-1".into()), None);
        assert_eq!(delivery.finished().as_deref(), Some("/tasks/SAGA/SAGA-1"));
    }
}
