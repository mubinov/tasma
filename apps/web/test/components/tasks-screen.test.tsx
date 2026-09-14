import type { Diagnostic, ExcludedFile, Frontmatter, TaskEntry, Transport, TransportReply } from "@tasma/protocol";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../../src/store/ui";
import { refusalReply, renderWithRouter, successReply } from "../helpers";

const CONFIG = {
  statuses: ["Backlog", "To Do", "In Progress", "Done"],
  default_status: "Backlog",
  final_statuses: ["Done"],
  priorities: ["high", "medium", "low"],
  workflows: ["dev"],
  instructions: [],
};

const PROJECTS = [
  { tag: "TASM", name: "Tasma", path: "/repos/tasma" },
  { tag: "DOBBY", name: "Dobby", path: "/repos/dobby" },
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
  const id = `TASM-${String(number)}`;

  return {
    id,
    path: `/repos/tasma/tasks/${id}.md`,
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

/**
 * A daemon whose replies a test can change between polls. An unknown path is
 * refused, as the daemon refuses a route it does not serve.
 */
function daemon(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  const paths: string[] = [];
  const current: Record<string, TransportReply | Promise<TransportReply>> = {
    "/projects": successReply(PROJECTS),
    "/projects/TASM": project("TASM"),
    "/projects/TASM/tasks": listing([]),
    "/projects/DOBBY": project("DOBBY"),
    "/projects/DOBBY/tasks": listing([]),
    ...replies,
  };

  const transport: Transport = ({ path }) => {
    paths.push(path);

    return Promise.resolve(
      current[path] ?? refusalReply(404, { kind: "daemon", code: "route-not-found", message: `no route serves ${path}` }),
    );
  };

  return { transport, paths, replies: current };
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

    expect(router.state.location.search).toEqual({ projects: "TASM" });
    expect(screen.getByRole("button", { name: "Project Tasma TASM" })).toBeTruthy();
  });

  it("opens the project opened last when the listing holds it", async () => {
    useUiStore.setState({ lastTasksProject: "DOBBY" });
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks", transport);

    expect(router.state.location.search).toEqual({ projects: "DOBBY" });
  });

  it("opens the first project when the project opened last is gone", async () => {
    useUiStore.setState({ lastTasksProject: "GONE" });
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks", transport);

    expect(router.state.location.search).toEqual({ projects: "TASM" });
  });

  it("keeps the first of several projects, and the labels", async () => {
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks?projects=DOBBY,TASM&labels=web", transport);

    expect(router.state.location.search).toEqual({ projects: "DOBBY", labels: "web" });
  });

  it("reads an empty label list as no filter", async () => {
    const { transport } = daemon({ "/projects/TASM/tasks": listing([entry(1, { labels: ["web"] })]) });
    await renderWithRouter("/tasks?projects=TASM&labels=&view=list", transport);

    expect(countOf("Backlog")).toBe("1");
    expect(screen.getByRole("combobox", { name: "Labels Any" })).toBeTruthy();
  });

  it.each(["2026", "1.0", "true", "null"])("reads the label %s as the text the address holds", async (label) => {
    const { transport } = daemon({ "/projects/TASM/tasks": listing([entry(1, { labels: [label] }), entry(2)]) });
    await renderWithRouter(`/tasks?projects=TASM&labels=${label}`, transport);

    expect(countOf("Backlog")).toBe("1 of 2");
    expect(screen.getByRole("combobox", { name: `Labels ${label}` })).toBeTruthy();
  });

  it("opens the first of repeated project keys", async () => {
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks?projects=TASM&projects=DOBBY", transport);

    expect(router.state.location.search).toEqual({ projects: "TASM" });
    expect(screen.getByRole("button", { name: "Project Tasma TASM" })).toBeTruthy();
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
    const { transport } = daemon({ "/projects/TASM": INVALID, "/projects/TASM/tasks": INVALID });
    const router = await renderWithRouter("/tasks", transport);

    expect(router.state.location.search).toEqual({ projects: "TASM" });
    expect(screen.getByRole("alert").textContent).toContain("store/config-invalid");

    await user.click(screen.getByRole("button", { name: "Project Tasma TASM" }));
    const menu = await screen.findByRole("menu");
    await act(async () => {
      await user.click(within(menu).getByRole("menuitemradio", { name: "Dobby DOBBY" }));
    });

    expect(router.state.location.search).toEqual({ projects: "DOBBY" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No tasks in Dobby yet.")).toBeTruthy();
  });

  it.each(["/tasks", "/tasks?projects=TASM"])("shows no selector at %s when the listing of projects was refused", async (path) => {
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
      "/projects/TASM/tasks": listing([
        entry(1),
        entry(2, { status: "in progress" }),
        entry(3, { status: "Waiting" }),
        entry(4, { status: "Done" }),
      ]),
    });
    await renderWithRouter("/tasks?projects=TASM", transport);

    expect(screen.getAllByRole("region").map((region) => region.querySelector("h2")?.textContent)).toEqual(CONFIG.statuses);
    expect(CONFIG.statuses.map(countOf)).toEqual(["2", "0", "1", "1"]);
    expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 3"]);
    expect(titlesIn("In Progress")).toEqual(["Task 2"]);
  });

  it("says the project has no task, and keeps the columns", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks?projects=TASM", transport);

    expect(screen.getByText("No tasks in Tasma yet.")).toBeTruthy();
    expect(screen.getAllByRole("region")).toHaveLength(4);
  });

  it("names a project with no name by its tag", async () => {
    const { transport } = daemon({ "/projects/DOBBY": project("DOBBY", { name: undefined }) });
    await renderWithRouter("/tasks?projects=DOBBY", transport);

    expect(screen.getByText("No tasks in DOBBY yet.")).toBeTruthy();
  });

  it("shows each task's step from the workflow it names", async () => {
    const { transport, paths } = daemon({
      "/projects/TASM/tasks": listing([
        entry(1, { workflow: "dev", step: "approve" }),
        entry(2, { workflow: "dev", step: "research" }),
        entry(3, { workflow: "gone", step: "research" }),
        entry(4, { workflow: "..", step: "research" }),
      ]),
      "/workflows/dev": successReply(WORKFLOW),
      "/workflows/gone": refusalReply(404, { kind: "store", code: "workflow-unknown", message: "no workflow is named gone" }),
    });
    await renderWithRouter("/tasks?projects=TASM", transport);

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
      "/projects/TASM/tasks": listing([entry(1, { labels: ["web"] }), entry(2), entry(3, { status: "Done", labels: ["web"] })]),
    });
    await renderWithRouter("/tasks?projects=TASM&labels=web", transport);

    expect(CONFIG.statuses.map(countOf)).toEqual(["1 of 2", "0 of 0", "0 of 0", "1 of 1"]);
    expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    expect(screen.getByRole("status").textContent).toBe("2 of 3 tasks carry a selected label.");
  });

  it("says no task carries a label that matches nothing", async () => {
    const { transport } = daemon({ "/projects/TASM/tasks": listing([entry(1, { labels: ["web"] }), entry(2)]) });
    await renderWithRouter("/tasks?projects=TASM&labels=docs", transport);

    expect(screen.getByText("No task in Tasma carries any of the selected labels.")).toBeTruthy();
    expect(countOf("Backlog")).toBe("0 of 2");
    expect(screen.getByRole("status").textContent).toBe("0 of 2 tasks carry a selected label.");
  });

  it("wraps the heading line, so the controls stay inside a narrow viewport", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks?projects=TASM", transport);

    const line = screen.getByRole("heading", { level: 1 }).parentElement!;
    expect(line.classList.contains("flex-wrap")).toBe(true);
    expect(line.lastElementChild?.classList.contains("flex-wrap")).toBe(true);
  });

  it("gives the last column the right padding of main, so the page scrolls past it", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks?projects=TASM", transport);

    const row = screen.getAllByRole("region")[0]!.parentElement!;
    expect([...row.classList]).toEqual(expect.arrayContaining(["-mr-6", "sm:-mr-10", "*:last:box-content", "*:last:pr-6", "sm:*:last:pr-10"]));
    expect(row.lastElementChild?.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("remembers the project it loaded, titles the document, and marks Tasks current", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks?projects=DOBBY", transport);

    expect(window.localStorage.getItem("tasma.tasks.project")).toBe("DOBBY");
    expect(useUiStore.getState().lastTasksProject).toBe("DOBBY");
    expect(document.title).toBe("Tasks · tasma");
    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual(["Tasks"]);
  });
});

describe("what the daemon reports beside the tasks", () => {
  const MISSING: Diagnostic = { code: "path-missing", message: "the repository is not on disk", path: "/repos/tasma" };
  const UNKNOWN: Diagnostic = { code: "config-key-unknown", message: "unknown key: colour", path: "/p/config.yml", line: 4 };
  const BLOCKER: Diagnostic = { code: "blocked-by-unresolved", message: "TASM-9 names no task", path: "/p/TASM-1.md" };
  const EXCLUDED: ExcludedFile = { path: "/repos/tasma/tasks/TASM-7.md", code: "task-file-unreadable", message: "no frontmatter" };

  it("shows the notice and a warnings line of both reads, with the repeats removed", async () => {
    const { transport } = daemon({
      "/projects/TASM": successReply({ ...PROJECTS[0], live: false, config: CONFIG }, [MISSING, UNKNOWN]),
      "/projects/TASM/tasks": listing([entry(1)], [EXCLUDED], [{ ...UNKNOWN }, BLOCKER]),
    });
    await renderWithRouter("/tasks?projects=TASM", transport);

    expect(within(screen.getByRole("note")).getByText("The index is not following the disk")).toBeTruthy();
    const line = screen.getByRole("heading", { level: 2, name: /warnings/ });
    expect(line.textContent).toBe("4 warnings about this project");
    expect(line.parentElement?.parentElement?.className).toBe("mt-3");
    expect(screen.getByRole("status").textContent).toBe("The index is not following the disk. 4 warnings about this project.");
  });

  it("says nothing while there is nothing to report", async () => {
    const { transport } = daemon({ "/projects/TASM/tasks": listing([entry(1)]) });
    await renderWithRouter("/tasks?projects=TASM", transport);

    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: /warning/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("spaces the warnings line under the heading when there is no notice", async () => {
    const { transport } = daemon({ "/projects/TASM/tasks": listing([entry(1)], [EXCLUDED]) });
    await renderWithRouter("/tasks?projects=TASM", transport);

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
    const { transport, replies } = daemon({ "/projects/TASM/tasks": listing([entry(1), entry(2)]) });
    await renderWithRouter("/tasks?projects=TASM", transport);
    expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2"]);

    replies["/projects/TASM/tasks"] = listing([entry(1, { status: "Done" }), entry(2)]);
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
      expect(screen.getByText("No tasks in Tasma yet.")).toBeTruthy();
    });
    expect(router.state.location.search).toEqual({ projects: "TASM" });
  });

  it("asks nothing while the page is hidden", async () => {
    const { transport, paths } = daemon({ "/projects/TASM/tasks": listing([entry(1)]) });
    await renderWithRouter("/tasks?projects=TASM", transport);

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
    const { transport, replies } = daemon({ "/projects/TASM/tasks": listing([entry(1)]), "/workflows/dev": late });
    await renderWithRouter("/tasks?projects=TASM", transport);

    replies["/projects/TASM/tasks"] = listing([entry(1, { workflow: "dev", step: "approve" })]);
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
