import type { Diagnostic } from "@tasma/protocol";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { daemonKeys } from "../../src/api/queries";
import { refusalReply, renderWithRouter, stubTransport, successReply } from "../helpers";

const CONFIG = {
  statuses: ["Backlog", "To Do", "In Progress", "Done"],
  default_status: "Backlog",
  final_statuses: ["Done"],
  priorities: ["high", "medium", "low"],
  workflows: ["dev", "design"],
  instructions: ["/repos/delta/AGENTS.md", "/repos/delta/CLAUDE.md"],
};

const PROJECT = { tag: "DELTA", name: "Delta", path: "/repos/delta", live: true, config: CONFIG };

const WARNING: Diagnostic = { code: "path-missing", message: "the repository is not on disk", path: "/repos/delta" };

/** Mounts the page over one project answer, with the fields a test cares about changed. */
async function renderProject(overrides: Record<string, unknown>, tag = "DELTA") {
  const { transport } = stubTransport({ [`/projects/${tag}`]: successReply({ ...PROJECT, ...overrides }) });

  return renderWithRouter(`/projects/${tag}`, transport);
}

/**
 * The value cell of one configuration row, found through the term beside it.
 * The lookup is scoped to the list, because a `<dt>` takes its name from the
 * author alone and the sidebar carries the same words as two of the terms.
 */
function valueCellOf(term: string): HTMLElement {
  const list = screen.getByText("Configuration").nextElementSibling as HTMLElement;

  return within(list).getByText(term).nextElementSibling as HTMLElement;
}

/** The text of every value chip in one configuration row. */
function chipsIn(term: string): (string | null)[] {
  return [...valueCellOf(term).querySelectorAll(":scope > span > span")].map((chip) => chip.textContent);
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

it("links back to the list", async () => {
  await renderProject({});

  const back = within(screen.getByRole("main")).getByRole("link", { name: "Projects" });

  expect(back.getAttribute("href")).toBe("/projects");
});

it("heads the page with the name and marks the tag beside it", async () => {
  await renderProject({});

  const heading = screen.getByRole("heading", { level: 1 });

  expect(heading.textContent).toBe("Delta");
  expect(screen.getByRole("main").textContent).toContain("DELTA");
  expect(screen.getByText("/repos/delta")).toBeTruthy();
  expect(document.title).toBe("Delta · tasma");
});

// With no name the heading is already the tag, so the chip is dropped rather
// than showing the same token twice.
it("heads the page with the tag when the project declares no name", async () => {
  await renderProject({ tag: "ACME", name: undefined, path: undefined }, "ACME");

  const main = screen.getByRole("main");

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("ACME");
  expect(within(main).getAllByText("ACME")).toHaveLength(1);
  expect(document.title).toBe("ACME · tasma");
});

it("marks the default and the final statuses on the statuses row", async () => {
  await renderProject({});

  const chips = chipsIn("Statuses");

  expect(chips).toEqual(["Backlog default", "To Do", "In Progress", "Done final"]);
});

// The engine checks the type of a declared list and nothing else, so a
// hand-edited config.yml reaches the screen with the same value twice.
it("renders a configuration that declares the same value twice", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  await renderProject({
    config: { ...CONFIG, statuses: ["Backlog", "Backlog"], instructions: ["/repos/delta/AGENTS.md", "/repos/delta/AGENTS.md"] },
  });

  expect(chipsIn("Statuses")).toEqual(["Backlog default", "Backlog default"]);
  expect(valueCellOf("Project instructions").textContent).toBe("/repos/delta/AGENTS.md/repos/delta/AGENTS.md");
  expect(consoleError).not.toHaveBeenCalled();
});

it("lists the priorities, the workflows and the project instructions in the daemon's order", async () => {
  await renderProject({});

  expect(chipsIn("Priorities")).toEqual(["high", "medium", "low"]);
  expect(chipsIn("Workflows")).toEqual(["dev", "design"]);
  expect(valueCellOf("Project instructions").textContent).toBe("/repos/delta/AGENTS.md/repos/delta/CLAUDE.md");
});

/*
 * A configuration value is user-authored text of no bounded length. A fixed
 * height centres a wrapped value outside its own border, over the chips above
 * and below it, and a value with no break opportunity runs past the card.
 */
it("lets a long configuration value break and grow its chip", async () => {
  const workflow = "engineering-review-and-integration-with-release-checklist-workflow";

  await renderProject({ config: { ...CONFIG, workflows: [workflow] } });

  const chip = within(valueCellOf("Workflows")).getByText(workflow);

  expect(chip.classList.contains("wrap-anywhere")).toBe(true);
  expect(chip.classList.contains("min-h-5.5")).toBe(true);
  expect(chip.classList.contains("h-5.5")).toBe(false);
});

/*
 * The mark is a flex item of a chip that breaks mid-token, so a mark left
 * shrinkable narrows to a single character beside a status long enough to wrap
 * and breaks its own word down a column.
 */
it("keeps the mark of a status whole where the status wraps", async () => {
  const status = "Waiting for an external review";

  await renderProject({ config: { ...CONFIG, statuses: [status], default_status: status, final_statuses: [status] } });

  const chip = valueCellOf("Statuses").querySelector(":scope > span > span")!;
  const marks = [...chip.querySelectorAll("span")];

  expect(marks.map((mark) => [mark.textContent, mark.classList.contains("shrink-0")])).toEqual([
    ["default", true],
    ["final", true],
  ]);
});

it("says None where the project declares no workflow and no instruction", async () => {
  await renderProject({ config: { ...CONFIG, workflows: [], instructions: [] } });

  expect(valueCellOf("Workflows").textContent).toBe("None");
  expect(valueCellOf("Project instructions").textContent).toBe("None");
});

// It is a user-level key that applies to every project, and the screen cannot
// tell a declared value from the built-in default it stands for.
it("does not show the workflows path", async () => {
  await renderProject({ config: { ...CONFIG, workflows_path: "/repos/delta/workflows" } });

  expect(screen.getByRole("main").textContent).not.toContain("/repos/delta/workflows");
});

it("shows the notice only when the index stopped following the disk", async () => {
  await renderProject({ live: false });
  expect(within(screen.getByRole("note")).getByText("The index is not following the disk")).toBeTruthy();

  cleanup();
  await renderProject({ live: true });
  expect(screen.queryByRole("note")).toBeNull();
});

it("shows the daemon's warnings about the project", async () => {
  const user = userEvent.setup();
  const { transport } = stubTransport({
    "/projects/DELTA": successReply(PROJECT, [
      { code: "path-missing", message: "the repository is not on disk", path: "/repos/delta" },
      { code: "config-key-unknown", message: "unknown key: colour", path: "/repos/delta/config.yml", line: 4 },
    ]),
  });
  await renderWithRouter("/projects/DELTA", transport);

  const line = within(screen.getByRole("main")).getByRole("heading", { level: 2, name: /warnings/ });
  expect(line.textContent).toBe("2 warnings about this project");

  await user.click(screen.getByRole("button", { name: "Show 2 warnings about this project" }));

  expect(within(screen.getByRole("list", { name: "2 warnings about this project" })).getAllByRole("listitem")).toHaveLength(2);
});

it.each([
  { place: "under the notice", live: false, margin: "mt-3" },
  { place: "with no notice", live: true, margin: "mt-7" },
])("spaces the warnings line $place", async ({ live, margin }) => {
  const { transport } = stubTransport({ "/projects/DELTA": successReply({ ...PROJECT, live }, [WARNING]) });
  await renderWithRouter("/projects/DELTA", transport);

  const line = screen.getByRole("heading", { level: 2, name: /warning/ }).parentElement!;

  expect(line.parentElement!.className).toBe(margin);
});

/*
 * What the live region says, which is a summary and not the notice and the rows
 * themselves: a refetch on window focus can turn either up while the page stays
 * put, and an announcement is lost as soon as anything interrupts it.
 */
it.each([
  { state: "an answer with nothing to report", live: true, warnings: [], said: "" },
  { state: "an index that stopped following the disk", live: false, warnings: [], said: "The index is not following the disk." },
  { state: "one warning", live: true, warnings: [WARNING], said: "1 warning about this project." },
  {
    state: "both, in one sentence each",
    live: false,
    warnings: [WARNING, WARNING],
    said: "The index is not following the disk. 2 warnings about this project.",
  },
])("announces $state", async ({ live, warnings, said }) => {
  const { transport } = stubTransport({ "/projects/DELTA": successReply({ ...PROJECT, live }, warnings) });

  await renderWithRouter("/projects/DELTA", transport);

  expect(screen.getByRole("status").textContent).toBe(said);
});

it("shows no warnings line where the daemon reported nothing", async () => {
  await renderProject({});

  expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
});

/*
 * The screens hold no <Suspense> boundary because `useSuspenseQuery` suspends
 * only while it holds no data. After the stale time a revisit refetches in the
 * background, and the page has to stay on screen while that answer is on its way.
 */
it("keeps the page on screen while a background refetch answers again", async () => {
  const { transport, paths } = stubTransport({ "/projects/DELTA": successReply(PROJECT) });
  const router = await renderWithRouter("/projects/DELTA", transport);

  await act(async () => {
    await router.options.context.queryClient.invalidateQueries({ queryKey: daemonKeys.project("DELTA") });
  });

  expect(paths.filter((path) => path === "/projects/DELTA")).toHaveLength(2);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Delta");
  expect(chipsIn("Statuses")).toEqual(["Backlog default", "To Do", "In Progress", "Done final"]);
});

// A refusal is the daemon's answer, not a fault to repeat, so the panel offers
// no Retry and the daemon's own words name the file to fix.
it("hands a refused configuration to the failure panel", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { transport } = stubTransport({
    "/projects/DELTA": refusalReply(422, {
      kind: "store",
      code: "config-invalid",
      message: "/repos/delta/config.yml line 4: statuses must be a sequence",
    }),
  });

  await renderWithRouter("/projects/DELTA", transport);

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("store/config-invalid");
  expect(alert.textContent).toContain("statuses must be a sequence");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

// The daemon answered, so the address names a route: the router's not-found
// screen would say the opposite.
it("hands a tag no project carries to the failure panel", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { transport } = stubTransport({
    "/projects/NOPE": refusalReply(404, { kind: "store", code: "project-not-found", message: "no project is tagged NOPE" }),
  });

  await renderWithRouter("/projects/NOPE", transport);

  expect(screen.getByRole("alert").textContent).toContain("no project is tagged NOPE");
  expect(screen.getByRole("main").textContent).not.toContain("Not found");
});

/*
 * A segment the client will not write into a path is refused by throwing, and a
 * throw from a loader reads as a fault in our own code — the one arm of the
 * panel that tells the person to restart the window. A hand-typed address is
 * not that, so the route answers it before the daemon is asked.
 */
it.each([{ segment: ".." }, { segment: "." }, { segment: "%5C" }])(
  "hands the address /projects/$segment to the not-found screen",
  async ({ segment }) => {
    const { transport, paths } = stubTransport();

    await renderWithRouter(`/projects/${segment}`, transport);

    expect(screen.getByRole("main").textContent).toContain("names nothing the application can show");
    expect(paths).toEqual([]);
  },
);
