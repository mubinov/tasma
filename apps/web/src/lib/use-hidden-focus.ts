import { useLayoutEffect, type RefObject } from "react";

type HiddenFocusOptions = {
  /** The check runs only while this is true. */
  active: boolean;
  /** The line whose items hide at narrow widths. */
  lineRef: RefObject<HTMLElement | null>;
  /** Where focus goes from an item that hides. */
  targetRef: RefObject<HTMLElement | null>;
};

/**
 * While `active`, moves focus to `targetRef` when a size change of the line hides the item of the line that has
 * focus. An engine can move focus to <body> as soon as the item hides, so the last item that had focus is kept
 * until focus leaves it while it is still rendered.
 */
export function useHiddenFocus({ active, lineRef, targetRef }: HiddenFocusOptions): void {
  useLayoutEffect(() => {
    if (!active || typeof ResizeObserver === "undefined") {
      return;
    }
    const line = lineRef.current!;

    let lastFocused: Element | null = null;

    function onFocusIn(event: FocusEvent): void {
      lastFocused = event.target as Element;
    }

    function onFocusOut(event: FocusEvent): void {
      const item = event.target as Element;
      if (item === lastFocused && item.checkVisibility()) {
        lastFocused = null;
      }
    }

    const observer = new ResizeObserver(() => {
      const focused = document.activeElement;
      const item = line.contains(focused) ? focused : focused === document.body ? lastFocused : null;
      if (item !== null && !item.checkVisibility()) {
        lastFocused = null;
        targetRef.current?.focus({ preventScroll: true });
      }
    });
    observer.observe(line);
    line.addEventListener("focusin", onFocusIn);
    line.addEventListener("focusout", onFocusOut);

    return () => {
      observer.disconnect();
      line.removeEventListener("focusin", onFocusIn);
      line.removeEventListener("focusout", onFocusOut);
    };
  }, [active, lineRef, targetRef]);
}
