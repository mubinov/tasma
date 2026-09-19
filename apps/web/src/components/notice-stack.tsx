import { Button } from "@base-ui/react/button";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { WarningIcon, XIcon } from "../lib/icons";
import { useFocusLost } from "../lib/use-focus-lost";
import { useNoticeStore, type OpenNotice } from "../store/notices";

/** Set on <html> while a notice is open: the height the stack covers above the window's bottom edge. */
const STACK_HEIGHT_PROPERTY = "--notice-stack-height";

/**
 * The open notices at the window's bottom right, the newest at the bottom. The
 * live region stays mounted while it is empty: a region inserted together with
 * its first notice is not announced.
 */
export function NoticeStack(): ReactNode {
  const notices = useNoticeStore(useShallow((state) => state.notices));
  const stackRef = useRef<HTMLDivElement>(null);
  const focusLostRef = useRef(false);
  const bottom = notices.at(-1);
  const bottomSerial = bottom?.serial ?? null;

  // A notice above the bottom one that holds focus stays in view. The stack is
  // `fixed`, so it is the offsetParent of its panels; the browser limits a
  // scrollTop past the end, so a panel that fits shows whole.
  useLayoutEffect(() => {
    const stack = stackRef.current;
    const bottomPanel = stack?.lastElementChild;
    if (stack === null || !(bottomPanel instanceof HTMLElement)) {
      return;
    }

    const focus = document.activeElement;
    if (stack.contains(focus) && !bottomPanel.contains(focus)) {
      return;
    }

    stack.scrollTop = bottomPanel.offsetTop - Number.parseFloat(getComputedStyle(stack).paddingTop);
  }, [bottomSerial]);

  useLayoutEffect(() => {
    if (!focusLostRef.current) {
      return;
    }

    focusLostRef.current = false;
    const stack = stackRef.current;
    const bottomDismiss = stack?.lastElementChild?.querySelector("button");
    const main = stack?.parentElement?.querySelector<HTMLElement>(":scope > main");
    (bottomDismiss ?? main)?.focus();
  }, [notices]);

  // A notice opens by itself, so the page keeps room for the stack below its
  // content and a focus scroll keeps its target clear of the stack.
  useLayoutEffect(() => {
    const stack = stackRef.current;
    const page = document.documentElement;
    if (stack === null || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (stack.childElementCount === 0) {
        page.style.removeProperty(STACK_HEIGHT_PROPERTY);
      } else {
        const height = stack.clientHeight - Number.parseFloat(getComputedStyle(stack).paddingTop);
        page.style.setProperty(STACK_HEIGHT_PROPERTY, `${String(height)}px`);
      }
    });
    observer.observe(stack);

    return () => {
      observer.disconnect();
      page.style.removeProperty(STACK_HEIGHT_PROPERTY);
    };
  }, []);

  // A scroll container clips the shadows inside it, so the padding holds the
  // panels' shadow and the negative margin keeps the panels where they would be
  // without it. The right padding is no wider than the gap to the window's edge,
  // so the scrollbar stays on screen. The padding takes no clicks from the page
  // under it.
  return (
    <div
      ref={stackRef}
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed right-4 bottom-8 z-(--layer-notice) -m-8 -mr-4 flex max-h-screen w-[calc(100%+1rem)] max-w-[488px] flex-col gap-2 overflow-y-auto p-8 pr-4 sm:right-10 sm:-mr-8 sm:max-w-[504px] sm:pr-8 [html:has(&)]:scroll-pb-(--notice-stack-height)"
    >
      {notices.map((notice) => (
        // Each opening mounts a new panel: a text change in place, or no change
        // at all, is not an addition to the live region and is not announced.
        <NoticePanel
          key={notice.serial}
          notice={notice}
          onFocusLost={() => {
            focusLostRef.current = true;
          }}
        />
      ))}
    </div>
  );
}

/**
 * What the application says to a screen reader alone. It is mounted with the
 * shell, so it is on the page before anything writes to it: a region that
 * arrives with its first words is not announced. Polite, so it never takes the
 * caret; each message is a node of its own, so the same words said twice are
 * two additions and are announced twice.
 */
export function SpokenRegion(): ReactNode {
  const spoken = useNoticeStore(useShallow((state) => state.spoken));

  return (
    <div aria-live="polite" aria-relevant="additions" className="sr-only">
      {spoken.map(({ serial, words }) => <p key={serial}>{words}</p>)}
    </div>
  );
}

type NoticePanelProps = {
  notice: OpenNotice;
  /** The panel leaves while focus is inside it. */
  onFocusLost: () => void;
};

const WORDS_CLASS = "mt-2 space-y-1 rounded-control bg-surface-2 px-2.5 py-2 font-mono text-xs-plus text-dim wrap-anywhere";

function NoticePanel({ notice, onFocusLost }: NoticePanelProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusLost(panelRef, onFocusLost);

  return (
    <div
      ref={panelRef}
      role={notice.form === "failure" ? "alert" : undefined}
      className="pointer-events-auto flex w-full animate-enter gap-3 rounded-card border border-line bg-surface px-4 py-3 shadow-float"
    >
      <WarningIcon size={20} aria-hidden="true" className="mt-px shrink-0 text-signal" />
      <div className="min-w-0 flex-1">
        <p id={titleId} className="font-chrome text-base font-medium text-signal">
          {notice.title}
        </p>
        {notice.line !== undefined && <p className="mt-0.5 text-sm text-muted">{notice.line}</p>}
        {notice.form === "failure"
          ? (
              <div className={WORDS_CLASS}>
                {notice.words.map((word, index) => (
                  // Two words can be identical, so the position is the only
                  // stable identity a row has.
                  // eslint-disable-next-line @eslint-react/no-array-index-key
                  <p key={index}>{word}</p>
                ))}
              </div>
            )
          : (
              <ul className={WORDS_CLASS}>
                {notice.words.map((word, index) => (
                  // eslint-disable-next-line @eslint-react/no-array-index-key
                  <li key={index}>{word}</li>
                ))}
              </ul>
            )}
      </div>
      <Button
        type="button"
        aria-label="Dismiss"
        aria-describedby={titleId}
        data-notice-dismiss=""
        onClick={() => {
          useNoticeStore.getState().dismissNotice(notice.key);
        }}
        className="-mt-[3px] -mr-2 flex size-7 shrink-0 items-center justify-center self-start rounded-control text-dim hover:text-text"
      >
        <XIcon size={16} aria-hidden="true" />
      </Button>
    </div>
  );
}
