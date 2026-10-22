import type { Comment } from "@tasma/protocol";
import { useDeferredValue, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useNoticeStore } from "../store/notices";
import { commentIdOf, findRanges, matchPlace, type FindMatch } from "./page-find";
import { scrollBehavior } from "./scroll-behavior";
import { pageScrollPadding } from "./scroll-padding";

/** How long the text must stay unchanged before the result of typing is announced. */
export const FIND_ANNOUNCE_DELAY = 500;

/** The most matches the highlight of the other matches holds: the ones nearest to the current match. */
export const NEARBY_MATCHES = 500;

/**
 * A match in a text node longer than this has a highlight only while it is current.
 * WebKit draws a range by walking each line of its text node from the start.
 */
export const LONG_TEXT = 10_000;

const MATCHES_HIGHLIGHT = "task-find";
const CURRENT_HIGHLIGHT = "task-find-current";

type FindResult = {
  /** The query the matches are for. */
  query: string;
  matches: readonly FindMatch[];
  /** The index of the current match, -1 with no match. */
  current: number;
};

const NO_RESULT: FindResult = { query: "", matches: [], current: -1 };

/**
 * Why the find runs. A new text keeps the current match where it still starts
 * a match; an open picks the first match on the screen; a reveal and a
 * recompute keep the match by its block and its index in the block.
 */
type FindRun = "text" | "open" | "reveal" | "recompute";

/** The comment a move into a closed comment opens. A new count opens it again. */
export type RevealRequest = { commentId: number; count: number };

/** The text typed last, and when. */
type Typed = { text: string; at: number };

/** Moves asked for before the result of the text came, which apply to that result. */
type PendingSteps = { text: string; steps: number };

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** The closed comment panel that holds the match, which gives it no layout. */
function hiddenPanel({ range }: FindMatch): Element | null {
  return elementOf(range.startContainer)?.closest("[data-find-hidden]") ?? null;
}

function visibleTop(): number {
  return pageScrollPadding();
}

function wrap(index: number, length: number): number {
  return ((index % length) + length) % length;
}

/** The first match in `[start, end)` of one block that starts at or below `top`, or `end`. */
function firstBelow(matches: readonly FindMatch[], start: number, end: number, top: number): number {
  let low = start;
  let high = end;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (matches[middle]!.range.getBoundingClientRect().top >= top) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

/**
 * The first match that starts at or below the top of the visible area, or the first match.
 * WebKit measures a range by walking each line of its text node, so only the block across
 * the top has its matches measured.
 */
function firstVisible(matches: readonly FindMatch[]): number {
  const top = visibleTop();
  let start = 0;
  while (start < matches.length) {
    const { element } = matches[start]!;
    let end = start + 1;
    while (end < matches.length && matches[end]!.element === element) {
      end += 1;
    }

    const panel = hiddenPanel(matches[start]!);
    const box = (panel?.closest("[data-comment-id]") ?? element).getBoundingClientRect();
    if (box.top >= top) {
      return start;
    }
    if (panel === null && box.bottom > top) {
      const below = firstBelow(matches, start, end, top);
      if (below < end) {
        return below;
      }
    }
    start = end;
  }
  return 0;
}

function sameStart(old: FindMatch, matches: readonly FindMatch[]): number {
  return matches.findIndex(
    ({ range }) => range.startContainer === old.range.startContainer && range.startOffset === old.range.startOffset,
  );
}

/** The match in the same block at the same index, or else the first match at or after the old place. */
function samePlace(old: FindMatch | undefined, matches: readonly FindMatch[]): number {
  if (old === undefined) {
    return 0;
  }
  const kept = matches.findIndex(({ blockKey, index }) => index === old.index && blockKey === old.blockKey);
  if (kept !== -1) {
    return kept;
  }
  const after = matches.findIndex(({ range }) => range.compareBoundaryPoints(Range.START_TO_START, old.range) >= 0);
  return Math.max(0, after);
}

function currentAfter(run: FindRun, old: FindMatch | undefined, matches: readonly FindMatch[]): number {
  if (matches.length === 0) {
    return -1;
  }
  if (run === "reveal" || run === "recompute") {
    return samePlace(old, matches);
  }
  const kept = run === "text" && old !== undefined ? sameStart(old, matches) : -1;
  return kept === -1 ? firstVisible(matches) : kept;
}

/** The header of the comment that holds a match in the comment text, which can stick over that text. */
function headerOver({ range }: FindMatch): Element | null {
  const element = range.startContainer.parentElement!;
  if (element.closest("[data-comment-header]") !== null) {
    return null;
  }
  return element.closest("[data-comment-id]")?.querySelector("[data-comment-header]") ?? null;
}

function inView(match: FindMatch): boolean {
  const box = match.range.getBoundingClientRect();
  const top = Math.max(visibleTop(), headerOver(match)?.getBoundingClientRect().bottom ?? 0);
  return box.top >= top && box.bottom <= window.innerHeight;
}

function sidewaysScroller(range: Range): Element | null {
  for (let element = elementOf(range.startContainer); element !== null; element = element.parentElement) {
    const { overflowX } = getComputedStyle(element);
    if ((overflowX === "auto" || overflowX === "scroll") && element.scrollWidth > element.clientWidth) {
      return element;
    }
  }
  return null;
}

/** Puts the match in the middle of the area under the bar, and inside a block that scrolls sideways. */
function scrollToMatch({ range }: FindMatch): void {
  const box = range.getBoundingClientRect();
  const top = visibleTop();
  const behavior = scrollBehavior();
  const middle = top + (window.innerHeight - top) / 2;
  window.scrollTo({ top: window.scrollY + box.top + box.height / 2 - middle, behavior });

  const scroller = sidewaysScroller(range);
  if (scroller === null) {
    return;
  }
  const frame = scroller.getBoundingClientRect();
  if (box.left < frame.left || box.right > frame.left + scroller.clientWidth) {
    scroller.scrollTo({
      left: scroller.scrollLeft + box.left + box.width / 2 - (frame.left + scroller.clientWidth / 2),
      behavior,
    });
  }
}

/** Focus goes to the focusable element that holds the match, or else to its block, and the match is selected. */
function focusMatch(root: Element, match: FindMatch): void {
  const holder = elementOf(match.range.commonAncestorContainer)?.closest<HTMLElement>("a[href], [tabindex]");
  if (holder !== null && holder !== undefined && root.contains(holder)) {
    holder.focus({ preventScroll: true });
  } else {
    const block = match.element as HTMLElement;
    block.tabIndex = -1;
    block.focus({ preventScroll: true });
  }

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(match.range);
}

function inLongText({ range }: FindMatch): boolean {
  return (range.startContainer as Text).length > LONG_TEXT || (range.endContainer as Text).length > LONG_TEXT;
}

/** The ranges of the other matches nearest to the current match, without those in a long text. */
function nearbyRanges({ matches, current }: FindResult): Range[] {
  const start = Math.max(0, Math.min(current - NEARBY_MATCHES / 2, matches.length - NEARBY_MATCHES - 1));
  return matches
    .slice(start, start + NEARBY_MATCHES + 1)
    .filter((match, index) => start + index !== current && !inLongText(match))
    .map(({ range }) => range);
}

function supportsHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS;
}

function announce(words: string): void {
  useNoticeStore.getState().announce(words);
}

type TaskFindOptions = {
  /** The element whose text the find searches. */
  rootRef: RefObject<HTMLElement | null>;
  /** The button that opens find and closes it. */
  buttonRef: RefObject<HTMLButtonElement | null>;
  /** The comments of the task, which name the place of a match. */
  comments: readonly Comment[];
  /** The task editor is open: find closes and stays closed. */
  editing: boolean;
};

export type TaskFind = {
  open: boolean;
  text: string;
  fieldRef: RefObject<HTMLInputElement | null>;
  /** "3 of 12", "No matches", or empty while the text is. */
  counter: string;
  hasMatches: boolean;
  /** Find is open with a text, so a closed comment keeps its text in the page. */
  findActive: boolean;
  reveal: RevealRequest | null;
  /** Cmd+F. */
  request: () => void;
  /** The button that opens find and closes it. */
  toggle: () => void;
  changeText: (text: string) => void;
  /** Enter, Shift+Enter, Next and Previous. */
  step: (direction: 1 | -1) => void;
  escape: () => void;
};

/** The find of the task page: the open state, the matches, the current match and their highlights. */
export function useTaskFind({ rootRef, buttonRef, comments, editing }: TaskFindOptions): TaskFind {
  const fieldRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const deferred = useDeferredValue(text);
  const query = open ? deferred : "";
  const [result, setResult] = useState<FindResult>(NO_RESULT);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const [typed, setTyped] = useState<Typed | null>(null);
  const [pending, setPending] = useState<PendingSteps | null>(null);
  const focusBeforeRef = useRef<Element | null>(null);
  /** The focus move of a close, which runs once the find group is gone. */
  const closingRef = useRef<(() => void) | null>(null);
  const ranRef = useRef({ open, query });
  const active = open && query.trim() !== "";

  if (editing && open) {
    setOpen(false);
    setTyped(null);
    setPending(null);
  }

  function words({ matches, current }: FindResult): string {
    const match = matches[current];
    return match === undefined
      ? "No matches"
      : `Match ${String(current + 1)} of ${String(matches.length)}, ${matchPlace(match.scope, comments)}`;
  }

  /** A closed comment has no layout, so the scroll waits for the comment to open. */
  function moveTo(match: FindMatch): void {
    if (hiddenPanel(match) === null) {
      scrollToMatch(match);
      return;
    }
    const commentId = commentIdOf(match.scope)!;
    setReveal((last) => ({ commentId, count: (last?.count ?? 0) + 1 }));
  }

  const runFind = useEffectEvent((run: FindRun) => {
    const matches = findRanges(rootRef.current!, query);
    const steps = run === "text" && pending?.text === query ? pending.steps : null;
    let current = currentAfter(run, result.matches[result.current], matches);
    if (steps !== null && current !== -1) {
      current = wrap(current + steps, matches.length);
    }
    const next = { query, matches, current };
    setResult(next);
    if (steps !== null) {
      setPending(null);
    }

    if ((run === "open" || steps !== null) && query.trim() !== "") {
      announce(words(next));
    }

    const match = next.matches[next.current];
    if (match === undefined || run === "recompute") {
      return;
    }
    if (run === "reveal") {
      scrollToMatch(match);
    } else {
      moveTo(match);
    }
  });

  const announceTyped = useEffectEvent(() => {
    announce(words(result));
    setTyped(null);
  });

  function openFind(): void {
    focusBeforeRef.current = document.activeElement;
    setOpen(true);
  }

  function closeFind(focus: () => void): void {
    closingRef.current = focus;
    setOpen(false);
    setTyped(null);
    setPending(null);
  }

  // The controls of the sticky bar sit above the page's scroll padding, so a focus scroll would move the page.
  function focusButton(): void {
    buttonRef.current?.focus({ preventScroll: true });
  }

  function request(): void {
    if (editing) {
      return;
    }
    if (open) {
      fieldRef.current?.focus({ preventScroll: true });
      fieldRef.current?.select();
    } else {
      openFind();
    }
  }

  // VoiceOver in WebKit does not reliably speak the new name of the focused button, so the close is announced.
  function toggle(): void {
    if (open) {
      closeFind(focusButton);
      announce("Find closed");
    } else {
      openFind();
    }
  }

  function changeText(next: string): void {
    setText(next);
    setTyped(next.trim() === "" ? null : { text: next, at: Date.now() });
    setPending(null);
  }

  function step(direction: 1 | -1): void {
    setTyped(null);
    if (result.query !== text) {
      setPending((last) => ({ text, steps: (last?.steps ?? 0) + direction }));
      return;
    }
    const { matches, current } = result;
    if (matches.length === 0) {
      if (result.query.trim() !== "") {
        announce(words(result));
      }
      return;
    }
    const next = { ...result, current: wrap(current + direction, matches.length) };
    setResult(next);
    moveTo(matches[next.current]!);
    announce(words(next));
  }

  function escape(): void {
    const root = rootRef.current;
    const match = result.matches[result.current];
    if (root !== null && match !== undefined && hiddenPanel(match) === null) {
      closeFind(() => {
        // The focus moves without a scroll, and the page can have scrolled away from the match since the move to it.
        if (!inView(match)) {
          scrollToMatch(match);
        }
        focusMatch(root, match);
      });
      return;
    }

    const before = focusBeforeRef.current;
    closeFind(() => {
      if (before instanceof HTMLElement && before !== document.body && before.isConnected) {
        before.focus({ preventScroll: true });
      } else {
        focusButton();
      }
    });
  }

  useLayoutEffect(() => {
    if (open) {
      fieldRef.current?.focus({ preventScroll: true });
      fieldRef.current?.select();
      return;
    }
    const closing = closingRef.current;
    closingRef.current = null;
    closing?.();
  }, [open]);

  useLayoutEffect(() => {
    const ran = ranRef.current;
    if (ran.open === open && ran.query === query) {
      return;
    }
    ranRef.current = { open, query };
    runFind(open && !ran.open ? "open" : "text");
  }, [open, query]);

  useLayoutEffect(() => {
    if (reveal !== null) {
      runFind("reveal");
    }
  }, [reveal]);

  // Waits for the deferred result of the text, then for what is left of the delay since the text changed.
  useEffect(() => {
    if (typed?.text !== result.query) {
      return;
    }
    const timer = setTimeout(() => {
      announceTyped();
    }, Math.max(0, typed.at + FIND_ANNOUNCE_DELAY - Date.now()));

    return () => {
      clearTimeout(timer);
    };
  }, [typed, result]);

  // The highlights change no node, so they never wake the observer.
  useEffect(() => {
    const root = rootRef.current;
    if (!active || root === null) {
      return;
    }

    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          runFind("recompute");
        });
      }
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active, rootRef]);

  useLayoutEffect(() => {
    const current = result.matches[result.current];
    if (current === undefined || !supportsHighlights()) {
      return;
    }

    const matches = new Highlight(...nearbyRanges(result));
    const currentMatch = new Highlight(current.range);
    CSS.highlights.set(MATCHES_HIGHLIGHT, matches);
    CSS.highlights.set(CURRENT_HIGHLIGHT, currentMatch);

    // WebKit does not repaint the text of a highlight that leaves the registry with its ranges.
    return () => {
      matches.clear();
      currentMatch.clear();
      CSS.highlights.delete(MATCHES_HIGHLIGHT);
      CSS.highlights.delete(CURRENT_HIGHLIGHT);
    };
  }, [result]);

  return {
    open,
    text,
    fieldRef,
    counter: result.query.trim() === ""
      ? ""
      : result.matches.length === 0
        ? "No matches"
        : `${String(result.current + 1)} of ${String(result.matches.length)}`,
    hasMatches: result.matches.length > 0,
    findActive: active,
    reveal,
    request,
    toggle,
    changeText,
    step,
    escape,
  };
}
