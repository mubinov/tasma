import { afterEach, expect, it } from "vitest";
import { pageScrollPadding, scrollPadding } from "../../src/lib/scroll-padding";

let element: HTMLElement | undefined;

afterEach(() => {
  element?.remove();
  element = undefined;
  document.documentElement.style.cssText = "";
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

it("reads the page's top scroll padding in px from the root, also while the root has no scroll padding", () => {
  document.documentElement.style.cssText = "--page-scroll-padding: 113px; scroll-padding-top: 0px";

  expect(pageScrollPadding()).toBe(113);
});

it("reads a page scroll padding that is not set as 0", () => {
  expect(pageScrollPadding()).toBe(0);
});
