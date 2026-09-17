import { afterEach, expect, it } from "vitest";
import { scrollPadding } from "../../src/lib/scroll-padding";

let element: HTMLElement;

afterEach(() => {
  element.remove();
});

function styled(css: string): HTMLElement {
  element = document.createElement("div");
  element.style.cssText = css;
  document.body.append(element);
  return element;
}

it("reads the computed top and bottom scroll padding in px", () => {
  expect(scrollPadding(styled("scroll-padding-top: 72px; scroll-padding-bottom: 120.5px"))).toEqual({
    top: 72,
    bottom: 120.5,
  });
});

it("reads a scroll padding that is not set as 0", () => {
  expect(scrollPadding(styled(""))).toEqual({ top: 0, bottom: 0 });
});

it("reads `auto` as 0", () => {
  expect(scrollPadding(styled("scroll-padding-top: auto; scroll-padding-bottom: auto"))).toEqual({ top: 0, bottom: 0 });
});
