function pixels(value: string): number {
  const number = Number.parseFloat(value);
  return Number.isNaN(number) ? 0 : number;
}

/** The element's computed top and bottom scroll padding in px, 0 for `auto`. */
export function scrollPadding(element: Element): { top: number; bottom: number } {
  const { scrollPaddingTop, scrollPaddingBottom } = getComputedStyle(element);
  return { top: pixels(scrollPaddingTop), bottom: pixels(scrollPaddingBottom) };
}

/** The page's top scroll padding in px, also while the top bar holds focus and the page has none. */
export function pageScrollPadding(): number {
  return pixels(getComputedStyle(document.documentElement).getPropertyValue("--page-scroll-padding"));
}
