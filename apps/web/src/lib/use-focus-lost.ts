import { useEffectEvent, useLayoutEffect, type RefObject } from "react";

/** Calls `onFocusLost` with the element when it leaves the page while focus is inside it. */
export function useFocusLost<T extends Element>(ref: RefObject<T | null>, onFocusLost: (element: T) => void): void {
  const focusLost = useEffectEvent(onFocusLost);

  // Focus inside an element that leaves drops to <body>. A layout cleanup runs while the element is still attached.
  useLayoutEffect(() => {
    const element = ref.current;

    return () => {
      if (element?.contains(document.activeElement)) {
        focusLost(element);
      }
    };
  }, [ref]);
}
