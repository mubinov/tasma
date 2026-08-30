import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubSystemTheme } from "./helpers";

beforeEach(() => {
  vi.resetModules();
  // The entry hydrates from storage, so a preference left by an earlier test
  // would decide this one's starting theme.
  window.localStorage.clear();
  // The router scrolls on mount, which jsdom does not implement.
  vi.stubGlobal("scrollTo", () => {});
  stubSystemTheme("dark");
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

  expect(screen.getByRole("banner")).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, name: "Workspace" })).toBeTruthy();
  expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
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
  expect(screen.getByRole("radio", { checked: true }).textContent).toBe("Light");
});

it("switches the theme through the wired entry path", async () => {
  const user = userEvent.setup();
  document.body.innerHTML = '<div id="root"></div>';

  await act(async () => {
    await import("../src/main");
  });
  await user.click(screen.getByRole("radio", { name: "Light" }));

  expect(document.documentElement.classList.contains("light")).toBe(true);
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

it("fails loudly when the document carries no #root", async () => {
  await expect(import("../src/main")).rejects.toThrow("#root");
});
