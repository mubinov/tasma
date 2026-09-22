import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Empties focus while a modal dialog opens, and hands back the element it took
 * it from.
 *
 * Chrome refuses `aria-hidden` on an element a focused descendant sits under,
 * and does not re-evaluate once focus leaves — so a dialog opened by a pointer
 * click would leave the container of the clicked control readable by a screen
 * reader for the life of that dialog. Base UI hides the outside elements from a
 * passive effect and moves focus into the popup a frame later, which leaves
 * this layout effect the one place between them.
 *
 * Base UI records its own return destination only once the popup registers its
 * element, a commit after this one, so by then focus is already on nothing.
 * The element handed back is therefore the only fallback the dialog has.
 */
export function useFocusEmptiedWhileOpening(open: boolean): RefObject<HTMLElement | null> {
  const openerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const focused = document.activeElement;
    const opener = focused instanceof HTMLElement && focused !== document.body ? focused : null;

    openerRef.current = opener;
    opener?.blur();
  }, [open]);

  return openerRef;
}
