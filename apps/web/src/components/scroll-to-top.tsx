import { Button } from "@base-ui/react/button";
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { ArrowUpIcon } from "../lib/icons";
import { scrollBehavior } from "../lib/scroll-behavior";
import { useFocusLost } from "../lib/use-focus-lost";
import { useNoticeStore } from "../store/notices";

/**
 * The column at the right of the task page, which the control stays to the left of: the sidebar at lg and wider, the
 * chat panel at xl and wider.
 */
export type PageColumn = "sidebar" | "chat";

const COLUMN_RIGHT: Record<PageColumn, string> = {
  sidebar: "lg:right-[calc(var(--spacing-task-sidebar)+--spacing(6))]",
  chat: "xl:right-[calc(var(--spacing-chat-panel)+--spacing(6))]",
};

type ScrollToTopProps = {
  /** The page has scrolled past its heading. */
  scrolled: boolean;
  /** The page's h1, which takes the focus from the control. */
  headingRef: RefObject<HTMLElement | null>;
  column: PageColumn;
};

type ControlProps = {
  headingRef: RefObject<HTMLElement | null>;
  column: PageColumn;
  /** The control leaves while it holds focus. */
  onFocusLost: () => void;
};

function Control({ headingRef, column, onFocusLost }: ControlProps): ReactNode {
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
      className={`fixed right-6 bottom-6 z-(--layer-scroll-to-top) flex size-9 items-center justify-center rounded-full border border-line bg-surface text-subtle shadow-float hover:border-graphic hover:text-text ${COLUMN_RIGHT[column]}`}
    >
      <ArrowUpIcon size={16} aria-hidden="true" />
    </Button>
  );
}

/** Hidden while a notice is open, which takes the same corner. */
export function ScrollToTop({ scrolled, headingRef, column }: ScrollToTopProps): ReactNode {
  const noticeOpen = useNoticeStore((state) => state.notices.length > 0);
  const shown = scrolled && !noticeOpen;
  const focusLostRef = useRef(false);

  // On a scrolled page the h1 is out of view, and the notice that took the corner takes the focus. Its panel mounts
  // a commit after this one, so the stack moves the focus.
  useLayoutEffect(() => {
    if (shown || !focusLostRef.current) {
      return;
    }

    focusLostRef.current = false;
    if (scrolled) {
      useNoticeStore.getState().requestNoticeFocus();
    } else {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [shown, scrolled, headingRef]);

  return shown
    ? (
        <Control
          headingRef={headingRef}
          column={column}
          onFocusLost={() => {
            focusLostRef.current = true;
          }}
        />
      )
    : null;
}
