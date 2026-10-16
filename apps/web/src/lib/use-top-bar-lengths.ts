import { useLayoutEffect, useState, type RefObject } from "react";
import { pageScrollPadding } from "./scroll-padding";

export type TopBarLengths = {
  /** The bar's height in px, undefined before the first measure. */
  barHeight: number | undefined;
  /** The page's top scroll padding in px, undefined before the first measure. */
  scrollPaddingTop: number | undefined;
  /** Reads the scroll padding again, for a length the padding adds that changes after the bar's observer ran. */
  readScrollPadding: () => void;
};

/** The height of the bar that sticks at the window's top, and the page's top scroll padding. */
export function useTopBarLengths(barRef: RefObject<Element | null>): TopBarLengths {
  const [barHeight, setBarHeight] = useState<number>();
  const [scrollPaddingTop, setScrollPaddingTop] = useState<number>();

  function readScrollPadding(): void {
    setScrollPaddingTop(pageScrollPadding());
  }

  // The bar's height and the page's scroll padding are in rem, so the bar resizes when the root font size changes on
  // an open page.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar === null || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      setBarHeight(bar.getBoundingClientRect().height);
      setScrollPaddingTop(pageScrollPadding());
    });
    observer.observe(bar);

    return () => {
      observer.disconnect();
    };
  }, [barRef]);

  return { barHeight, scrollPaddingTop, readScrollPadding };
}
