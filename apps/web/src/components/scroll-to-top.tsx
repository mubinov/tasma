import { Button } from "@base-ui/react/button";
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { ArrowUpIcon } from "../lib/icons";
import { scrollBehavior } from "../lib/scroll-behavior";
import { useFocusLost } from "../lib/use-focus-lost";
import { useNoticeStore } from "../store/notices";

type ScrollToTopProps = {
  /** The page has scrolled past its heading. */
  scrolled: boolean;
  /** The page's h1, which takes the focus from the control. */
  headingRef: RefObject<HTMLElement | null>;
};

type ControlProps = {
  headingRef: RefObject<HTMLElement | null>;
  /** The control leaves while it holds focus. */
  onFocusLost: () => void;
};

function Control({ headingRef, onFocusLost }: ControlProps): ReactNode {
  const buttonRef = useRef<HTMLButtonElement>(null);
  useFocusLost(buttonRef, onFocusLost);

  return (
    <Button
      ref={buttonRef}
      type="button"
      aria-label="Scroll to top"
      onClick={() => {
        window.scrollTo({ top: 0, behavior: scrollBehavior() });
        headingRef.current?.focus({ preventScroll: true });
      }}
      className="fixed right-6 bottom-6 z-(--layer-scroll-to-top) flex size-9 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-float hover:border-graphic hover:text-text lg:right-[calc(var(--spacing-task-sidebar)+--spacing(6))]"
    >
      <ArrowUpIcon size={16} aria-hidden="true" />
    </Button>
  );
}

/** Hidden while a notice is open, which takes the same corner. */
export function ScrollToTop({ scrolled, headingRef }: ScrollToTopProps): ReactNode {
  const noticeOpen = useNoticeStore((state) => state.notices.length > 0);
  const shown = scrolled && !noticeOpen;
  const focusLostRef = useRef(false);

  // Runs after the commit that removed the control, so a notice that opened in it is already in the DOM. On a
  // scrolled page the h1 is out of view, and the notice that took the corner takes the focus.
  useLayoutEffect(() => {
    if (shown || !focusLostRef.current) {
      return;
    }

    focusLostRef.current = false;
    const bottomDismiss = scrolled
      ? [...document.querySelectorAll<HTMLElement>("[data-notice-dismiss]")].at(-1)
      : undefined;
    (bottomDismiss ?? headingRef.current)?.focus({ preventScroll: true });
  }, [shown, scrolled, headingRef]);

  return shown
    ? (
        <Control
          headingRef={headingRef}
          onFocusLost={() => {
            focusLostRef.current = true;
          }}
        />
      )
    : null;
}
