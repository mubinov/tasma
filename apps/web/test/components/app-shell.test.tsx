import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FOOTER_NAVIGATION, PRIMARY_NAVIGATION } from "../../src/navigation";
import { PLACEHOLDER_SUMMARIES } from "../../src/routes";
import { useUiStore } from "../../src/store/ui";
import { renderWithRouter } from "../helpers";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ sidebarCollapsed: false });
  document.title = "tasma";
});

afterEach(() => {
  cleanup();
  // renderWithRouter stubs scrollTo, which jsdom does not implement.
  vi.unstubAllGlobals();
});

// The one <h1> opens the main content: it is the heading a screen-reader user
// jumps to in order to skip the chrome, so nothing before <main> is a heading.
it("opens the main content with the page's only h1", async () => {
  await renderWithRouter();

  const headings = screen.getAllByRole("heading", { level: 1 });
  expect(headings).toHaveLength(1);
  expect(screen.getByRole("main").contains(headings[0]!)).toBe(true);
  expect(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).toHaveLength(1);
});

/*
 * The shell is the root route's component rather than a wrapper inside each
 * screen, so a route change swaps the outlet alone. This asserts node identity
 * rather than any state the sidebar holds: the collapse flag lives in a
 * module-level store and would survive a remount, so it would prove nothing.
 * What a remount really destroys is the scroll position, any transition
 * mid-flight, and every effect the shell has already run.
 */
it("keeps the sidebar mounted across a route change", async () => {
  const router = await renderWithRouter();
  const sidebar = screen.getByRole("navigation");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Dashboard");

  await act(async () => {
    await router.navigate({ to: "/tasks" });
  });

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Tasks");
  expect(screen.getByRole("navigation")).toBe(sidebar);
});

/*
 * Because the sidebar stays put, a route change moves nothing a screen reader
 * would notice: focus is left on the activated link and there is no live region
 * to speak. Focus on the content region is what makes the new screen the next
 * thing read. The first paint must not take focus, which is the other half of
 * this.
 */
it("moves focus to the content region on a route change, not on the first paint", async () => {
  const router = await renderWithRouter();
  expect(document.activeElement).toBe(document.body);

  await act(async () => {
    await router.navigate({ to: "/tasks" });
  });

  expect(document.activeElement).toBe(screen.getByRole("main"));
});

// The stack follows <main>, so a notice is on every screen and after the content
// in reading order.
it("mounts the notice stack after the main content", async () => {
  await renderWithRouter();

  const stack = screen.getByRole("main").nextElementSibling;
  expect(stack?.getAttribute("aria-live")).toBe("polite");
});

// jsdom has no layout, so the classes that add the stack's height to the bottom
// padding are what can be checked.
it("keeps room below the main content for the notice stack", async () => {
  await renderWithRouter();

  const main = screen.getByRole("main");
  expect(main.classList.contains("pb-[calc(--spacing(6)+var(--notice-stack-height,0px))]")).toBe(true);
  expect(main.classList.contains("sm:pb-[calc(--spacing(10)+var(--notice-stack-height,0px))]")).toBe(true);
});

// The title is announced on arrival and is what a bookmark and the window list
// show, so it has to follow the screen rather than name the app alone.
it("names the document after the screen it shows", async () => {
  const router = await renderWithRouter();
  expect(document.title).toBe("Dashboard · tasma");

  await act(async () => {
    await router.navigate({ to: "/settings" });
  });

  expect(document.title).toBe("Settings · tasma");
});

/*
 * The root route has children, so an address outside the declared ones matches
 * no child. Left to the router's own fallback the page carries no <h1> at all,
 * and a stale bookmark is enough to reach it.
 */
it("answers an address no route serves with a screen of its own", async () => {
  await renderWithRouter("/nowhere");

  const heading = screen.getByRole("heading", { level: 1 });
  expect(heading.textContent).toBe("Not found");
  expect(screen.getByRole("main").contains(heading)).toBe(true);
  expect(screen.getByRole("navigation")).toBeTruthy();
});

// The routes are declared one by one rather than generated, so each one's
// component is its own line and only mounting them all proves every entry
// reaches the screen it names.
it("renders the screen every entry names", async () => {
  for (const entry of [...PRIMARY_NAVIGATION, ...FOOTER_NAVIGATION]) {
    await renderWithRouter(entry.path);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(entry.label);
    cleanup();
  }
});

// The copy and the route that shows it are declared in the same table, so only
// mounting each one proves a screen carries the sentence declared for it.
it("shows the sentence each placeholder route declares", async () => {
  for (const [path, summary] of Object.entries(PLACEHOLDER_SUMMARIES)) {
    await renderWithRouter(path);

    expect(screen.getByRole("main").textContent).toContain(summary);
    cleanup();
  }
});

// A live region inserted together with its first words is not announced, so the
// one the application speaks through is on the page before any screen writes to it.
it("mounts the spoken region with the shell, empty", async () => {
  await renderWithRouter();

  const region = document.querySelector("[aria-live].sr-only");
  expect(region).not.toBeNull();
  expect(region!.children).toHaveLength(0);
});
