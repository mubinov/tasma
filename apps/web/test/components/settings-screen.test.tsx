import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUiStore } from "../../src/store/ui";
import { renderWithRouter } from "../helpers";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ themePreference: "system" });
});

afterEach(() => {
  cleanup();
  // renderWithRouter stubs scrollTo, which jsdom does not implement.
  vi.unstubAllGlobals();
});

// A label carried by aria-label alone is a group label only screen-reader users
// get, and "System" does not say what it follows without it.
it("names the theme group with a label every user can see", async () => {
  await renderWithRouter("/settings");

  const group = screen.getByRole("radiogroup", { name: "Theme" });
  const label = document.getElementById(group.getAttribute("aria-labelledby")!);

  expect(label?.textContent).toBe("Theme");
  expect(group.getAttribute("aria-label")).toBeNull();
});

it("offers the theme as one radio group rather than three toggles", async () => {
  await renderWithRouter("/settings");

  const group = screen.getByRole("radiogroup", { name: "Theme" });
  const radios = screen.getAllByRole("radio");

  expect(radios.map((radio) => radio.textContent)).toEqual(["System", "Light", "Dark"]);
  expect(radios.every((radio) => group.contains(radio))).toBe(true);
  expect(screen.getByRole("radio", { checked: true }).textContent).toBe("System");
});

// Forced-colors mode replaces every author colour, so a state told apart by
// colour alone disappears there. Only the selected card carries the mark.
it("marks the selected card with an element, not colour alone", async () => {
  await renderWithRouter("/settings");

  const selected = screen.getByRole("radio", { checked: true });
  const rest = screen.getAllByRole("radio").filter((radio) => radio !== selected);

  expect(selected.querySelector("[data-checked]")).not.toBeNull();
  expect(rest.every((radio) => radio.querySelector("[data-checked]") === null)).toBe(true);
});

// Three independent toggles would take three; a radio group rovers the tab
// index across its members and takes one.
it("takes a single tab stop for the whole group", async () => {
  await renderWithRouter("/settings");

  const focusable = screen.getAllByRole("radio").filter((radio) => radio.tabIndex === 0);
  expect(focusable).toHaveLength(1);
});

/*
 * The class on <html> is not asserted here. ThemeSync sits above the router in
 * main.tsx, so this render carries no subscriber; the wired path is proved in
 * test/smoke.test.tsx.
 */
it("switches the theme from the settings screen", async () => {
  await renderWithRouter("/settings");

  await userEvent.click(screen.getByRole("radio", { name: "Light" }));

  expect(useUiStore.getState().themePreference).toBe("light");
  expect(screen.getByRole("radio", { checked: true }).textContent).toBe("Light");
});
