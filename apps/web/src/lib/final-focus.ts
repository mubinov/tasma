/**
 * Where a closing dialog leaves focus:
 *
 * - an element — focus it;
 * - `"keep"` — leave focus alone, for a close that takes the whole screen with
 *   it. Base UI reads its destination while the old screen is still rendered
 *   and focuses it a microtask later, by which time that element is detached
 *   and the caret drops to the document body. Also for a close whose
 *   destination another mechanism owns, such as a dialog that closes together
 *   with the dialog it is nested in;
 * - `null` — Base UI's own destination, the element that had focus when the
 *   dialog opened.
 */
export type FinalFocus = HTMLElement | "keep" | null;

/**
 * Focuses the first candidate that is in the document and takes focus. Both
 * halves matter: a card the page's own rules removed is absent, and a heading
 * with no `tabIndex` is present and refuses the caret, which would leave it on
 * `<body>`. The list ends with a destination that is there by construction.
 */
export function focusFirst(candidates: readonly (HTMLElement | null | undefined)[]): void {
  for (const candidate of candidates) {
    if (candidate?.isConnected !== true) {
      continue;
    }

    candidate.focus();
    if (document.activeElement === candidate) {
      return;
    }
  }
}
