import { useEffectEvent, useLayoutEffect, type RefObject } from "react";

/**
 * Calls `onFocusLost` with the element when it leaves the page while focus is
 * inside it.
 *
 * @param holdsFocus Counts the element as holding focus while nothing focused
 *   is inside it, for a control whose open popup renders through a portal: the
 *   focused item is outside the element, and the popup's focus manager returns
 *   focus to an element that is no longer there.
 */
export function useFocusLost<T extends Element>(
  ref: RefObject<T | null>,
  onFocusLost: (element: T) => void,
  holdsFocus = false,
): void {
  const focusLost = useEffectEvent(onFocusLost);
  // Read at cleanup time rather than listed as a dependency: a flag that flips
  // on every open and close would run the cleanup while the element is still
  // mounted, just after the popup returned focus to it.
  const holding = useEffectEvent(() => holdsFocus);

  // Focus inside an element that leaves drops to <body>. A layout cleanup runs while the element is still attached.
  useLayoutEffect(() => {
    const element = ref.current;

    return () => {
      if (element !== null && (element.contains(document.activeElement) || holding())) {
        focusLost(element);
      }
    };
  }, [ref]);
}
