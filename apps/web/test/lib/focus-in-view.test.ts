import { afterEach, expect, it, vi } from "vitest";
import { focusInView } from "../../src/lib/focus-in-view";
import { stubHitTest } from "../helpers";

type Box = { top: number; bottom: number };

/** A heading 300 px wide at the given height of a 768 px window, with its text in a child element. */
function heading({ top, bottom }: Box): { element: HTMLElement; text: HTMLElement } {
  const element = document.createElement("h2");
  element.tabIndex = -1;
  const text = document.createElement("span");
  text.textContent = "Claude · build";
  element.append(text);
  document.body.append(element);
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    { left: 24, right: 324, top, bottom, width: 300, height: bottom - top } as DOMRect,
  );

  return { element, text };
}

/** The page as a hit test sees it: a bar over the top 64 px, the heading in its box, the body elsewhere. */
function page(bar: HTMLElement, { element, text }: { element: HTMLElement; text: HTMLElement }): void {
  stubHitTest((x, y) => {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
      return null;
    }
    if (y < 64) {
      return bar;
    }
    const box = element.getBoundingClientRect();
    const inside = x >= box.left && x < box.right && y >= box.top && y < box.bottom;
    return inside ? (y < box.top + box.height / 2 ? element : text) : document.body;
  });
}

function bar(): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);

  return element;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it("focuses an element that shows whole with no scroll", () => {
  const shown = heading({ top: 100, bottom: 124 });
  page(bar(), shown);
  const focus = vi.spyOn(shown.element, "focus");

  focusInView(shown.element);

  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  expect(document.activeElement).toBe(shown.element);
});

it("focuses an element with the scroll that reveals it when a bar covers its top", () => {
  const covered = heading({ top: 52, bottom: 76 });
  page(bar(), covered);
  const focus = vi.spyOn(covered.element, "focus");

  focusInView(covered.element);

  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: false });
  expect(document.activeElement).toBe(covered.element);
});

it("focuses an element with the scroll that reveals it when its end is below the window", () => {
  const below = heading({ top: 760, bottom: 784 });
  page(bar(), below);
  const focus = vi.spyOn(below.element, "focus");

  focusInView(below.element);

  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: false });
});

it("focuses an element with the scroll that reveals it when it is above the window", () => {
  const above = heading({ top: -400, bottom: -376 });
  page(bar(), above);
  const focus = vi.spyOn(above.element, "focus");

  focusInView(above.element);

  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: false });
});

it("does nothing for no element", () => {
  expect(() => {
    focusInView(null);
  }).not.toThrow();
  expect(document.activeElement).toBe(document.body);
});
