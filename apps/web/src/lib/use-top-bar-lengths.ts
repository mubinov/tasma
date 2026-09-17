import { useLayoutEffect, useState, type RefObject } from "react";
import { scrollPadding } from "./scroll-padding";

export type TopBarLengths = {
  /** The bar's height in px, undefined before the first measure. */
  barHeight: number | undefined;
  /** The page's top scroll padding in px, undefined before the first measure. */
  scrollPaddingTop: number | undefined;
};

/** The height of the bar that sticks at the window's top, and the page's top scroll padding. */
export function useTopBarLengths(barRef: RefObject<Element | null>): TopBarLengths {
  const [barHeight, setBarHeight] = useState<number>();
  const [scrollPaddingTop, setScrollPaddingTop] = useState<number>();

  // The bar's height and the page's scroll padding are in rem, so the bar resizes when the root font size changes on
  // an open page.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar === null || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      setBarHeight(bar.getBoundingClientRect().height);
      setScrollPaddingTop(scrollPadding(document.documentElement).top);
    });
    observer.observe(bar);

    return () => {
      observer.disconnect();
    };
  }, [barRef]);

  return { barHeight, scrollPaddingTop };
}
