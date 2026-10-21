/**
 * Focuses the element, and scrolls the page only when the element does not
 * show whole. A focus scroll keeps its target clear of the page's scroll
 * padding also where no top bar covers the target, so a plain focus can move
 * the page for an element in a sticky column that shows.
 */
export function focusInView(element: HTMLElement | null): void {
  if (element !== null) {
    element.focus({ preventScroll: showsWhole(element) });
  }
}

/** Inside the window, with no other element, such as a sticky bar, over its corners. */
function showsWhole(element: HTMLElement): boolean {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  const hits = (x: number, y: number) => element.contains(document.elementFromPoint(x, y));

  return hits(left + 1, top + 1) && hits(right - 1, bottom - 1);
}
