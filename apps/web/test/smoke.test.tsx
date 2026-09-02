import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubSystemTheme } from "./helpers";

// The stub is installed once and its handle kept, so a test that changes the
// system appearance mid-run drives the same stub the entry subscribed to.
let system: ReturnType<typeof stubSystemTheme>;

beforeEach(() => {
  vi.resetModules();
  // The entry hydrates from storage, so a preference left by an earlier test
  // would decide this one's starting state.
  window.localStorage.clear();
  // The router scrolls on mount, which jsdom does not implement.
  vi.stubGlobal("scrollTo", () => {});
  system = stubSystemTheme("dark");
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  document.documentElement.className = "";
  vi.unstubAllGlobals();
});

it("mounts the shell into #root without throwing", async () => {
  document.body.innerHTML = '<div id="root"></div>';

  await act(async () => {
    await import("../src/main");
  });

  expect(screen.getByRole("navigation")).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

// The entry resolves the stored preference and writes the class before it
// renders, so a preference disagreeing with the system never paints wrong.
it("starts on the stored preference rather than the system appearance", async () => {
  window.localStorage.setItem("tasma.theme", "light");
  document.body.innerHTML = '<div id="root"></div>';

  await act(async () => {
    await import("../src/main");
  });

  expect(document.documentElement.classList.contains("light")).toBe(true);
});

/*
 * The toggle's state is the only thing this may assert. The collapsed sidebar
 * leaves no artifact on the document the way the theme does, and by the time a
 * mount settles every effect has flushed, so a store hydrated before the first
 * render and one hydrated from an effect paint the same DOM. That hydration
 * happens synchronously is proved in test/store/ui.test.ts; nothing here may
 * assert a width or a class.
 */
it("starts on the stored sidebar state", async () => {
  window.localStorage.setItem("tasma.sidebar", "collapsed");
  document.body.innerHTML = '<div id="root"></div>';

  await act(async () => {
    await import("../src/main");
  });

  expect(screen.getByRole("button", { name: "Expand sidebar" }).getAttribute("aria-expanded")).toBe("false");
});

/*
 * The theme subscription sits above the router and outside the error boundary,
 * because either one replaces the tree below it when a screen throws. Once the
 * entry writes the first class the document stops following prefers-color-scheme
 * on its own, so without a live subscription the palette freezes until reload.
 */
it("follows the system appearance for as long as it runs", async () => {
  document.body.innerHTML = '<div id="root"></div>';

  await act(async () => {
    await import("../src/main");
  });
  expect(document.documentElement.classList.contains("dark")).toBe(true);

  await act(async () => {
    system.set("light");
  });

  expect(document.documentElement.classList.contains("light")).toBe(true);
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

it("fails loudly when the document carries no #root", async () => {
  await expect(import("../src/main")).rejects.toThrow("#root");
});
