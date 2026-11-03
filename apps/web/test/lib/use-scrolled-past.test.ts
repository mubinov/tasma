import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useScrolledPast } from "../../src/lib/use-scrolled-past";
import { stubIntersectionObserver } from "../helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const target = document.createElement("h1");

it("counts from the bottom edge of the bar, which includes the band", () => {
  const io = stubIntersectionObserver();

  const { result } = renderHook(() => useScrolledPast({ current: target }, 81));

  expect(io.observers[0]?.options.rootMargin).toBe("-81px 0px 0px 0px");

  io.report({ target, top: 40, bottom: 80 });
  expect(result.current).toBe(true);

  io.report({ target, top: 60, bottom: 90, isIntersecting: true });
  expect(result.current).toBe(false);
});

it("observes again when the bottom edge changes", () => {
  const io = stubIntersectionObserver();

  const { rerender } = renderHook(({ bottom }) => useScrolledPast({ current: target }, bottom), {
    initialProps: { bottom: 81 },
  });
  rerender({ bottom: 53 });

  expect(io.observers.at(-1)?.options.rootMargin).toBe("-53px 0px 0px 0px");
  expect(io.observers[0]?.targets.size).toBe(0);
});

it("observes nothing before the bottom edge is measured", () => {
  const io = stubIntersectionObserver();

  renderHook(() => useScrolledPast({ current: target }, undefined));

  expect(io.observers).toEqual([]);
});
