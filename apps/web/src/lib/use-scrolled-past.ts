import { useEffect, useState, type RefObject } from "react";

/** The bottom of the element has passed under the bar, whose bottom edge is `barBottom` from the window's top. */
export function useScrolledPast(ref: RefObject<Element | null>, barBottom: number | undefined): boolean {
  const [past, setPast] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (element === null || barBottom === undefined || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const { isIntersecting, boundingClientRect } of entries) {
          setPast(!isIntersecting && boundingClientRect.bottom < barBottom);
        }
      },
      { rootMargin: `-${String(barBottom)}px 0px 0px 0px` },
    );
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [ref, barBottom]);

  return past;
}
