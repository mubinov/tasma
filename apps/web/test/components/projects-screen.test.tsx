import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refusalReply, renderWithRouter, stubTransport, successReply } from "../helpers";

const PROJECTS = [
  { tag: "CLIB", name: "clib", path: "/repos/clib" },
  { tag: "TASM", name: "tasma", path: "/repos/tasma" },
  // The daemon lists a project whose configuration it could not read by tag
  // alone; the list route cannot tell that from a project declaring neither.
  { tag: "ZED" },
];

// What the row leads to. The page renders the whole configuration, so this is
// the least a project can carry and still open; the page's own tests cover what
// it makes of it.
const OPENED = {
  tag: "TASM",
  name: "tasma",
  live: true,
  config: {
    statuses: ["Backlog"],
    default_status: "Backlog",
    final_statuses: [],
    priorities: [],
    workflows: [],
    instructions: [],
  },
};

function listing(projects: unknown[] = PROJECTS) {
  return stubTransport({ "/projects": successReply(projects) }).transport;
}

function rows(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Projects" })).getAllByRole("link");
}

/** The row by where it leads, which is the one thing the daemon's order cannot change. */
function rowFor(tag: string): HTMLElement {
  return rows().find((row) => row.getAttribute("href") === `/projects/${tag}`)!;
}

beforeEach(() => {
  document.title = "tasma";
});

afterEach(() => {
  cleanup();
  // renderWithRouter stubs scrollTo, which jsdom does not implement.
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The rows carry the daemon's order, which is sorted by tag: the screen adds no
// sort of its own, so a change to that order shows up here.
it("lists every project the daemon answers, in the order it answered", async () => {
  await renderWithRouter("/projects", listing());

  expect(rows().map((row) => row.getAttribute("href"))).toEqual([
    "/projects/CLIB",
    "/projects/TASM",
    "/projects/ZED",
  ]);
});

it("shows the name, the tag and the path of a row", async () => {
  await renderWithRouter("/projects", listing());

  const row = within(rowFor("TASM"));

  expect(row.getByText("tasma")).toBeTruthy();
  expect(row.getByText("TASM")).toBeTruthy();
  expect(row.getByText("/repos/tasma")).toBeTruthy();
});

// The whole card is the link, so what it reads out is everything the row shows —
// the tag and nothing more where that is all the daemon has.
it("shows a project the daemon lists by tag alone", async () => {
  await renderWithRouter("/projects", listing());

  expect(rowFor("ZED").textContent).toBe("ZED");
});

it("opens the main content with the heading Projects and names the document", async () => {
  await renderWithRouter("/projects", listing());

  const headings = screen.getAllByRole("heading", { level: 1 });

  expect(headings).toHaveLength(1);
  expect(headings[0]!.textContent).toBe("Projects");
  expect(screen.getByRole("main").contains(headings[0]!)).toBe(true);
  expect(document.title).toBe("Projects · tasma");
});

// A tree with no project is the normal first run, not a fault, so it is a
// sentence rather than a panel.
it("says a tree with no project is normal", async () => {
  await renderWithRouter("/projects", listing([]));

  expect(screen.getByRole("main").textContent).toContain("No projects yet.");
  expect(screen.queryByRole("list", { name: "Projects" })).toBeNull();
});

it("opens a project's page from its row", async () => {
  const user = userEvent.setup();
  const { transport, paths } = stubTransport({
    "/projects": successReply(PROJECTS),
    "/projects/TASM": successReply(OPENED),
  });
  await renderWithRouter("/projects", transport);

  await user.click(rowFor("TASM"));

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("tasma");
  expect(paths.at(-1)).toBe("/projects/TASM");
});

// No loader catches anything, so a refused list reaches the router's failure
// surface with the daemon's own words.
it("hands a refusal to the failure panel", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { transport } = stubTransport({
    "/projects": refusalReply(500, { kind: "daemon", code: "internal", message: "the tree could not be read" }),
  });

  await renderWithRouter("/projects", transport);

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("daemon/internal");
  expect(alert.textContent).toContain("the tree could not be read");
  expect(screen.queryByRole("list", { name: "Projects" })).toBeNull();
});
