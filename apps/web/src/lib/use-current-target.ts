import { useEffect, useState } from "react";

/** How far under the page's scroll padding the line is, so a target scrolled into view is current. */
const UNDER_SCROLL_PADDING = 8;

/** More than the height of any page, and less than the largest coordinate an engine lays out. */
const BELOW_WINDOW = 10_000_000;

/**
 * The index of the last sentinel whose top has passed the line 8px under the
 * page's top scroll padding, or -1 before the first one passes. The sentinels
 * are in document order.
 */
export function useCurrentTarget(sentinels: readonly Element[], pageScrollPadding: number | undefined): number {
  const [current, setCurrent] = useState(-1);

  useEffect(() => {
    if (pageScrollPadding === undefined || typeof IntersectionObserver === "undefined") {
      return;
    }

    const line = pageScrollPadding + UNDER_SCROLL_PADDING;
    const passed = new Set<Element>();
    // The root reaches from the line to far below the window, so a jump that moves a sentinel from below the window to
    // above it is still reported. Threshold 1 reports a heading whose top has passed the line while its bottom has not.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, boundingClientRect } of entries) {
          if (boundingClientRect.top < line) {
            passed.add(target);
          } else {
            passed.delete(target);
          }
        }
        setCurrent(sentinels.findLastIndex((sentinel) => passed.has(sentinel)));
      },
      { rootMargin: `-${String(line)}px 0px ${String(BELOW_WINDOW)}px 0px`, threshold: [0, 1] },
    );
    for (const sentinel of sentinels) {
      observer.observe(sentinel);
    }

    return () => {
      observer.disconnect();
    };
  }, [sentinels, pageScrollPadding]);

  return current;
}
