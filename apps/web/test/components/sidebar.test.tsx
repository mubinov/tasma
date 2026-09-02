import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FOOTER_NAVIGATION, PRIMARY_NAVIGATION } from "../../src/navigation";
import { useUiStore } from "../../src/store/ui";
import { renderWithRouter } from "../helpers";

const LABELS = [...PRIMARY_NAVIGATION, ...FOOTER_NAVIGATION].map((entry) => entry.label);

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ sidebarCollapsed: false });
});

afterEach(() => {
  cleanup();
  // renderWithRouter stubs scrollTo, which jsdom does not implement.
  vi.unstubAllGlobals();
});

it("offers every destination, and the collapse toggle beside them", async () => {
  await renderWithRouter();

  for (const label of LABELS) {
    expect(screen.getByRole("link", { name: label })).toBeTruthy();
  }
  expect(screen.getAllByRole("link")).toHaveLength(LABELS.length);
  expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
});

/*
 * Two navigation landmarks would each need a name to tell them apart, and a
 * Settings link inside no landmark at all would be worse. One unnamed <nav>
 * leaves the landmark list unambiguous.
 */
it("holds the destinations in exactly one navigation landmark", async () => {
  await renderWithRouter();

  const landmarks = screen.getAllByRole("navigation");
  expect(landmarks).toHaveLength(1);
  for (const label of LABELS) {
    expect(landmarks[0]!.contains(screen.getByRole("link", { name: label }))).toBe(true);
  }
});

/*
 * The wordmark and the collapse toggle sit outside the <nav>, so without a
 * landmark around the whole column a user moving by landmark would skip past
 * the one control that changes the sidebar and never reach it.
 */
it("keeps the brand and the toggle inside the banner landmark", async () => {
  await renderWithRouter();

  const banner = screen.getByRole("banner");
  expect(banner.contains(screen.getByRole("button", { name: "Collapse sidebar" }))).toBe(true);
  expect(banner.contains(screen.getByText("tasma"))).toBe(true);
  expect(banner.contains(screen.getByRole("navigation"))).toBe(true);
});

it("marks the current destination, and only that one", async () => {
  await renderWithRouter();

  const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
  expect(current.map((link) => link.textContent)).toEqual(["Dashboard"]);
});

// Every path starts with "/", so a prefix match leaves Dashboard current on
// every screen. Its link is the one that matches exactly.
it("does not leave Dashboard current on another screen", async () => {
  await renderWithRouter("/tasks");

  const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
  expect(current.map((link) => link.textContent)).toEqual(["Tasks"]);
});

it("marks Settings current on its own screen", async () => {
  await renderWithRouter("/settings");

  const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
  expect(current.map((link) => link.textContent)).toEqual(["Settings"]);
});

/*
 * What this can prove in jsdom is the part a developer gets wrong: the label is
 * never removed from the DOM when collapsed. display: none would take the
 * accessible name with it and leave five unnamed links. That the CSS clips and
 * fades it instead of hiding it is checked by eye.
 */
it("keeps every link named once collapsed", async () => {
  useUiStore.setState({ sidebarCollapsed: true });
  await renderWithRouter();

  for (const label of LABELS) {
    expect(screen.getByRole("link", { name: label })).toBeTruthy();
  }
});

/*
 * jsdom computes no styles, so the rendered class is the only artifact of the
 * width there is. It is still worth pinning: without it, deleting the width
 * from the column leaves every other test in this file green.
 *
 * The full width is a breakpoint variant rather than a plain utility because
 * below it the rail is forced — at 320 CSS px a 240px sidebar leaves the
 * content less than one heading's width.
 */
it("carries the rail width always and the full width only above the breakpoint", async () => {
  const user = userEvent.setup();
  await renderWithRouter();

  const sidebar = screen.getByRole("banner");
  expect(sidebar.classList.contains("w-16")).toBe(true);
  expect(sidebar.classList.contains("sm:w-60")).toBe(true);

  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

  expect(sidebar.classList.contains("w-16")).toBe(true);
  expect(sidebar.classList.contains("sm:w-60")).toBe(false);
});

// A disclosure, not a toggle: it expands and collapses a region. The button
// carries no visible label in either state, so its name has to change with it,
// and aria-controls is what says which region it means.
it("flips the disclosure state and renames the toggle", async () => {
  const user = userEvent.setup();
  await renderWithRouter();

  const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
  expect(collapse.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(collapse.getAttribute("aria-controls")!)).toBe(screen.getByRole("banner"));

  await user.click(collapse);

  const expand = screen.getByRole("button", { name: "Expand sidebar" });
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
});

// It is a control, not a destination, so it is outside the navigation landmark
// and never carries aria-current.
it("keeps the toggle out of the navigation landmark", async () => {
  await renderWithRouter();

  const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
  expect(screen.getByRole("navigation").contains(toggle)).toBe(false);
  expect(toggle.getAttribute("aria-current")).toBeNull();
});
