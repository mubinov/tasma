import type { Diagnostic, ExcludedFile, Frontmatter, TaskEntry, TransportReply } from "@tasma/protocol";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_URL } from "../../src/api/transport";
import { formatClock } from "../../src/lib/clock";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { heldBack, refusalReply, renderWithRouter, stubTransport, successReply } from "../helpers";

const CONFIG = {
  statuses: ["Backlog", "To Do", "In Progress", "Done"],
  default_status: "Backlog",
  final_statuses: ["Done"],
  priorities: ["high", "medium", "low"],
  workflows: ["dev"],
  instructions: [],
};

const PROJECTS = [
  { tag: "SAGA", name: "Saga", path: "/repos/saga" },
  { tag: "DELTA", name: "Delta", path: "/repos/delta" },
];

const WORKFLOW = {
  name: "dev",
  instructions: [],
  steps: [
    { name: "research", file: "/w/dev/research.md", owner: "agent" },
    { name: "approve", file: "/w/dev/approve.md", owner: "human" },
  ],
};

function entry(number: number, fields: Partial<Frontmatter> = {}): TaskEntry {
  const id = `SAGA-${String(number)}`;

  return {
    id,
    path: `/repos/saga/tasks/${id}.md`,
    blocked: false,
    frontmatter: {
      id,
      title: `Task ${String(number)}`,
      status: "Backlog",
      created: "2026-09-01T10:00:00Z",
      updated: "2026-09-01T10:00:00Z",
      next_comment_id: 1,
      ...fields,
    },
  };
}

function project(tag: string, fields: Record<string, unknown> = {}): TransportReply {
  const summary = PROJECTS.find((candidate) => candidate.tag === tag) ?? { tag };

  return successReply({ ...summary, live: true, config: CONFIG, ...fields });
}

function listing(entries: TaskEntry[], excluded: ExcludedFile[] = [], diagnostics: Diagnostic[] = []): TransportReply {
  return successReply({ entries, excluded }, diagnostics);
}

/** A daemon whose replies a test can change between polls. */
function daemon(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  return stubTransport({
    "/projects": successReply(PROJECTS),
    "/projects/SAGA": project("SAGA"),
    "/projects/SAGA/tasks": listing([]),
    "/projects/DELTA": project("DELTA"),
    "/projects/DELTA/tasks": listing([]),
    ...replies,
  });
}

function column(status: string): HTMLElement {
  return screen.getByRole("region", { name: status });
}

function countOf(status: string): string | null | undefined {
  return within(column(status)).getByRole("heading", { level: 2 }).nextElementSibling?.textContent;
}

function titlesIn(status: string): string[] {
  return within(column(status)).queryAllByText(/^Task \d+$/).map((title) => title.textContent);
}

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ lastTasksProject: null });
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
  document.title = "tasma";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a tree with no project", () => {
  it("heads the screen, says there is no project, and shows no control and no column", async () => {
    const { transport } = daemon({ "/projects": successReply([]) });
    const router = await renderWithRouter("/tasks", transport);

    const main = screen.getByRole("main");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Tasks");
    expect(main.textContent).toContain(
      "No projects yet. The daemon's tree holds no project directory. Add one, and its tasks are shown here. Projects",
    );
    expect(within(main).getByRole("link", { name: "Projects" }).getAttribute("href")).toBe("/projects");
    expect(within(main).queryByRole("button")).toBeNull();
    expect(within(main).queryByRole("combobox")).toBeNull();
    expect(within(main).queryAllByRole("region")).toEqual([]);
    expect(router.state.location.search).toEqual({});
  });
});

describe("the address", () => {
  it("opens the first project when it names none", async () => {
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks", transport);

    expect(router.state.location.search).toEqual({ projects: "SAGA" });
    expect(screen.getByRole("button", { name: "Project Saga SAGA" })).toBeTruthy();
  });

  it("opens the project opened last when the listing holds it", async () => {
    useUiStore.setState({ lastTasksProject: "DELTA" });
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks", transport);

    expect(router.state.location.search).toEqual({ projects: "DELTA" });
  });

  it("opens the first project when the project opened last is gone", async () => {
    useUiStore.setState({ lastTasksProject: "GONE" });
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks", transport);

    expect(router.state.location.search).toEqual({ projects: "SAGA" });
  });

  it("keeps the first of several projects, and the labels", async () => {
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks?projects=DELTA,SAGA&labels=web", transport);

    expect(router.state.location.search).toEqual({ projects: "DELTA", labels: "web" });
  });

  it("reads an empty label list as no filter", async () => {
    const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1, { labels: ["web"] })]) });
    await renderWithRouter("/tasks?projects=SAGA&labels=&view=list", transport);

    expect(countOf("Backlog")).toBe("1");
    expect(screen.getByRole("combobox", { name: "Labels Any" })).toBeTruthy();
  });

  it.each(["2026", "1.0", "true", "null"])("reads the label %s as the text the address holds", async (label) => {
    const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1, { labels: [label] }), entry(2)]) });
    await renderWithRouter(`/tasks?projects=SAGA&labels=${label}`, transport);

    expect(countOf("Backlog")).toBe("1 of 2");
    expect(screen.getByRole("combobox", { name: `Labels ${label}` })).toBeTruthy();
  });

  it("opens the first of repeated project keys", async () => {
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks?projects=SAGA&projects=DELTA", transport);

    expect(router.state.location.search).toEqual({ projects: "SAGA" });
    expect(screen.getByRole("button", { name: "Project Saga SAGA" })).toBeTruthy();
  });

  it("asks the daemon for a tag that reads as a number, and keeps the selector under its refusal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = refusalReply(404, { kind: "store", code: "project-not-found", message: "no project is tagged 2026" });
    const { transport } = daemon({ "/projects/2026": refusal, "/projects/2026/tasks": refusal });
    await renderWithRouter("/tasks?projects=2026", transport);

    expect(screen.getByRole("alert").textContent).toContain("store/project-not-found");
    expect(screen.getByRole("button", { name: "Project 2026" })).toBeTruthy();
  });

  it("hands a tag no URL segment can carry to the not-found screen, with no request", async () => {
    const { transport, paths } = daemon();
    await renderWithRouter("/tasks?projects=..", transport);

    expect(screen.getByRole("main").textContent).toContain("names nothing the application can show");
    expect(paths).toEqual([]);
  });

  it("hands a tag no project carries to the failure panel", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = refusalReply(404, { kind: "store", code: "project-not-found", message: "no project is tagged NOPE" });
    const { transport } = daemon({ "/projects/NOPE": refusal, "/projects/NOPE/tasks": refusal });

    await renderWithRouter("/tasks?projects=NOPE", transport);

    expect(screen.getByRole("alert").textContent).toContain("store/project-not-found");
  });
});

describe("a refused project", () => {
  const INVALID = refusalReply(422, { kind: "store", code: "config-invalid", message: "statuses is empty" });

  it("keeps the project selector under the failure panel, so another project opens", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    const { transport } = daemon({ "/projects/SAGA": INVALID, "/projects/SAGA/tasks": INVALID });
    const router = await renderWithRouter("/tasks", transport);

    expect(router.state.location.search).toEqual({ projects: "SAGA" });
    expect(screen.getByRole("alert").textContent).toContain("store/config-invalid");

    await user.click(screen.getByRole("button", { name: "Project Saga SAGA" }));
    const menu = await screen.findByRole("menu");
    await act(async () => {
      await user.click(within(menu).getByRole("menuitemradio", { name: "Delta DELTA" }));
    });

    expect(router.state.location.search).toEqual({ projects: "DELTA" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No tasks in Delta yet.")).toBeTruthy();
  });

  it.each(["/tasks", "/tasks?projects=SAGA"])("shows no selector at %s when the listing of projects was refused", async (path) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport } = daemon({ "/projects": INVALID });
    await renderWithRouter(path, transport);

    expect(screen.getByRole("alert").textContent).toContain("store/config-invalid");
    expect(screen.queryByRole("button", { name: /^Project/ })).toBeNull();
  });
});

describe("the board", () => {
  it("shows the configured columns in order, each with its count", async () => {
    const { transport } = daemon({
      "/projects/SAGA/tasks": listing([
        entry(1),
        entry(2, { status: "in progress" }),
        entry(3, { status: "Waiting" }),
        entry(4, { status: "Done" }),
      ]),
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    expect(screen.getAllByRole("region").map((region) => region.querySelector("h2")?.textContent)).toEqual(CONFIG.statuses);
    expect(CONFIG.statuses.map(countOf)).toEqual(["2", "0", "1", "1"]);
    expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 3"]);
    expect(titlesIn("In Progress")).toEqual(["Task 2"]);
  });

  it("says the project has no task, and keeps the columns", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks?projects=SAGA", transport);

    expect(screen.getByText("No tasks in Saga yet.")).toBeTruthy();
    expect(screen.getAllByRole("region")).toHaveLength(4);
  });

  it("names a project with no name by its tag", async () => {
    const { transport } = daemon({ "/projects/DELTA": project("DELTA", { name: undefined }) });
    await renderWithRouter("/tasks?projects=DELTA", transport);

    expect(screen.getByText("No tasks in DELTA yet.")).toBeTruthy();
  });

  it("shows each task's step from the workflow it names", async () => {
    const { transport, paths } = daemon({
      "/projects/SAGA/tasks": listing([
        entry(1, { workflow: "dev", step: "approve" }),
        entry(2, { workflow: "dev", step: "research" }),
        entry(3, { workflow: "gone", step: "research" }),
        entry(4, { workflow: "..", step: "research" }),
      ]),
      "/workflows/dev": successReply(WORKFLOW),
      "/workflows/gone": refusalReply(404, { kind: "store", code: "workflow-unknown", message: "no workflow is named gone" }),
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    const backlog = column("Backlog");
    expect(within(backlog).getByText(", step 2 of 2, a human's step")).toBeTruthy();
    expect(within(backlog).getByText(", step 1 of 2, an agent's step")).toBeTruthy();
    expect(within(backlog).getAllByText("research").map((step) => step.className)).toEqual([
      "font-mono text-xs text-text",
      "font-mono text-xs text-dim",
      "font-mono text-xs text-dim",
    ]);
    expect(paths.filter((path) => path.startsWith("/workflows/"))).toEqual(["/workflows/dev", "/workflows/gone"]);
  });

  it("counts the matching tasks of all under a label filter", async () => {
    const { transport } = daemon({
      "/projects/SAGA/tasks": listing([entry(1, { labels: ["web"] }), entry(2), entry(3, { status: "Done", labels: ["web"] })]),
    });
    await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

    expect(CONFIG.statuses.map(countOf)).toEqual(["1 of 2", "0 of 0", "0 of 0", "1 of 1"]);
    expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    expect(screen.getByRole("status").textContent).toBe("2 of 3 tasks carry a selected label.");
  });

  it("says no task carries a label that matches nothing", async () => {
    const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1, { labels: ["web"] }), entry(2)]) });
    await renderWithRouter("/tasks?projects=SAGA&labels=docs", transport);

    expect(screen.getByText("No task in Saga carries any of the selected labels.")).toBeTruthy();
    expect(countOf("Backlog")).toBe("0 of 2");
    expect(screen.getByRole("status").textContent).toBe("0 of 2 tasks carry a selected label.");
  });

  it("wraps the heading line, so the controls stay inside a narrow viewport", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks?projects=SAGA", transport);

    const line = screen.getByRole("heading", { level: 1 }).parentElement!;
    expect(line.classList.contains("flex-wrap")).toBe(true);
    expect(line.lastElementChild?.classList.contains("flex-wrap")).toBe(true);
  });

  it("gives the last column the right padding of main, so the page scrolls past it", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks?projects=SAGA", transport);

    const row = screen.getAllByRole("region")[0]!.parentElement!;
    expect([...row.classList]).toEqual(expect.arrayContaining(["-mr-6", "sm:-mr-10", "*:last:box-content", "*:last:pr-6", "sm:*:last:pr-10"]));
    expect(row.lastElementChild?.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("opens a task's page from the title of its card", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({
      "/projects/SAGA/tasks": listing([entry(1), entry(2)]),
      "/projects/SAGA/tasks/SAGA-2": successReply({ frontmatter: entry(2).frontmatter, body: "", comments: [] }),
    });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);

    await user.click(within(column("Backlog")).getByRole("link", { name: "Task 2" }));

    expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-2");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Task 2");
  });

  it("remembers the project it loaded, titles the document, and marks Tasks current", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks?projects=DELTA", transport);

    expect(window.localStorage.getItem("tasma.tasks.project")).toBe("DELTA");
    expect(useUiStore.getState().lastTasksProject).toBe("DELTA");
    expect(document.title).toBe("Tasks · tasma");
    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual(["Tasks"]);
  });
});

describe("what the daemon reports beside the tasks", () => {
  const MISSING: Diagnostic = { code: "path-missing", message: "the repository is not on disk", path: "/repos/saga" };
  const UNKNOWN: Diagnostic = { code: "config-key-unknown", message: "unknown key: colour", path: "/p/config.yml", line: 4 };
  const BLOCKER: Diagnostic = { code: "blocked-by-unresolved", message: "SAGA-9 names no task", path: "/p/SAGA-1.md" };
  const EXCLUDED: ExcludedFile = { path: "/repos/saga/tasks/SAGA-7.md", code: "task-file-unreadable", message: "no frontmatter" };

  it("shows the notice and a warnings line of both reads, with the repeats removed", async () => {
    const { transport } = daemon({
      "/projects/SAGA": successReply({ ...PROJECTS[0], live: false, config: CONFIG }, [MISSING, UNKNOWN]),
      "/projects/SAGA/tasks": listing([entry(1)], [EXCLUDED], [{ ...UNKNOWN }, BLOCKER]),
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    expect(within(screen.getByRole("note")).getByText("The index is not following the disk")).toBeTruthy();
    const line = screen.getByRole("heading", { level: 2, name: /warnings/ });
    expect(line.textContent).toBe("4 warnings about this project");
    expect(line.parentElement?.parentElement?.className).toBe("mt-3");
    expect(screen.getByRole("status").textContent).toBe("The index is not following the disk. 4 warnings about this project.");
  });

  it("says nothing while there is nothing to report", async () => {
    const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1)]) });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: /warning/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("spaces the warnings line under the heading when there is no notice", async () => {
    const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1)], [EXCLUDED]) });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    const line = screen.getByRole("heading", { level: 2, name: /warning/ });
    expect(line.textContent).toBe("1 warning about this project");
    expect(line.parentElement?.parentElement?.className).toBe("mt-4");
    expect(screen.getByRole("status").textContent).toBe("1 warning about this project.");
  });
});

describe("polling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  /** One poll interval, then the zero-delay timer the query cache notifies its observers through. */
  async function poll() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }

  it("follows the disk every 5 seconds", async () => {
    const { transport, replies } = daemon({ "/projects/SAGA/tasks": listing([entry(1), entry(2)]) });
    await renderWithRouter("/tasks?projects=SAGA", transport);
    expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2"]);

    replies["/projects/SAGA/tasks"] = listing([entry(1, { status: "Done" }), entry(2)]);
    await poll();

    expect(titlesIn("Backlog")).toEqual(["Task 2"]);
    expect(titlesIn("Done")).toEqual(["Task 1"]);
  });

  it("opens the first project that appears in an empty tree", async () => {
    const { transport, replies } = daemon({ "/projects": successReply([]) });
    const router = await renderWithRouter("/tasks", transport);
    expect(screen.getByText(/^No projects yet/)).toBeTruthy();

    replies["/projects"] = successReply(PROJECTS);
    await poll();

    await vi.waitFor(() => {
      expect(screen.getByText("No tasks in Saga yet.")).toBeTruthy();
    });
    expect(router.state.location.search).toEqual({ projects: "SAGA" });
  });

  it("asks nothing while the page is hidden", async () => {
    const { transport, paths } = daemon({ "/projects/SAGA/tasks": listing([entry(1)]) });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    const asked = paths.length;
    await poll();

    expect(paths).toHaveLength(asked);
  });

  it("shows the stale step of a workflow a poll brings until its read lands", async () => {
    let answer: (reply: TransportReply) => void = () => {};
    const late = new Promise<TransportReply>((resolve) => {
      answer = resolve;
    });
    const { transport, replies } = daemon({ "/projects/SAGA/tasks": listing([entry(1)]), "/workflows/dev": late });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    replies["/projects/SAGA/tasks"] = listing([entry(1, { workflow: "dev", step: "approve" })]);
    await poll();

    expect(screen.getByText("approve").className).toContain("text-dim");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Tasks");

    await act(async () => {
      answer(successReply(WORKFLOW));
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(screen.getByText("approve").className).toContain("text-text");
  });
});

describe("moving a task from the card menu", () => {
  const TASK_1 = "PATCH /projects/SAGA/tasks/SAGA-1";

  function card(title: string): HTMLElement {
    return screen.getByText(title).closest<HTMLElement>("[data-task-id]")!;
  }

  function menuButton(title: string): HTMLElement {
    return within(card(title)).getByRole("button", { name: "Task menu" });
  }

  /** Opens the card's menu and picks the status. */
  async function moveTo(title: string, status: string) {
    const user = userEvent.setup();
    await user.click(menuButton(title));
    const menu = await screen.findByRole("menu");
    await act(async () => {
      await user.click(within(menu).getByRole("menuitemradio", { name: status }));
    });
  }

  function noticeTitles(): string[] {
    return useNoticeStore.getState().notices.map(({ title }) => title);
  }

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("shows the card first in its new column at 55%, with the counts changed, until the listing shows the move", async () => {
    const write = heldBack();
    const { transport, requests, replies } = daemon({
      "/projects/SAGA/tasks": listing([entry(1), entry(2, { status: "To Do", order: 5 }), entry(3, { status: "To Do" })]),
      [TASK_1]: write.reply,
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    await moveTo("Task 1", "To Do");

    expect(requests.filter(({ method }) => method === "PATCH")).toEqual([
      { method: "PATCH", path: "/projects/SAGA/tasks/SAGA-1", body: { status: "To Do", order: -995 } },
    ]);
    expect(titlesIn("To Do")).toEqual(["Task 1", "Task 2", "Task 3"]);
    expect([countOf("Backlog"), countOf("To Do")]).toEqual(["0", "3"]);
    expect(card("Task 1").getAttribute("aria-busy")).toBe("true");
    expect(card("Task 1").className).toContain("opacity-55");
    expect(card("Task 2").hasAttribute("aria-busy")).toBe(false);

    replies["/projects/SAGA/tasks"] = listing([
      entry(1, { status: "To Do", order: -995 }),
      entry(2, { status: "To Do", order: 5 }),
      entry(3, { status: "To Do" }),
    ]);
    await act(async () => {
      write.answer(successReply({ id: "SAGA-1", status: "To Do" }));
    });

    await vi.waitFor(() => {
      expect(card("Task 1").hasAttribute("aria-busy")).toBe(false);
    });
    expect(card("Task 1").className).not.toContain("opacity-55");
    expect(titlesIn("To Do")).toEqual(["Task 1", "Task 2", "Task 3"]);
    expect(noticeTitles()).toEqual([]);
  });

  it("shows the card first in a final column whose other cards were updated after it", async () => {
    vi.setSystemTime(new Date("2026-09-10T08:00:00Z"));
    const write = heldBack();
    const { transport } = daemon({
      "/projects/SAGA/tasks": listing([
        entry(1, { updated: "2026-09-01T10:00:00Z" }),
        entry(4, { status: "Done", updated: "2026-09-05T10:00:00Z" }),
        entry(5, { status: "Done", updated: "2026-09-06T10:00:00Z" }),
      ]),
      [TASK_1]: write.reply,
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    await moveTo("Task 1", "Done");

    expect(titlesIn("Done")).toEqual(["Task 1", "Task 5", "Task 4"]);
    expect(card("Task 1").getAttribute("aria-busy")).toBe("true");
    write.answer(successReply({ id: "SAGA-1" }));
  });

  it("counts the tasks the label filter hides when it puts the card first", async () => {
    const { transport, requests } = daemon({
      "/projects/SAGA/tasks": listing([
        entry(1, { labels: ["web"] }),
        entry(2, { status: "To Do", labels: ["docs"], order: 100 }),
        entry(3, { status: "To Do", labels: ["web"], order: 400 }),
      ]),
      [TASK_1]: successReply({ id: "SAGA-1" }),
    });
    await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

    await moveTo("Task 1", "To Do");

    expect(requests.find(({ method }) => method === "PATCH")?.body).toEqual({ status: "To Do", order: -900 });
  });

  it("keeps the card event of a menu item inside the menu, so a pick opens no task", async () => {
    const { transport, requests } = daemon({ "/projects/SAGA/tasks": listing([entry(1)]) });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);

    await moveTo("Task 1", "Backlog");

    expect(router.state.location.pathname).toBe("/tasks");
    expect(requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });

  it("opens the task from Open task in the menu", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/SAGA/tasks/SAGA-1": successReply({ frontmatter: entry(1).frontmatter, body: "", comments: [] }),
    });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);

    fireEvent.contextMenu(card("Task 1"), { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole("menu");
    await act(async () => {
      await user.click(within(menu).getByRole("menuitem", { name: "Open task" }));
    });

    expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-1");
  });

  it("returns a refused card at once, says why, and closes the notice when a later write succeeds", async () => {
    const { transport, replies } = daemon({
      "/projects/SAGA/tasks": listing([entry(1), entry(2)]),
      [TASK_1]: refusalReply(422, {
        kind: "store",
        code: "status-unknown",
        message: "status \"To Do\" is not one of Backlog, Done",
      }),
      "PATCH /projects/SAGA/tasks/SAGA-2": successReply({ id: "SAGA-2" }),
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    await moveTo("Task 1", "To Do");

    await vi.waitFor(() => {
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2"]);
    });
    const alert = within(screen.getByRole("main").parentElement!).getByRole("alert");
    expect(within(alert).getByText("SAGA-1 was not moved")).toBeTruthy();
    expect(alert.textContent).toContain("store/status-unknown · status \"To Do\" is not one of Backlog, Done");
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(menuButton("Task 1"));
    });

    replies["/projects/SAGA/tasks"] = listing([entry(1), entry(2, { status: "Done" })]);
    await moveTo("Task 2", "Done");

    await vi.waitFor(() => {
      expect(noticeTitles()).toEqual([]);
    });
  });

  it("keeps the failure notice open on the task page", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/SAGA/tasks/SAGA-1": successReply({ frontmatter: entry(1).frontmatter, body: "", comments: [] }),
      [TASK_1]: { status: 502 },
    });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);
    await moveTo("Task 1", "Done");
    await vi.waitFor(() => {
      expect(noticeTitles()).toEqual(["SAGA-1 was not moved"]);
    });

    await user.click(screen.getByRole("link", { name: "Task 1" }));

    expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-1");
    expect(screen.getByRole("alert").textContent).toContain(`${DAEMON_URL} · HTTP 502`);
  });

  it("mounts a new alert when the same task is refused again with the same words", async () => {
    const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1)]), [TASK_1]: { status: 502 } });
    await renderWithRouter("/tasks?projects=SAGA", transport);
    await moveTo("Task 1", "Done");
    const first = await screen.findByRole("alert");
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(menuButton("Task 1"));
    });

    await moveTo("Task 1", "Done");

    await vi.waitFor(() => {
      expect(screen.getByRole("alert")).not.toBe(first);
    });
    expect(first.isConnected).toBe(false);
  });

  it("opens a warning notice for a diagnostic the board does not show, and none for one it shows", async () => {
    const shown: Diagnostic = { code: "config-key-unknown", message: "unknown key: colour", path: "/p/config.yml" };
    const fresh: Diagnostic = { code: "label-case-converted", message: "label \"Web\" was converted to \"web\"" };
    const { transport } = daemon({
      "/projects/SAGA": successReply({ ...PROJECTS[0], live: true, config: CONFIG }, [shown]),
      "/projects/SAGA/tasks": listing([entry(1), entry(2)]),
      [TASK_1]: successReply({ id: "SAGA-1" }, [shown]),
      "PATCH /projects/SAGA/tasks/SAGA-2": successReply({ id: "SAGA-2" }, [shown, fresh]),
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    await moveTo("Task 1", "To Do");
    await vi.waitFor(() => {
      expect(card("Task 1").hasAttribute("aria-busy")).toBe(false);
    });
    expect(noticeTitles()).toEqual([]);

    await moveTo("Task 2", "To Do");

    await vi.waitFor(() => {
      expect(noticeTitles()).toEqual(["1 warning about SAGA-2"]);
    });
    expect(useNoticeStore.getState().notices[0]?.words).toEqual(["label-case-converted · label \"Web\" was converted to \"web\""]);
  });

  it("keeps the card at its new place when a poll lands while the write is pending", async () => {
    const write = heldBack();
    const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1), entry(2)]), [TASK_1]: write.reply });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);

    await moveTo("Task 1", "In Progress");
    await act(async () => {
      await router.options.context.queryClient.refetchQueries({ queryKey: ["daemon", "projects", "SAGA", "tasks"] });
    });

    expect(titlesIn("In Progress")).toEqual(["Task 1"]);
    expect(titlesIn("Backlog")).toEqual(["Task 2"]);
    write.answer(successReply({ id: "SAGA-1" }));
  });

  it("moves focus to the moved card's menu button at its new place", async () => {
    const { transport } = daemon({
      "/projects/SAGA/tasks": listing([entry(1), entry(2, { status: "To Do" })]),
      [TASK_1]: heldBack().reply,
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    await moveTo("Task 1", "To Do");

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(menuButton("Task 1"));
    });
    expect(column("To Do").contains(document.activeElement)).toBe(true);
  });

  describe("into a column of more than 50 cards, scrolled away from its top", () => {
    const LIST_TOP = 400;
    const CARD_HEIGHT = 96;

    beforeEach(() => {
      vi.stubGlobal("innerHeight", 600);
      vi.stubGlobal("scrollY", 4_000);
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.tagName === "LI" ? CARD_HEIGHT : 0;
      });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () => ({ top: LIST_TOP - window.scrollY }) as DOMRect,
      );
      vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(20_000);
    });

    it("scrolls the column to the card and moves focus to its menu button", async () => {
      const scrolls: number[] = [];
      const many = Array.from({ length: 60 }, (_, index) => entry(index + 10, { status: "To Do" }));
      const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1), ...many]), [TASK_1]: heldBack().reply });
      await renderWithRouter("/tasks?projects=SAGA", transport);
      vi.stubGlobal("scrollTo", ({ top }: ScrollToOptions) => {
        scrolls.push(top ?? 0);
        vi.stubGlobal("scrollY", top);
        window.dispatchEvent(new Event("scroll"));
      });
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      expect(within(column("To Do")).queryByText("Task 10")).toBeNull();

      await moveTo("Task 1", "To Do");

      await vi.waitFor(() => {
        expect(document.activeElement).toBe(menuButton("Task 1"));
      });
      expect(scrolls.length).toBeGreaterThan(0);
      expect(column("To Do").contains(document.activeElement)).toBe(true);
    });
  });
});

describe("the notice for failed polls", () => {
  const LISTING = "/projects/SAGA/tasks";
  const UNREADABLE: TransportReply = { status: 502 };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  /** One poll interval, the retry of an unreadable answer, and the notification of the cache. */
  async function poll() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_010);
    });
  }

  it("opens after two failed polls, not after one, and closes after a successful poll", async () => {
    const { transport, replies } = daemon({ [LISTING]: listing([entry(1)]) });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);
    const readAt = router.options.context.queryClient.getQueryState(["daemon", "projects", "SAGA", "tasks"])!.dataUpdatedAt;

    replies[LISTING] = UNREADABLE;
    await poll();
    expect(useNoticeStore.getState().notices).toEqual([]);

    await poll();
    expect(useNoticeStore.getState().notices).toMatchObject([
      {
        key: "board-poll:SAGA",
        form: "failure",
        title: "The board is not up to date",
        line: `The last reads of SAGA failed. The board shows the tasks as they were at ${formatClock(readAt)}.`,
        words: [`${DAEMON_URL} · HTTP 502 · GET ${LISTING} answered with no envelope`],
      },
    ]);
    expect(titlesIn("Backlog")).toEqual(["Task 1"]);

    replies[LISTING] = listing([entry(1)]);
    await poll();
    expect(useNoticeStore.getState().notices).toEqual([]);
  });

  it("keeps the notice as it is while the project read fails and the listing polls succeed", async () => {
    const { transport, replies } = daemon({ [LISTING]: listing([entry(1)]) });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);
    const readAt = router.options.context.queryClient.getQueryState(["daemon", "projects", "SAGA"])!.dataUpdatedAt;

    replies["/projects/SAGA"] = refusalReply(422, { kind: "store", code: "config-invalid", message: "priorities is empty" });
    await poll();
    await poll();
    const [notice] = useNoticeStore.getState().notices;
    expect(notice?.words).toEqual(["store/config-invalid · priorities is empty"]);
    expect(notice?.line).toBe(`The last reads of SAGA failed. The board shows the tasks as they were at ${formatClock(readAt)}.`);

    await poll();
    expect(useNoticeStore.getState().notices).toHaveLength(1);
    expect(useNoticeStore.getState().notices[0]).toBe(notice);
  });

  it("closes when another project opens", async () => {
    const { transport, replies } = daemon({ [LISTING]: listing([entry(1)]) });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);
    replies[LISTING] = UNREADABLE;
    await poll();
    await poll();
    expect(useNoticeStore.getState().notices.map(({ key }) => key)).toEqual(["board-poll:SAGA"]);

    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "DELTA" } });
    });

    expect(useNoticeStore.getState().notices).toEqual([]);
  });
});
