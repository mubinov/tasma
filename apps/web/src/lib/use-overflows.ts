import { useLayoutEffect, useState, type RefObject } from "react";

/** The element's content is taller than its box. */
export function useOverflows(ref: RefObject<HTMLElement | null>): boolean {
  const [overflows, setOverflows] = useState(false);

  // The box resizes with the window and the children with their content, so both are observed.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      setOverflows(element.scrollHeight > element.clientHeight);
    });
    observer.observe(element);
    for (const child of element.children) {
      observer.observe(child);
    }

    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return overflows;
}
