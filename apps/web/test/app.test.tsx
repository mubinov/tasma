import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { useUiStore } from "../src/store/ui";
import { stubSystemTheme } from "./helpers";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ themePreference: "system" });
  document.documentElement.className = "";
  stubSystemTheme("dark");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The one <h1> opens the main content: it is the heading a screen-reader user
// jumps to in order to skip the chrome, so nothing before <main> is a heading.
it("opens the main content with the page's only h1", () => {
  render(<App />);

  const headings = screen.getAllByRole("heading", { level: 1 });
  expect(headings).toHaveLength(1);
  expect(screen.getByRole("main").contains(headings[0]!)).toBe(true);
  expect(screen.getByRole("banner").querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
});

// A label carried by aria-label alone is a group label only screen-reader users
// get, and "System" does not say what it follows without it.
it("names the theme group with a label every user can see", () => {
  render(<App />);

  const group = screen.getByRole("radiogroup", { name: "Theme" });
  const label = document.getElementById(group.getAttribute("aria-labelledby")!);

  expect(label?.textContent).toBe("Theme");
  expect(group.getAttribute("aria-label")).toBeNull();
});

it("offers the theme as one radio group rather than three toggles", () => {
  render(<App />);

  const group = screen.getByRole("radiogroup", { name: "Theme" });
  const radios = screen.getAllByRole("radio");

  expect(radios.map((radio) => radio.textContent)).toEqual(["System", "Light", "Dark"]);
  expect(radios.every((radio) => group.contains(radio))).toBe(true);
  expect(screen.getByRole("radio", { checked: true }).textContent).toBe("System");
});

// Forced-colors mode replaces every author colour, so a state told apart by
// colour alone disappears there. Only the selected segment carries the mark.
it("marks the selected segment with an element, not colour alone", () => {
  render(<App />);

  const selected = screen.getByRole("radio", { checked: true });
  const rest = screen.getAllByRole("radio").filter((radio) => radio !== selected);

  expect(selected.querySelector("[data-checked]")).not.toBeNull();
  expect(rest.every((radio) => radio.querySelector("[data-checked]") === null)).toBe(true);
});

// Three independent toggles would take three; a radio group rovers the tab
// index across its members and takes one.
it("takes a single tab stop for the whole group", () => {
  render(<App />);

  const focusable = screen.getAllByRole("radio").filter((radio) => radio.tabIndex === 0);
  expect(focusable).toHaveLength(1);
});

it("switches the theme from the shell's own control", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("radio", { name: "Light" }));

  expect(useUiStore.getState().themePreference).toBe("light");
  expect(screen.getByRole("radio", { checked: true }).textContent).toBe("Light");
  expect(document.documentElement.classList.contains("light")).toBe(true);
});
