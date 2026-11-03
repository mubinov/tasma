import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TITLE_COVER_ID, useTopBarLengths } from "../../src/lib/use-top-bar-lengths";
import { stubResizeObservers } from "../helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.documentElement.style.cssText = "";
});

function element(height: number, id?: string): { node: HTMLElement; setHeight: (next: number) => void } {
  const node = document.createElement("div");
  if (id !== undefined) {
    node.id = id;
  }
  document.body.append(node);
  const box = vi.spyOn(node, "getBoundingClientRect");
  const setHeight = (next: number) => {
    box.mockReturnValue({ height: next } as DOMRect);
  };
  setHeight(height);

  return { node, setHeight };
}

it("gives nothing before the first measure", () => {
  stubResizeObservers();
  const bar = element(53).node;

  const { result } = renderHook(() => useTopBarLengths({ current: bar }));

  expect(result.current).toEqual({ barBottom: undefined, scrollPaddingTop: undefined });
});

it("gives the bottom edge of the bar from the window top: the band and the bar height", () => {
  const resize = stubResizeObservers();
  const bar = element(53).node;
  element(28, TITLE_COVER_ID);

  const { result } = renderHook(() => useTopBarLengths({ current: bar }));
  resize.report(bar);

  expect(result.current.barBottom).toBe(81);
});

it("measures again when the band changes, with the scroll padding that includes it", () => {
  const resize = stubResizeObservers();
  const bar = element(53).node;
  const cover = element(28, TITLE_COVER_ID);
  document.documentElement.style.setProperty("--page-scroll-padding", "92px");

  const { result } = renderHook(() => useTopBarLengths({ current: bar }));
  resize.report(bar);
  expect(result.current).toEqual({ barBottom: 81, scrollPaddingTop: 92 });

  cover.setHeight(0);
  document.documentElement.style.setProperty("--page-scroll-padding", "64px");
  resize.report(cover.node);

  expect(result.current).toEqual({ barBottom: 53, scrollPaddingTop: 64 });
});

it("counts the bar alone when no cover is on the page", () => {
  const resize = stubResizeObservers();
  const bar = element(53).node;

  const { result } = renderHook(() => useTopBarLengths({ current: bar }));
  resize.report(bar);

  expect(result.current.barBottom).toBe(53);
});

it("stops observing the bar and the cover on unmount", () => {
  const resize = stubResizeObservers();
  const bar = element(53).node;
  const cover = element(28, TITLE_COVER_ID).node;

  const { unmount } = renderHook(() => useTopBarLengths({ current: bar }));
  expect(resize.observed(cover)).toBe(true);

  unmount();

  expect(resize.observed(bar)).toBe(false);
  expect(resize.observed(cover)).toBe(false);
});

it("measures nothing with no bar", () => {
  const resize = stubResizeObservers();
  const cover = element(28, TITLE_COVER_ID).node;

  const { result } = renderHook(() => useTopBarLengths({ current: null }));

  expect(resize.observed(cover)).toBe(false);
  expect(result.current.barBottom).toBeUndefined();
});
