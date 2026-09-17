import { useEffect, useState, type RefObject } from "react";

/** The bottom of the element has passed under the bar, which sticks at the window's top. */
export function useScrolledPast(ref: RefObject<Element | null>, barHeight: number | undefined): boolean {
  const [past, setPast] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (element === null || barHeight === undefined || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const { isIntersecting, boundingClientRect } of entries) {
          setPast(!isIntersecting && boundingClientRect.bottom < barHeight);
        }
      },
      { rootMargin: `-${String(barHeight)}px 0px 0px 0px` },
    );
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [ref, barHeight]);

  return past;
}
