import { useLayoutEffect, useState, type RefObject } from "react";
import { pageScrollPadding } from "./scroll-padding";

/** The fixed box over the band at the top of the window. Its height is the band. */
export const TITLE_COVER_ID = "title-cover";

export type TopBarLengths = {
  /** The bar's bottom edge from the window's top in px, undefined before the first measure. */
  barBottom: number | undefined;
  /** The page's top scroll padding in px, undefined before the first measure. */
  scrollPaddingTop: number | undefined;
};

/** The bottom edge of the bar that sticks below the band, and the page's top scroll padding. */
export function useTopBarLengths(barRef: RefObject<Element | null>): TopBarLengths {
  const [barBottom, setBarBottom] = useState<number>();
  const [scrollPaddingTop, setScrollPaddingTop] = useState<number>();

  // The bar's height and the page's scroll padding are in rem, so the bar resizes when the root font size changes on
  // an open page. The cover resizes when the band changes.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar === null || typeof ResizeObserver === "undefined") {
      return;
    }

    const cover = document.getElementById(TITLE_COVER_ID);
    const observer = new ResizeObserver(() => {
      setBarBottom((cover?.getBoundingClientRect().height ?? 0) + bar.getBoundingClientRect().height);
      setScrollPaddingTop(pageScrollPadding());
    });
    observer.observe(bar);
    if (cover !== null) {
      observer.observe(cover);
    }

    return () => {
      observer.disconnect();
    };
  }, [barRef]);

  return { barBottom, scrollPaddingTop };
}
