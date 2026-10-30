import type { Diagnostic, ExcludedFile, FeedEvent, TransportReply } from "@tasma/protocol";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_URL } from "../../src/api/transport";
import { formatClock } from "../../src/lib/clock";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import {
  boardState,
  CONFIG,
  column,
  countOf,
  daemon,
  entry,
  filterResult,
  listing,
  project,
  PROJECTS,
  taggedEntry,
  titlesIn,
  WORKFLOW,
} from "../board-fixtures";
import {
  countReads,
  heldBack,
  openWithFeed,
  projectEvent,
  refusalReply,
  renderWithRouter,
  successReply,
  taskEvent,
  type FeedStub,
} from "../helpers";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    lastTasksProject: null,
    lastCreateProject: null,
    boardReturn: null,
    boardRestorePending: false,
    lastBoard: null,
    revealedColumns: new Set(),
  });
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
    expect(screen.getByRole("combobox", { name: "Project Saga SAGA" })).toBeTruthy();
  });

  it.each([
    { remembered: { projects: "DELTA,SAGA", labels: "web", q: "fix" }, opened: { projects: "DELTA,SAGA", labels: "web", q: "fix" } },
    { remembered: { projects: "DELTA,GONE", labels: "web" }, opened: { projects: "DELTA", labels: "web" } },
    { remembered: { projects: "GONE,NOPE", labels: "web", q: "fix" }, opened: { projects: "SAGA" } },
    { remembered: { projects: "all", q: "fix" }, opened: { projects: "all", q: "fix" } },
  ])("opens the last board of the session $remembered.projects as $opened.projects", async ({ remembered, opened }) => {
    useUiStore.setState({ lastBoard: remembered, lastTasksProject: "SAGA" });
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks", transport);

    expect(router.state.location.search).toEqual(opened);
  });

  it.each([
    { stored: "DELTA", opened: "DELTA" },
    { stored: "GONE", opened: "SAGA" },
    { stored: "DELTA,SAGA", opened: "DELTA,SAGA" },
    { stored: "all", opened: "all" },
    { stored: "DELTA,GONE", opened: "DELTA" },
    { stored: "GONE,NOPE", opened: "SAGA" },
  ])("opens the stored projects $stored as $opened with no last board", async ({ stored, opened }) => {
    useUiStore.setState({ lastTasksProject: stored });
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks", transport);

    expect(router.state.location.search).toEqual({ projects: opened });
  });

  it("keeps the labels of its own address over those of the last board", async () => {
    useUiStore.setState({ lastBoard: { projects: "DELTA,SAGA", labels: "web", q: "fix" } });
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks?labels=api", transport);

    expect(router.state.location.search).toEqual({ projects: "DELTA,SAGA", labels: "api", q: "fix" });
  });

  it("opens the last board for an address whose projects name none", async () => {
    useUiStore.setState({ lastBoard: { projects: "DELTA,SAGA", labels: "web" } });
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks?projects=,", transport);

    expect(router.state.location.search).toEqual({ projects: "DELTA,SAGA", labels: "web" });
  });

  it("keeps several projects, and the labels", async () => {
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks?projects=DELTA,SAGA&labels=web", transport);

    expect(router.state.location.search).toEqual({ projects: "DELTA,SAGA", labels: "web" });
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
    expect(screen.getByRole("combobox", { name: "Project Saga SAGA" })).toBeTruthy();
  });

  it("asks the daemon for a tag that reads as a number, and keeps the selector under its refusal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = refusalReply(404, { kind: "store", code: "project-not-found", message: "no project is tagged 2026" });
    const { transport } = daemon({ "/projects/2026": refusal, "/projects/2026/tasks": refusal });
    await renderWithRouter("/tasks?projects=2026", transport);

    expect(screen.getByRole("alert").textContent).toContain("store/project-not-found");
    expect(screen.getByRole("combobox", { name: "Project 2026" })).toBeTruthy();
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

  it("keeps the project selector under the failure panel, where an added project opens beside the refused one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    const { transport } = daemon({ "/projects/SAGA": INVALID, "/projects/SAGA/tasks": INVALID });
    const router = await renderWithRouter("/tasks", transport);

    expect(router.state.location.search).toEqual({ projects: "SAGA" });
    expect(screen.getByRole("alert").textContent).toContain("store/config-invalid");

    await user.click(screen.getByRole("combobox", { name: "Project Saga SAGA" }));
    const delta = await screen.findByRole("option", { name: "Delta DELTA" });
    await act(async () => {
      await user.click(delta);
    });

    expect(router.state.location.search).toEqual({ projects: "DELTA,SAGA" });
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(screen.getByRole("heading", { level: 2, name: "SAGA did not load" })).toBeTruthy();
    expect(screen.getByText("No tasks in these projects yet.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("opens the failure screen of the project left on the board, with the focus on the content region", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    const { transport } = daemon({ "/projects/SAGA": INVALID, "/projects/SAGA/tasks": INVALID });
    const router = await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    await user.click(screen.getByRole("combobox", { name: "Project Delta, Saga" }));
    const delta = await screen.findByRole("option", { name: "Delta DELTA" });
    await act(async () => {
      await user.click(delta);
    });

    expect(router.state.location.search).toEqual({ projects: "SAGA" });
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("store/config-invalid");
    });
    expect(screen.getByRole("combobox", { name: "Project Saga SAGA" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it.each(["/tasks", "/tasks?projects=SAGA", "/tasks?projects=all"])("shows no selector at %s when the listing of projects was refused", async (path) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport } = daemon({ "/projects": INVALID });
    await renderWithRouter(path, transport);

    expect(screen.getByRole("alert").textContent).toContain("store/config-invalid");
    expect(screen.queryByRole("combobox", { name: /^Project/ })).toBeNull();
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

    expect(within(screen.getByRole("main")).getAllByRole("region").map((region) => region.querySelector("h2")?.textContent)).toEqual(CONFIG.statuses);
    expect(CONFIG.statuses.map(countOf)).toEqual(["2", "0", "1", "1"]);
    expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 3"]);
    expect(titlesIn("In Progress")).toEqual(["Task 2"]);
  });

  it("says the project has no task, and keeps the columns", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks?projects=SAGA", transport);

    expect(screen.getByText("No tasks in Saga yet.")).toBeTruthy();
    expect(within(screen.getByRole("main")).getAllByRole("region")).toHaveLength(4);
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
    expect(filterResult()).toBe("2 of 3 tasks carry a selected label.");
  });

  it("says no task carries a label that matches nothing", async () => {
    const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1, { labels: ["web"] }), entry(2)]) });
    await renderWithRouter("/tasks?projects=SAGA&labels=docs", transport);

    expect(screen.getByText("No task in Saga carries any of the selected labels.")).toBeTruthy();
    expect(countOf("Backlog")).toBe("0 of 2");
    expect(filterResult()).toBe("0 of 2 tasks carry a selected label.");
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
      "/projects/SAGA/tasks/SAGA-2/chats": successReply([]),
    });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);

    await user.click(within(column("Backlog")).getByRole("link", { name: "SAGA-2 Task 2" }));

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

    expect(screen.getByRole("note").textContent).toBe(
      "The index of SAGA is not following the disk"
      + "The daemon could not repair the index of SAGA. What it reports about SAGA "
      + "can be older than the files on disk. The daemon tries the repair again.",
    );
    const line = screen.getByRole("heading", { level: 2, name: /warnings/ });
    expect(line.textContent).toBe("4 warnings about SAGA");
    expect(line.parentElement?.parentElement?.className).toBe("mt-3");
    expect(boardState()).toBe("The index of SAGA is not following the disk. 4 warnings about SAGA.");
  });

  it("says nothing while there is nothing to report", async () => {
    const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1)]) });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: /warning/ })).toBeNull();
    expect([boardState(), filterResult()]).toEqual(["", ""]);
  });

  it("spaces the warnings line under the heading when there is no notice", async () => {
    const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1)], [EXCLUDED]) });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    const line = screen.getByRole("heading", { level: 2, name: /warning/ });
    expect(line.textContent).toBe("1 warning about SAGA");
    expect(line.parentElement?.parentElement?.className).toBe("mt-4");
    expect(boardState()).toBe("1 warning about SAGA.");
  });
});

describe("reads nothing again without an event", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  /** The paths the board asks for in the next minute. */
  async function askedInAMinute(paths: readonly string[]): Promise<string[]> {
    const before = paths.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    return paths.slice(before);
  }

  it("on a board of one project with a search", async () => {
    const { transport, paths } = daemon({
      "/projects/SAGA/tasks": listing([entry(1), entry(2)]),
      "/projects/SAGA/tasks?q=parser": listing([entry(1)]),
    });
    await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
    await waitFor(() => {
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    });

    expect(await askedInAMinute(paths)).toEqual([]);
  });

  it("on the board of all projects with a project the daemon refuses", async () => {
    const { transport, paths } = daemon({
      "/projects/SAGA": refusalReply(422, { kind: "store", code: "config-invalid", message: "statuses is empty" }),
      "/projects/DELTA/tasks": listing([taggedEntry("DELTA", 11)]),
    });
    await renderWithRouter("/tasks?projects=all", transport);
    expect(screen.getByRole("heading", { level: 2, name: "SAGA did not load" })).toBeTruthy();
    expect(titlesIn("Backlog")).toEqual(["Task 11"]);

    expect(await askedInAMinute(paths)).toEqual([]);
  });

  it("in an empty tree", async () => {
    const { transport, paths } = daemon({ "/projects": successReply([]) });
    await renderWithRouter("/tasks", transport);
    expect(screen.getByText(/^No projects yet/)).toBeTruthy();

    expect(await askedInAMinute(paths)).toEqual([]);
  });
});

describe("changes from the feed", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  /** The events, then the zero-delay timer the query cache notifies its observers through. */
  async function sendAndSettle(feed: FeedStub, events: FeedEvent[]) {
    await feed.send(events);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }

  it("opens the first project that appears in an empty tree", async () => {
    const stub = daemon({ "/projects": successReply([]) });
    const { router, feed } = await openWithFeed("/tasks", stub);
    expect(screen.getByText(/^No projects yet/)).toBeTruthy();

    stub.replies["/projects"] = successReply(PROJECTS);
    await sendAndSettle(feed, [projectEvent("SAGA", "created")]);

    await vi.waitFor(() => {
      expect(screen.getByText("No tasks in Saga yet.")).toBeTruthy();
    });
    expect(router.state.location.search).toEqual({ projects: "SAGA" });
  });

  it("shows the stale step of a workflow a read brings until its read lands", async () => {
    let answer: (reply: TransportReply) => void = () => {};
    const late = new Promise<TransportReply>((resolve) => {
      answer = resolve;
    });
    const stub = daemon({ "/projects/SAGA/tasks": listing([entry(1)]), "/workflows/dev": late });
    const { feed } = await openWithFeed("/tasks?projects=SAGA", stub);

    stub.replies["/projects/SAGA/tasks"] = listing([entry(1, { workflow: "dev", step: "approve" })]);
    await sendAndSettle(feed, [taskEvent("SAGA-1")]);

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
    const taskCard = card(title);

    return within(taskCard).getByRole("button", { name: `Task menu ${taskCard.dataset.taskId}` });
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

  /** The panel at the bottom of the notice stack, which follows <main>. */
  function bottomNotice(): HTMLElement {
    const panel = screen.getByRole("main").nextElementSibling?.lastElementChild;
    if (!(panel instanceof HTMLElement)) {
      throw new Error("No notice is open.");
    }

    return panel;
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
      "/projects/SAGA/tasks/SAGA-1/chats": successReply([]),
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
    const panel = bottomNotice();
    expect(within(panel).getByText("SAGA-1 was not moved")).toBeTruthy();
    expect(panel.textContent).toContain("store/status-unknown · status \"To Do\" is not one of Backlog, Done");
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
      "/projects/SAGA/tasks/SAGA-1/chats": successReply([]),
      [TASK_1]: { status: 502 },
    });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);
    await moveTo("Task 1", "Done");
    await vi.waitFor(() => {
      expect(noticeTitles()).toEqual(["SAGA-1 was not moved"]);
    });

    await user.click(screen.getByRole("link", { name: "SAGA-1 Task 1" }));

    expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-1");
    expect(bottomNotice().textContent).toContain(`${DAEMON_URL} · HTTP 502`);
  });

  it("mounts a new panel when the same task is refused again with the same words", async () => {
    const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1)]), [TASK_1]: { status: 502 } });
    await renderWithRouter("/tasks?projects=SAGA", transport);
    await moveTo("Task 1", "Done");
    const first = await vi.waitFor(() => bottomNotice());
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(menuButton("Task 1"));
    });

    await moveTo("Task 1", "Done");

    await vi.waitFor(() => {
      expect(bottomNotice()).not.toBe(first);
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

  it("keeps the card at its new place when a read lands while the write is pending", async () => {
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

  describe("to a place in its column", () => {
    /** Opens the card's menu and picks Move up or Move down. */
    async function place(title: string, name: "Move up" | "Move down") {
      const user = userEvent.setup();
      await user.click(menuButton(title));
      const menu = await screen.findByRole("menu");
      await act(async () => {
        await user.click(within(menu).getByRole("menuitem", { name }));
      });
    }

    function patches(requests: { method: string; path: string; body?: unknown }[]) {
      return requests.filter(({ method }) => method === "PATCH").map(({ path, body }) => [path, body]);
    }

    it("writes the card above first and the moved card last, and shows the board the daemon holds after a refusal", async () => {
      const above = heldBack();
      const refetch = heldBack();
      const { transport, requests, replies } = daemon({
        "/projects/SAGA/tasks": listing([entry(1), entry(2), entry(3)]),
        "PATCH /projects/SAGA/tasks/SAGA-2": above.reply,
        [TASK_1]: refusalReply(404, { kind: "store", code: "task-not-found", message: "no task is SAGA-1" }),
      });
      await renderWithRouter("/tasks?projects=SAGA", transport);

      await place("Task 1", "Move down");

      expect(patches(requests)).toEqual([["/projects/SAGA/tasks/SAGA-2", { order: 0 }]]);
      expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 1", "Task 3"]);
      expect(["Task 1", "Task 2", "Task 3"].map((title) => card(title).hasAttribute("aria-busy"))).toEqual([true, true, false]);

      replies["/projects/SAGA/tasks"] = refetch.reply;
      await act(async () => {
        above.answer(successReply({ id: "SAGA-2" }));
      });

      await vi.waitFor(() => {
        expect(noticeTitles()).toEqual(["SAGA-1 was not moved"]);
      });
      expect(patches(requests)).toEqual([
        ["/projects/SAGA/tasks/SAGA-2", { order: 0 }],
        ["/projects/SAGA/tasks/SAGA-1", { order: 1000 }],
      ]);
      expect(useNoticeStore.getState().notices[0]?.line).toBe(
        "The daemon refused a write, and the move did not complete. The board shows what the daemon holds. "
        + "Its own words are below.",
      );
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2", "Task 3"]);

      await act(async () => {
        refetch.answer(listing([entry(1), entry(2, { order: 0 }), entry(3)]));
      });

      await vi.waitFor(() => {
        expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 1", "Task 3"]);
      });
      expect(card("Task 2").hasAttribute("aria-busy")).toBe(false);
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(menuButton("Task 1"));
      });
    });

    it("names the moved card in the failure notice when the move writes only the card below it", async () => {
      const { transport, requests } = daemon({
        "/projects/SAGA/tasks": listing([entry(1, { order: 1000 }), entry(2), entry(3)]),
        "PATCH /projects/SAGA/tasks/SAGA-2": refusalReply(404, { kind: "store", code: "task-not-found", message: "no task is SAGA-2" }),
      });
      await renderWithRouter("/tasks?projects=SAGA", transport);

      await place("Task 1", "Move down");

      await vi.waitFor(() => {
        expect(useNoticeStore.getState().notices.map(({ key, title }) => [key, title])).toEqual([
          ["task-write-failure:SAGA-1", "SAGA-1 was not moved"],
        ]);
      });
      expect(patches(requests)).toEqual([["/projects/SAGA/tasks/SAGA-2", { order: 0 }]]);
    });

    it("counts the cards the label filter hides", async () => {
      const { transport, requests } = daemon({
        "/projects/SAGA/tasks": listing([
          entry(1, { labels: ["web"], order: 100 }),
          entry(2, { labels: ["docs"], order: 200 }),
          entry(3, { labels: ["web"], order: 300 }),
        ]),
        "PATCH /projects/SAGA/tasks/SAGA-3": heldBack().reply,
      });
      await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

      await place("Task 3", "Move up");

      expect(patches(requests)).toEqual([["/projects/SAGA/tasks/SAGA-3", { order: -900 }]]);
      expect(titlesIn("Backlog")).toEqual(["Task 3", "Task 1"]);
    });

    it("puts a card below the last visible card, above the hidden cards after it", async () => {
      const { transport, requests } = daemon({
        "/projects/SAGA/tasks": listing([
          entry(1, { labels: ["web"], order: 100 }),
          entry(2, { labels: ["web"], order: 200 }),
          entry(3, { labels: ["docs"], order: 201 }),
        ]),
        "PATCH /projects/SAGA/tasks/SAGA-3": successReply({ id: "SAGA-3" }),
        [TASK_1]: heldBack().reply,
      });
      await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

      await place("Task 1", "Move down");

      await vi.waitFor(() => {
        expect(patches(requests)).toEqual([
          ["/projects/SAGA/tasks/SAGA-3", { order: 2200 }],
          ["/projects/SAGA/tasks/SAGA-1", { order: 1200 }],
        ]);
      });
      expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 1"]);
    });

    it("keeps focus on the moved card's menu button after Move up", async () => {
      const { transport } = daemon({
        "/projects/SAGA/tasks": listing([entry(1), entry(2)]),
        "PATCH /projects/SAGA/tasks/SAGA-2": heldBack().reply,
      });
      await renderWithRouter("/tasks?projects=SAGA", transport);

      await place("Task 2", "Move up");

      expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 1"]);
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(menuButton("Task 2"));
      });
    });

    it("opens Show all when Move down puts the 20th card of a folded final column under the cap, and focuses the card", async () => {
      const done = Array.from({ length: 25 }, (_, index) => entry(index + 1, { status: "Done", order: (index + 1) * 1000 }));
      const { transport, requests } = daemon({
        "/projects/SAGA/tasks": listing(done),
        "PATCH /projects/SAGA/tasks/SAGA-20": heldBack().reply,
      });
      await renderWithRouter("/tasks?projects=SAGA", transport);
      expect(titlesIn("Done")).toHaveLength(20);

      await place("Task 20", "Move down");

      expect(patches(requests)).toEqual([["/projects/SAGA/tasks/SAGA-20", { order: 21_500 }]]);
      expect(titlesIn("Done").slice(18, 22)).toEqual(["Task 19", "Task 21", "Task 20", "Task 22"]);
      expect(within(column("Done")).queryByRole("button", { name: "Show all" })).toBeNull();
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(menuButton("Task 20"));
      });
    });
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

describe("the notice for a refused read", () => {
  const LISTING = "/projects/SAGA/tasks";
  const UNREADABLE: TransportReply = { status: 502 };
  const INVALID = refusalReply(422, { kind: "store", code: "config-invalid", message: "priorities is empty" });
  const HOUR = 3_600_000;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  /** The events, the retry of an unreadable answer, and the notification of the cache. */
  async function sendAndWaitPastRetry(feed: FeedStub, events: FeedEvent[]) {
    await feed.send(events);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_010);
    });
  }

  function announced(): string[] {
    return useNoticeStore.getState().announced.map(({ words }) => words);
  }

  it("opens on one refused read of the listing, with the time of the refusal, and closes with a spoken line after a successful read", async () => {
    const stub = daemon({ [LISTING]: listing([entry(1)]) });
    const { router, feed } = await openWithFeed("/tasks?projects=SAGA", stub);
    const { queryClient } = router.options.context;
    const loadedAt = queryClient.getQueryState(["daemon", "projects", "SAGA", "tasks"])!.dataUpdatedAt;
    vi.setSystemTime(loadedAt + HOUR);

    stub.replies[LISTING] = INVALID;
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);
    const refusedAt = queryClient.getQueryState(["daemon", "projects", "SAGA", "tasks"])!.errorUpdatedAt;
    expect(formatClock(refusedAt)).not.toBe(formatClock(loadedAt));
    expect(useNoticeStore.getState().notices).toMatchObject([
      {
        key: "board-refusal:SAGA",
        form: "failure",
        title: "The board is not up to date",
        line: `The daemon refused a read of SAGA. The board shows the tasks as they were before ${formatClock(refusedAt)}.`,
        words: ["store/config-invalid · priorities is empty"],
      },
    ]);
    expect(titlesIn("Backlog")).toEqual(["Task 1"]);

    stub.replies[LISTING] = listing([entry(1)]);
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);
    expect(useNoticeStore.getState().notices).toEqual([]);
    expect(announced()).toContain("The board is up to date.");
    expect(titlesIn("Backlog")).toEqual(["Task 1"]);
  });

  it("opens no notice when the reads of the listing get no envelope", async () => {
    const stub = daemon({ [LISTING]: listing([entry(1)]) });
    const { feed } = await openWithFeed("/tasks?projects=SAGA", stub);

    stub.replies[LISTING] = UNREADABLE;
    const reads = countReads(stub, LISTING);
    await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1")]);
    expect(reads()).toBeGreaterThan(0);
    await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1")]);
    expect(reads()).toBeGreaterThan(0);

    expect(useNoticeStore.getState().notices).toEqual([]);
    expect(titlesIn("Backlog")).toEqual(["Task 1"]);
  });

  it("opens on one refused read of the project, and keeps the notice as it is while the listing reads succeed", async () => {
    const stub = daemon({ [LISTING]: listing([entry(1)]) });
    const { router, feed } = await openWithFeed("/tasks?projects=SAGA", stub);

    stub.replies["/projects/SAGA"] = INVALID;
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);
    const refusedAt = router.options.context.queryClient.getQueryState(["daemon", "projects", "SAGA"])!.errorUpdatedAt;
    const [notice] = useNoticeStore.getState().notices;
    expect(notice?.words).toEqual(["store/config-invalid · priorities is empty"]);
    expect(notice?.line).toBe(`The daemon refused a read of SAGA. The board shows the tasks as they were before ${formatClock(refusedAt)}.`);

    const reads = countReads(stub, LISTING);
    await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1")]);
    expect(reads()).toBeGreaterThan(0);
    expect(useNoticeStore.getState().notices).toHaveLength(1);
    expect(useNoticeStore.getState().notices[0]).toBe(notice);
    expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("closes when another project opens", async () => {
    const stub = daemon({ [LISTING]: listing([entry(1)]) });
    const { router, feed } = await openWithFeed("/tasks?projects=SAGA", stub);
    stub.replies[LISTING] = INVALID;
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);
    expect(useNoticeStore.getState().notices.map(({ key }) => key)).toEqual(["board-refusal:SAGA"]);

    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "DELTA" } });
    });

    expect(useNoticeStore.getState().notices).toEqual([]);
  });
});

describe("the board a card was opened from", () => {
  const SCROLL_X = 40;
  const SCROLL_Y = 1200;

  const ENTRIES = [entry(1, { labels: ["web"] }), entry(2, { labels: ["web"] }), entry(3, { labels: ["infra"] })];

  const PARSER = "/projects/SAGA/tasks?q=parser";

  function boardDaemon() {
    return daemon({
      "/projects/SAGA/tasks": listing(ENTRIES),
      [PARSER]: listing([ENTRIES[1]!, ENTRIES[2]!]),
      "/projects/SAGA/tasks/SAGA-2": successReply({ frontmatter: ENTRIES[1]!.frontmatter, body: "", comments: [] }),
      "/projects/SAGA/tasks/SAGA-2/chats": successReply([]),
    });
  }

  /** Puts the page where the reader scrolled it, and records every scroll asked for from there on. */
  function watchScroll() {
    const scrollTo = vi.fn<(...args: unknown[]) => void>();

    vi.stubGlobal("scrollTo", scrollTo);
    vi.stubGlobal("scrollX", SCROLL_X);
    vi.stubGlobal("scrollY", SCROLL_Y);

    return scrollTo;
  }

  /** Where the board put the page back, or null: only its restore scrolls by a pair of coordinates. */
  function restoredTo(scrollTo: ReturnType<typeof watchScroll>): unknown[] | null {
    return scrollTo.mock.calls.filter((call) => call.length === 2).at(-1) ?? null;
  }

  function card(title: string): HTMLElement {
    return screen.getByText(title).closest<HTMLElement>("[data-task-id]")!;
  }

  function cardLink(title: string): HTMLElement {
    return within(card(title)).getByRole("link");
  }

  function backLink(): HTMLElement {
    return within(screen.getByRole("main")).getByRole("link", { name: "Tasks" });
  }

  /** The restore moves focus a frame after the shell has moved it to the content region. */
  async function nextFrame(): Promise<void> {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  }

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("comes back filtered, scrolled where it was, with the card that was opened in focus", async () => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

    await user.click(cardLink("Task 2"));
    expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-2");

    await user.click(backLink());

    expect(router.state.location.search).toEqual({ projects: "SAGA", labels: "web" });
    // The router resets the page to the top first, so the restore has to be the last word.
    expect(scrollTo.mock.lastCall).toEqual([SCROLL_X, SCROLL_Y]);

    await nextFrame();
    expect(document.activeElement).toBe(cardLink("Task 2"));
    expect(useUiStore.getState().boardRestorePending).toBe(false);
  });

  it("still leads back to the filtered board after the restore has run", async () => {
    const user = userEvent.setup();
    watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

    await user.click(cardLink("Task 2"));
    await user.click(backLink());
    await nextFrame();

    act(() => {
      router.history.back();
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-2");
    });
    await user.click(backLink());

    expect(router.state.location.search).toEqual({ projects: "SAGA", labels: "web" });
  });

  it("is recorded by Open task in the card menu too", async () => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

    await user.click(within(card("Task 2")).getByRole("button", { name: "Task menu SAGA-2" }));
    await act(async () => {
      await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Open task" }));
    });
    await user.click(backLink());

    expect(router.state.location.search).toEqual({ projects: "SAGA", labels: "web" });
    expect(restoredTo(scrollTo)).toEqual([SCROLL_X, SCROLL_Y]);
    await nextFrame();
    expect(document.activeElement).toBe(cardLink("Task 2"));
  });

  it("comes back the same way after the browser Back button", async () => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

    await user.click(cardLink("Task 2"));
    act(() => {
      router.history.back();
    });

    await waitFor(() => {
      expect(restoredTo(scrollTo)).toEqual([SCROLL_X, SCROLL_Y]);
    });
    await nextFrame();
    expect(document.activeElement).toBe(cardLink("Task 2"));
  });

  it("opens at the top on the visit after the restore", async () => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

    await user.click(cardLink("Task 2"));
    await user.click(backLink());
    await nextFrame();
    scrollTo.mockClear();

    await act(async () => {
      await router.navigate({ to: "/tasks/$project/$task", params: { project: "SAGA", task: "SAGA-2" } });
    });
    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "SAGA", labels: "web" } });
    });
    await nextFrame();

    expect(restoredTo(scrollTo)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("restores nothing, and is spent, when another project's board opens", async () => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

    await user.click(cardLink("Task 2"));
    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "DELTA" } });
    });
    await nextFrame();

    expect(restoredTo(scrollTo)).toBeNull();
    expect(useUiStore.getState().boardRestorePending).toBe(false);
  });

  it("restores nothing, and is spent, when the board opens with another label filter", async () => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

    await user.click(cardLink("Task 2"));
    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "SAGA" } });
    });
    await nextFrame();

    expect(restoredTo(scrollTo)).toBeNull();
    expect(useUiStore.getState().boardRestorePending).toBe(false);
  });

  it("comes back filtered, scrolled and focused through the Dashboard and the sidebar Tasks link", async () => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);
    const sidebar = within(screen.getByRole("navigation"));

    await user.click(cardLink("Task 2"));
    await user.click(sidebar.getByRole("link", { name: "Dashboard" }));
    expect(router.state.location.pathname).toBe("/");
    await user.click(sidebar.getByRole("link", { name: "Tasks" }));

    expect(router.state.location.search).toEqual({ projects: "SAGA", labels: "web" });
    expect(restoredTo(scrollTo)).toEqual([SCROLL_X, SCROLL_Y]);
    await nextFrame();
    expect(document.activeElement).toBe(cardLink("Task 2"));
  });

  it("scrolls back but leaves focus on the content region when the recorded card is gone", async () => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

    await user.click(cardLink("Task 2"));
    useUiStore.setState({ boardReturn: { ...useUiStore.getState().boardReturn!, taskId: "SAGA-9" } });
    await user.click(backLink());
    await nextFrame();

    expect(restoredTo(scrollTo)).toEqual([SCROLL_X, SCROLL_Y]);
    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(useUiStore.getState().boardRestorePending).toBe(false);
  });

  it("leads a task page opened not from a card back to the labels the board shows now", async () => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

    await user.click(cardLink("Task 2"));
    await user.click(backLink());
    await nextFrame();
    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "SAGA", labels: "infra" } });
    });
    await act(async () => {
      await router.navigate({ to: "/tasks/$project/$task", params: { project: "SAGA", task: "SAGA-2" } });
    });
    scrollTo.mockClear();
    await user.click(backLink());
    await nextFrame();

    expect(router.state.location.search).toEqual({ projects: "SAGA", labels: "infra" });
    expect(restoredTo(scrollTo)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("leads a task page back to its own project when the last board shown is another project's", async () => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=DELTA", transport);

    await act(async () => {
      await router.navigate({ to: "/tasks/$project/$task", params: { project: "SAGA", task: "SAGA-2" } });
    });
    await user.click(backLink());
    await nextFrame();

    expect(router.state.location.search).toEqual({ projects: "SAGA" });
    expect(restoredTo(scrollTo)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  describe("with a search", () => {
    /** Opens Task 2 from the board of `parser`, and drops the search result the cache holds. */
    async function openWithNoCachedResult() {
      const user = userEvent.setup();
      const scrollTo = watchScroll();
      // As in a browser, every scroll fires a scroll event: the router's reset too.
      scrollTo.mockImplementation(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      const { transport, replies } = boardDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await waitFor(() => {
        expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 3"]);
      });

      await user.click(cardLink("Task 2"));
      router.options.context.queryClient.removeQueries({ queryKey: ["daemon", "projects", "SAGA", "tasks", "search"] });
      const held = heldBack();
      replies[PARSER] = held.reply;
      scrollTo.mockClear();

      return { user, scrollTo, router, held };
    }

    it("comes back with the search, scrolled where it was, with the card that was opened in focus", async () => {
      const user = userEvent.setup();
      const scrollTo = watchScroll();
      const { transport } = boardDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await waitFor(() => {
        expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 3"]);
      });

      await user.click(cardLink("Task 2"));
      expect(useUiStore.getState().boardReturn?.q).toBe("parser");
      await user.click(backLink());

      expect(router.state.location.search).toEqual({ projects: "SAGA", q: "parser" });
      expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 3"]);
      expect(scrollTo.mock.lastCall).toEqual([SCROLL_X, SCROLL_Y]);
      await nextFrame();
      expect(document.activeElement).toBe(cardLink("Task 2"));
    });

    it("restores nothing, and is spent, when the board opens with another search", async () => {
      const user = userEvent.setup();
      const scrollTo = watchScroll();
      const { transport } = boardDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await waitFor(() => {
        expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 3"]);
      });

      await user.click(cardLink("Task 2"));
      await act(async () => {
        await router.navigate({ to: "/tasks", search: { projects: "SAGA", q: "docs" } });
      });
      await nextFrame();

      expect(restoredTo(scrollTo)).toBeNull();
      expect(useUiStore.getState().boardRestorePending).toBe(false);
    });

    it("waits for the result the cache no longer holds, then scrolls back and focuses the card", async () => {
      const { user, scrollTo, router, held } = await openWithNoCachedResult();

      await user.click(backLink());
      await nextFrame();

      expect(router.state.location.search).toEqual({ projects: "SAGA", q: "parser" });
      expect(restoredTo(scrollTo)).toBeNull();
      expect(useUiStore.getState().boardRestorePending).toBe(true);

      await act(async () => {
        held.answer(listing([ENTRIES[1]!, ENTRIES[2]!]));
      });
      await waitFor(() => {
        expect(restoredTo(scrollTo)).toEqual([SCROLL_X, SCROLL_Y]);
      });
      await nextFrame();
      expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 3"]);
      expect(document.activeElement).toBe(cardLink("Task 2"));
      expect(useUiStore.getState().boardRestorePending).toBe(false);
    });

    it("focuses a card of a virtualized column once the page scroll has reached it", async () => {
      const LIST_TOP = 200;
      const CARD_HEIGHT = 60;
      const FAR_Y = 4700;
      const many = Array.from({ length: 80 }, (_, index) => entry(index + 1));
      const user = userEvent.setup();
      const scrollTo = vi.fn((...args: unknown[]) => {
        const top = args.length === 2 ? args[1] : (args[0] as ScrollToOptions).top;
        vi.stubGlobal("scrollY", top ?? window.scrollY);
        // As in a browser, the scroll event of a scroll fires in the next frame, before its frame callbacks.
        requestAnimationFrame(() => {
          window.dispatchEvent(new Event("scroll"));
        });
      });
      vi.stubGlobal("scrollTo", scrollTo);
      vi.stubGlobal("scrollX", SCROLL_X);
      vi.stubGlobal("scrollY", 0);
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.tagName === "LI" ? CARD_HEIGHT : 0;
      });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () => ({ top: LIST_TOP - window.scrollY }) as DOMRect,
      );
      const { transport, replies } = daemon({
        "/projects/SAGA/tasks": listing(many),
        [PARSER]: listing(many),
        "/projects/SAGA/tasks/SAGA-50": successReply({ frontmatter: many[49]!.frontmatter, body: "", comments: [] }),
        "/projects/SAGA/tasks/SAGA-50/chats": successReply([]),
      });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await waitFor(() => {
        expect(screen.getByText("Task 1")).toBeTruthy();
      });
      act(() => {
        vi.stubGlobal("scrollY", FAR_Y);
        window.dispatchEvent(new Event("scroll"));
      });

      await user.click(cardLink("Task 50"));
      router.options.context.queryClient.removeQueries({ queryKey: ["daemon", "projects", "SAGA", "tasks", "search"] });
      const held = heldBack();
      replies[PARSER] = held.reply;
      await user.click(backLink());
      await nextFrame();
      expect(screen.queryByText("Task 50")).toBeNull();

      await act(async () => {
        held.answer(listing(many));
      });
      await waitFor(() => {
        expect(restoredTo(scrollTo)).toEqual([SCROLL_X, FAR_Y]);
      });
      await waitFor(() => {
        expect(useUiStore.getState().boardRestorePending).toBe(false);
      });
      await nextFrame();
      expect(document.activeElement).toBe(cardLink("Task 50"));
    });

    it("drops the waiting restore when the board leaves before the result", async () => {
      const { user, scrollTo, router, held } = await openWithNoCachedResult();

      await user.click(backLink());
      await nextFrame();
      expect(useUiStore.getState().boardRestorePending).toBe(true);

      await act(async () => {
        await router.navigate({ to: "/tasks/$project/$task", params: { project: "SAGA", task: "SAGA-2" } });
      });
      expect(useUiStore.getState().boardRestorePending).toBe(false);

      await act(async () => {
        held.answer(listing([ENTRIES[1]!, ENTRIES[2]!]));
      });
      await act(async () => {
        await router.navigate({ to: "/tasks", search: { projects: "SAGA", q: "parser" } });
      });
      await nextFrame();
      expect(restoredTo(scrollTo)).toBeNull();
    });

    it("restores the next card opened after the address leaves the waiting restore with no input", async () => {
      const { user, scrollTo, router, held } = await openWithNoCachedResult();

      await user.click(backLink());
      await nextFrame();
      await act(async () => {
        await router.navigate({ to: "/tasks", search: { projects: "SAGA", labels: "web", q: "parser" } });
      });
      expect(useUiStore.getState().boardRestorePending).toBe(false);

      await user.click(cardLink("Task 2"));
      await act(async () => {
        held.answer(listing([ENTRIES[1]!, ENTRIES[2]!]));
      });
      await user.click(backLink());

      await waitFor(() => {
        expect(restoredTo(scrollTo)).toEqual([SCROLL_X, SCROLL_Y]);
      });
      await nextFrame();
      expect(document.activeElement).toBe(cardLink("Task 2"));
    });

    it("restores the card a click alone opens while the restore waits", async () => {
      const { user, scrollTo, router, held } = await openWithNoCachedResult();

      await user.click(backLink());
      await nextFrame();
      act(() => {
        fireEvent.click(cardLink("Task 2"));
      });
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-2");
      });
      expect(useUiStore.getState().boardRestorePending).toBe(true);

      await act(async () => {
        held.answer(listing([ENTRIES[1]!, ENTRIES[2]!]));
      });
      await user.click(backLink());

      await waitFor(() => {
        expect(restoredTo(scrollTo)).toEqual([SCROLL_X, SCROLL_Y]);
      });
      await nextFrame();
      expect(document.activeElement).toBe(cardLink("Task 2"));
    });

    it("restores once the search fails, and shows every card", async () => {
      const { user, scrollTo, held } = await openWithNoCachedResult();

      await user.click(backLink());
      await act(async () => {
        held.answer(refusalReply(422, { kind: "store", code: "project-invalid", message: "config.yml is broken" }));
      });

      await waitFor(() => {
        expect(restoredTo(scrollTo)).toEqual([SCROLL_X, SCROLL_Y]);
      });
      await nextFrame();
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2", "Task 3"]);
      expect(document.activeElement).toBe(cardLink("Task 2"));
    });

    it.each([
      { what: "a key press", send: () => fireEvent.keyDown(document.body, { key: "j" }) },
      { what: "a pointer press", send: () => fireEvent.pointerDown(document.body) },
      { what: "a wheel turn", send: () => fireEvent.wheel(document.body) },
    ])("drops the waiting restore on $what", async ({ send }) => {
      const { user, scrollTo, held } = await openWithNoCachedResult();

      await user.click(backLink());
      await nextFrame();
      send();
      await act(async () => {
        held.answer(listing([ENTRIES[1]!, ENTRIES[2]!]));
      });
      await waitFor(() => {
        expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 3"]);
      });
      await nextFrame();

      expect(restoredTo(scrollTo)).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("main"));
      expect(useUiStore.getState().boardRestorePending).toBe(false);
    });
  });
});

describe("creating a task", () => {
  const CREATE = "POST /projects/SAGA/tasks";

  function announced(): string[] {
    return useNoticeStore.getState().announced.map(({ words }) => words);
  }

  function newTask(): HTMLElement {
    return screen.getByRole("button", { name: "New task" });
  }

  function dialog(): HTMLElement {
    return screen.getByRole("dialog", { name: "New task" });
  }

  function titleLink(name: string): HTMLElement {
    return screen.getByRole("link", { name });
  }

  /** Opens the dialog from the control, types the title and presses Create. */
  async function create(user: ReturnType<typeof userEvent.setup>, opener: HTMLElement, title: string) {
    await user.click(opener);
    const input = await screen.findByRole("textbox", { name: "Title" });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    await user.keyboard(title);
    await user.click(within(dialog()).getByRole("button", { name: "Create" }));
  }

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("offers New task after the Labels control, which opens the dialog on the project's default status", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({
      "/projects/SAGA": project("SAGA", { config: { ...CONFIG, default_status: "To Do" } }),
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    const labels = screen.getByRole("combobox", { name: "Labels Any" }).parentElement!;
    expect(labels.nextElementSibling).toBe(newTask());
    expect(newTask().className).toContain("ml-1");
    expect(newTask().querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(newTask().hasAttribute("aria-label")).toBe(false);

    await user.click(newTask());

    expect(within(dialog()).getByRole("button", { name: "Status To Do" })).toBeTruthy();
  });

  it("offers a plus in every column, final columns included, which opens the dialog on that column's status", async () => {
    const user = userEvent.setup();
    const { transport } = daemon();
    await renderWithRouter("/tasks?projects=SAGA", transport);

    for (const status of CONFIG.statuses) {
      expect(within(column(status)).getByRole("button", { name: `New task in ${status}` })).toBeTruthy();
    }

    await user.click(within(column("Done")).getByRole("button", { name: "New task in Done" }));

    expect(within(dialog()).getByRole("button", { name: "Status Done" })).toBeTruthy();
  });

  it("closes on success, shows the card in its column, focuses its title link and says it was created", async () => {
    const user = userEvent.setup();
    const { transport, replies, requests } = daemon({
      "/projects/SAGA/tasks": listing([entry(1)]),
      [CREATE]: successReply({ id: "SAGA-7", status: "To Do" }),
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);
    replies["/projects/SAGA/tasks"] = listing([entry(1), entry(7, { status: "To Do" })]);

    await create(user, within(column("To Do")).getByRole("button", { name: "New task in To Do" }), "Task 7");

    await waitFor(() => {
      expect(document.activeElement).toBe(titleLink("SAGA-7 Task 7"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(titlesIn("To Do")).toEqual(["Task 7"]);
    expect(requests.filter(({ method }) => method === "POST")).toEqual([
      { method: "POST", path: "/projects/SAGA/tasks", body: { title: "Task 7", status: "To Do" } },
    ]);
    await waitFor(() => {
      expect(announced()).toEqual(["Creating…", "SAGA-7 was created."]);
    });
  });

  it("shows no Project field, and remembers the project of the create", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({ [CREATE]: successReply({ id: "SAGA-7", status: "Backlog" }) });
    await renderWithRouter("/tasks?projects=SAGA", transport);
    await user.click(newTask());

    expect(within(dialog()).queryByRole("button", { name: /^Project/ })).toBeNull();

    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await create(user, newTask(), "Task 7");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(useUiStore.getState().lastCreateProject).toBe("SAGA");
    expect(window.localStorage.getItem("tasma.tasks.createProject")).toBe("SAGA");
  });

  it("opens the warning notice of new diagnostics after the dialog has closed, and says it after the created line", async () => {
    const user = userEvent.setup();
    const shown: Diagnostic = { code: "config-key-unknown", message: "unknown key: colour", path: "/p/config.yml" };
    const fresh: Diagnostic = { code: "label-case-converted", message: "label \"Web\" was converted to \"web\"" };
    const { transport, replies } = daemon({
      "/projects/SAGA": successReply({ ...PROJECTS[0], live: true, config: CONFIG }, [shown]),
      [CREATE]: successReply({ id: "SAGA-7", status: "Backlog" }, [shown, fresh]),
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);
    replies["/projects/SAGA/tasks"] = listing([entry(7)]);
    const dialogOpenAtNotice: boolean[] = [];
    const stop = useNoticeStore.subscribe((state, previous) => {
      if (state.notices.length > previous.notices.length) {
        dialogOpenAtNotice.push(screen.queryByRole("dialog") !== null);
      }
    });

    await create(user, newTask(), "Task 7");

    await waitFor(() => {
      expect(useNoticeStore.getState().notices.map(({ title }) => title)).toEqual(["1 warning about SAGA-7"]);
    });
    stop();
    expect(dialogOpenAtNotice).toEqual([false]);
    expect(useNoticeStore.getState().notices[0]?.words).toEqual(["label-case-converted · label \"Web\" was converted to \"web\""]);
    await waitFor(() => {
      expect(announced().slice(1)).toEqual([
        "SAGA-7 was created.",
        "1 warning about SAGA-7. label-case-converted · label \"Web\" was converted to \"web\".",
      ]);
    });
  });

  it("focuses the heading of the column when the label filter hides the new card, and says so", async () => {
    const user = userEvent.setup();
    const { transport, replies } = daemon({
      "/projects/SAGA/tasks": listing([entry(1, { labels: ["web"] })]),
      [CREATE]: successReply({ id: "SAGA-7", status: "In Progress" }),
    });
    await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);
    replies["/projects/SAGA/tasks"] = listing([entry(1, { labels: ["web"] }), entry(7, { status: "in progress" })]);

    await create(user, within(column("In Progress")).getByRole("button", { name: "New task in In Progress" }), "Task 7");

    await waitFor(() => {
      expect(document.activeElement).toBe(within(column("In Progress")).getByRole("heading", { level: 2 }));
    });
    expect(countOf("In Progress")).toBe("0 of 1");
    await waitFor(() => {
      expect(announced()).toContain("SAGA-7 was created. The label filter hides it.");
    });
  });

  it("focuses the heading of the receipt's column when the listing does not hold the new task", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({ [CREATE]: successReply({ id: "SAGA-7", status: "done" }) });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    await create(user, newTask(), "Task 7");

    await waitFor(() => {
      expect(document.activeElement).toBe(within(column("Done")).getByRole("heading", { level: 2 }));
    });
    await waitFor(() => {
      expect(announced()).toContain("SAGA-7 was created.");
    });
  });

  it("opens the cap of a final column when the new card lands past its 20th card", async () => {
    const user = userEvent.setup();
    const done = Array.from({ length: 25 }, (_, index) => entry(index + 1, { status: "Done", order: (index + 1) * 1000 }));
    const { transport, replies } = daemon({
      "/projects/SAGA/tasks": listing(done),
      [CREATE]: successReply({ id: "SAGA-30", status: "Done" }),
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);
    expect(titlesIn("Done")).toHaveLength(20);
    replies["/projects/SAGA/tasks"] = listing([...done, entry(30, { status: "Done", order: 30_000 })]);

    await create(user, within(column("Done")).getByRole("button", { name: "New task in Done" }), "Task 30");

    await waitFor(() => {
      expect(document.activeElement).toBe(titleLink("SAGA-30 Task 30"));
    });
    expect(titlesIn("Done")).toHaveLength(26);
    expect(within(column("Done")).queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("returns focus to New task when the dialog is cancelled", async () => {
    const user = userEvent.setup();
    const { transport } = daemon();
    await renderWithRouter("/tasks?projects=SAGA", transport);
    await user.click(newTask());
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(newTask());
    });
  });
});

describe("deleting a task", () => {
  const DELETE_2 = "DELETE /projects/SAGA/tasks/SAGA-2";

  function card(title: string): HTMLElement {
    return screen.getByText(title).closest<HTMLElement>("[data-task-id]")!;
  }

  function menuButton(title: string): HTMLElement {
    const taskCard = card(title);

    return within(taskCard).getByRole("button", { name: `Task menu ${taskCard.dataset.taskId}` });
  }

  function announced(): string[] {
    return useNoticeStore.getState().announced.map(({ words }) => words);
  }

  function deletes(requests: readonly { method: string }[]): number {
    return requests.filter(({ method }) => method === "DELETE").length;
  }

  /** Opens the card's menu and chooses Delete, which opens the dialog. */
  async function askDelete(user: ReturnType<typeof userEvent.setup>, title: string): Promise<HTMLElement> {
    await user.click(menuButton(title));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Delete / }));

    return screen.findByRole("alertdialog");
  }

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("asks with the id in the title and the task's title in the sentence, starting on Cancel", async () => {
    const user = userEvent.setup();
    const { transport, requests } = daemon({
      "/projects/SAGA/tasks": listing([entry(1), entry(2, { title: "Say \"hello\"" })]),
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    const dialog = await askDelete(user, "Say \"hello\"");

    expect(within(dialog).getByRole("heading", { name: "Delete SAGA-2?" })).toBeTruthy();
    expect(dialog.textContent).toContain("“Say \"hello\"” will be removed from disk. There is no undo.");
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    });
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(deletes(requests)).toBe(0);
  });

  it("closes at once on Delete, hides the card, drops the count and focuses the next card's menu button", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport, requests, replies } = daemon({
      "/projects/SAGA/tasks": listing([entry(1), entry(2), entry(3)]),
      [DELETE_2]: write.reply,
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    const dialog = await askDelete(user, "Task 2");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => {
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 3"]);
    });
    expect(countOf("Backlog")).toBe("2");
    await waitFor(() => {
      expect(document.activeElement).toBe(menuButton("Task 3"));
    });
    expect(deletes(requests)).toBe(1);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(announced()).not.toContain("SAGA-2 was deleted.");

    replies["/projects/SAGA/tasks"] = listing([entry(1), entry(3)]);
    await act(async () => {
      write.answer(successReply({ id: "SAGA-2" }));
    });

    await waitFor(() => {
      expect(announced()).toContain("SAGA-2 was deleted.");
    });
    expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 3"]);
    expect(useNoticeStore.getState().notices).toEqual([]);
    expect(document.activeElement).toBe(menuButton("Task 3"));
  });

  it("focuses the next card the label filter shows, past a card it hides", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({
      "/projects/SAGA/tasks": listing([
        entry(1, { labels: ["web"] }),
        entry(2, { labels: ["docs"] }),
        entry(3, { labels: ["web"] }),
      ]),
      "DELETE /projects/SAGA/tasks/SAGA-1": heldBack().reply,
    });
    await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

    const dialog = await askDelete(user, "Task 1");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(menuButton("Task 3"));
    });
  });

  it("focuses the column's heading after the last card of the column", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({
      "/projects/SAGA/tasks": listing([entry(1), entry(2, { status: "To Do" })]),
      [DELETE_2]: heldBack().reply,
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    const dialog = await askDelete(user, "Task 2");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(within(column("To Do")).getByRole("heading", { level: 2 }));
    });
    expect(titlesIn("To Do")).toEqual([]);
    expect(countOf("To Do")).toBe("0");
  });

  it("brings the card back after a refusal and opens the notice, leaving focus on the next card", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon({
      "/projects/SAGA/tasks": listing([entry(1), entry(2), entry(3)]),
      [DELETE_2]: write.reply,
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    const dialog = await askDelete(user, "Task 2");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(menuButton("Task 3"));
    });

    await act(async () => {
      write.answer(refusalReply(409, { kind: "store", code: "snapshot-lost", message: "the index lost its snapshot" }));
    });

    await waitFor(() => {
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2", "Task 3"]);
    });
    expect(countOf("Backlog")).toBe("3");
    expect(useNoticeStore.getState().notices).toMatchObject([
      {
        key: "task-write-failure:SAGA-2",
        form: "failure",
        title: "SAGA-2 was not deleted",
        line: "The daemon refused the delete, so the task is still there. Its own words are below.",
        words: ["store/snapshot-lost · the index lost its snapshot"],
      },
    ]);
    await waitFor(() => {
      expect(announced().some((words) => words.startsWith("SAGA-2 was not deleted."))).toBe(true);
    });
    expect(document.activeElement).toBe(menuButton("Task 3"));
    expect(announced()).not.toContain("SAGA-2 was deleted.");
  });

  it.each([
    { how: "Cancel", close: (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) =>
      user.click(within(dialog).getByRole("button", { name: "Cancel" })) },
    { how: "Esc", close: (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}") },
  ])("deletes nothing on $how, and returns focus to the card's menu button", async ({ close }) => {
    const user = userEvent.setup();
    const { transport, requests } = daemon({
      "/projects/SAGA/tasks": listing([entry(1), entry(2)]),
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    const dialog = await askDelete(user, "Task 1");
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    });
    await close(user, dialog);

    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(menuButton("Task 1"));
    });
    expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2"]);
    expect(deletes(requests)).toBe(0);
  });

  it("still sends the delete of a card a read removed while the dialog was open, and focuses its column's heading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) });
    const stub = daemon({
      "/projects/SAGA/tasks": listing([entry(1), entry(2), entry(3)]),
      [DELETE_2]: refusalReply(404, { kind: "store", code: "task-not-found", message: "no task SAGA-2" }),
    });
    const { feed } = await openWithFeed("/tasks?projects=SAGA", stub);
    const dialog = await askDelete(user, "Task 2");

    stub.replies["/projects/SAGA/tasks"] = listing([entry(1), entry(3)]);
    await feed.send([taskEvent("SAGA-2", "deleted")]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByText("Task 2")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    await vi.waitFor(() => {
      expect(deletes(stub.requests)).toBe(1);
    });
    await vi.waitFor(() => {
      expect(announced()).toContain("SAGA-2 was deleted.");
    });
    expect(useNoticeStore.getState().notices).toEqual([]);
    expect(document.activeElement).toBe(within(column("Backlog")).getByRole("heading", { level: 2 }));
  });

  it("leaves the card out of the label filter and the empty state while the delete is pending", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({
      "/projects/SAGA/tasks": listing([entry(2, { labels: ["web"] })]),
      [DELETE_2]: heldBack().reply,
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);

    await user.click(within(await askDelete(user, "Task 2")).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("No tasks in Saga yet.")).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: "Labels Any" }));
    expect(within(await screen.findByRole("listbox")).queryByRole("option", { name: /web/ })).toBeNull();
  });

  it("returns focus to the menu button after a Cancel that follows a delete", async () => {
    const user = userEvent.setup();
    const { transport, replies } = daemon({
      "/projects/SAGA/tasks": listing([entry(1), entry(2), entry(3)]),
      "DELETE /projects/SAGA/tasks/SAGA-1": successReply({ id: "SAGA-1" }),
    });
    await renderWithRouter("/tasks?projects=SAGA", transport);
    replies["/projects/SAGA/tasks"] = listing([entry(2), entry(3)]);

    await user.click(within(await askDelete(user, "Task 1")).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(announced()).toContain("SAGA-1 was deleted.");
    });
    await askDelete(user, "Task 3");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(menuButton("Task 3"));
    });
  });
});
