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
