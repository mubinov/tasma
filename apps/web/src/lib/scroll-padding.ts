function pixels(value: string): number {
  const number = Number.parseFloat(value);
  return Number.isNaN(number) ? 0 : number;
}

/** The element's computed top and bottom scroll padding in px, 0 for `auto`. */
export function scrollPadding(element: Element): { top: number; bottom: number } {
  const { scrollPaddingTop, scrollPaddingBottom } = getComputedStyle(element);
  return { top: pixels(scrollPaddingTop), bottom: pixels(scrollPaddingBottom) };
}
