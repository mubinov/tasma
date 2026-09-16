import type { Comment, Diagnostic, Frontmatter, TaskEntry, Transport, TransportReply } from "@tasma/protocol";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { refusalReply, renderWithRouter, stubTransport, successReply } from "../helpers";

const CONFIG = {
  statuses: ["Backlog", "In Progress", "Done"],
  default_status: "Backlog",
  final_statuses: ["Done"],
  priorities: ["high", "medium", "low"],
  workflows: ["dev"],
  instructions: [],
};

const PROJECT = { tag: "SAGA", name: "Saga", path: "/repos/saga", live: true, config: CONFIG };

const WORKFLOW = {
  name: "dev",
  instructions: [],
  steps: [
    { name: "research", file: "/w/dev/research.md", owner: "agent" },
    { name: "approve", file: "/w/dev/approve.md", owner: "human" },
  ],
};

const TASK_PATH = "/projects/SAGA/tasks/SAGA-3";

function frontmatter(fields: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: "SAGA-3",
    title: "Build the parser",
    status: "In Progress",
    created: "2026-09-01T10:00:00Z",
    updated: "2026-09-01T10:00:00Z",
    next_comment_id: 1,
    ...fields,
  };
}

function comment(id: number, fields: Partial<Comment> = {}): Comment {
  return { id, title: `Note ${String(id)}`, created: "2026-09-02T10:00:00Z", body: `Body of note ${String(id)}.`, ...fields };
}

type TaskParts = { fields?: Partial<Frontmatter>; body?: string; comments?: Comment[]; diagnostics?: Diagnostic[] };

function task({ fields = {}, body = "", comments = [], diagnostics = [] }: TaskParts = {}): TransportReply {
  return successReply({ frontmatter: frontmatter(fields), body, comments }, diagnostics);
}

function daemon(replies: Record<string, TransportReply> = {}) {
  return stubTransport({
    "/projects": successReply([{ tag: "SAGA", name: "Saga", path: "/repos/saga" }]),
    "/projects/SAGA": successReply(PROJECT),
    "/workflows/dev": successReply(WORKFLOW),
    [TASK_PATH]: task(),
    ...replies,
  });
}

function metaLine(): HTMLElement {
  return screen.getByRole("heading", { level: 1 }).parentElement!.nextElementSibling as HTMLElement;
}

function backLink(): HTMLElement {
  return within(screen.getByRole("main")).getByRole("link", { name: "Tasks" });
}

function commentCard(title: string): HTMLElement {
  return screen.getByRole("article", { name: title });
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

describe("the page", () => {
  it("heads the page with the title, the id shown above it, and the meta line", async () => {
    const { transport } = daemon({
      [TASK_PATH]: task({ fields: { priority: "high", workflow: "dev", step: "approve" } }),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Build the parser");
    expect(heading.className).toContain("wrap-anywhere");
    const id = heading.nextElementSibling;
    expect(id?.textContent).toBe("SAGA-3");
    expect(heading.parentElement?.className).toContain("flex-col-reverse");

    const [status, priority, step] = [...metaLine().children];
    expect(status?.textContent).toBe("In Progress");
    expect(status?.className).toContain("rounded-control");
    expect(priority?.textContent).toBe("high");
    expect(priority?.className).toBe("font-medium text-text");
    expect(step?.textContent).toBe("approve, step 2 of 2, a human's step");
    expect(step?.firstElementChild?.className).toContain("bg-signal");
    expect(step?.querySelector("i")).toBeNull();
    expect(document.title).toBe("SAGA-3 Build the parser · tasma");
  });

  it("keeps the back link in a top bar that stays while the page scrolls", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const back = backLink();
    expect(back.getAttribute("href")).toBe("/tasks?projects=SAGA");
    expect(back.parentElement?.className).toContain("sticky");
    expect(back.parentElement?.className).toContain("z-(--layer-top-bar)");
    expect(back.parentElement?.classList.contains("[html:has(&)]:scroll-pt-12")).toBe(true);
    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual(["Tasks"]);
  });

  it("returns to the project's board through the back link", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({ "/projects/SAGA/tasks": successReply({ entries: [], excluded: [] }) });
    const router = await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await user.click(backLink());

    expect(router.state.location.pathname).toBe("/tasks");
    expect(router.state.location.search).toEqual({ projects: "SAGA" });
  });

  it("mutes a priority that is not the top one, and shows a stale step as its name alone", async () => {
    const { transport } = daemon({ [TASK_PATH]: task({ fields: { priority: "low", workflow: "gone", step: "review" } }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const [, priority, step] = [...metaLine().children];
    expect(priority?.textContent).toBe("low");
    expect(priority?.getAttribute("class")).toBeNull();
    expect(step?.children).toHaveLength(1);
    expect(step?.firstElementChild?.className).toBe("font-mono text-xs text-dim");
  });

  it.each([{ status: "Done" }, { status: "done" }])("shows no step for the final status $status", async ({ status }) => {
    const { transport } = daemon({ [TASK_PATH]: task({ fields: { status, workflow: "dev", step: "approve" } }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect([...metaLine().children].map((item) => item.textContent)).toEqual([status]);
  });

  it("renders the body without its leading title heading", async () => {
    const { transport } = daemon({
      [TASK_PATH]: task({ body: "# Build the parser\n\nRead the file.\n\n## Plan\n\nSplit it." }),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "Plan" })).toBeTruthy();
    expect(screen.getByText("Read the file.")).toBeTruthy();
  });

  it("renders nothing after the meta line for a body of spaces and no comment", async () => {
    const { transport } = daemon({ [TASK_PATH]: task({ body: "  \n\n " }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect(metaLine().nextElementSibling).toBeNull();
    expect(screen.queryByRole("region", { name: /Comments/ })).toBeNull();
  });

  it("renders no comment section for a read that carries no comments", async () => {
    const { transport } = daemon({ [TASK_PATH]: successReply({ frontmatter: frontmatter(), body: "Text." }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect(screen.getByText("Text.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /Comments/ })).toBeNull();
  });
});

describe("the comments", () => {
  const COMMENTS = [
    comment(1, { author: "reviewer", created: new Date(2026, 8, 13, 10, 24).toISOString() }),
    comment(2, { collapsed: true, body: "Folded **text**." }),
    comment(5, { title: "Marker only", body: " \n" }),
  ];

  it("lists every comment in file order under a heading with the count", async () => {
    const { transport } = daemon({ [TASK_PATH]: task({ comments: COMMENTS }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const section = screen.getByRole("region", { name: "Comments 3" });
    const items = within(section).getAllByRole("listitem");
    expect(items.map((item) => within(item).getByRole("heading", { level: 3 }).textContent)).toEqual([
      "Note 1",
      "Note 2",
      "Marker only",
    ]);
  });

  it("heads a comment with its id, its author and its date", async () => {
    const { transport } = daemon({ [TASK_PATH]: task({ comments: COMMENTS }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const first = commentCard("Note 1");
    const line = within(first).getByRole("heading", { level: 3 }).parentElement!.nextElementSibling!;
    expect(line.textContent).toBe("#1·reviewer·2026-09-13 10:24");
    expect(line.querySelector("time")?.getAttribute("dateTime")).toBe(COMMENTS[0]!.created);
    expect(commentCard("Note 2").querySelector("h3")?.parentElement?.nextElementSibling?.textContent).toMatch(/^#2·\d{4}-/);
  });

  it("opens a comment unless its file says collapsed, and folds it with the caret", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({ [TASK_PATH]: task({ comments: COMMENTS }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const open = within(commentCard("Note 1")).getByRole("button", { name: "Comment text" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Body of note 1.")).toBeTruthy();

    const folded = within(commentCard("Note 2")).getByRole("button", { name: "Comment text" });
    expect(folded.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Folded")).toBeNull();

    await user.click(folded);
    expect(folded.getAttribute("aria-expanded")).toBe("true");
    expect(within(commentCard("Note 2")).getByText("text").tagName).toBe("STRONG");

    await user.click(open);
    expect(screen.queryByText("Body of note 1.")).toBeNull();
  });

  it("gives a comment with no text no caret and no panel", async () => {
    const { transport } = daemon({ [TASK_PATH]: task({ comments: COMMENTS }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const card = commentCard("Marker only");
    expect(within(card).queryByRole("button")).toBeNull();
    expect(card.children).toHaveLength(1);
  });
});

describe("opening a task from the board", () => {
  const ENTRY: TaskEntry = { id: "SAGA-3", path: "/repos/saga/tasks/SAGA-3.md", blocked: false, frontmatter: frontmatter({ workflow: "dev", step: "research" }) };

  it("asks the daemon for the task alone when the board's reads are in the cache", async () => {
    const user = userEvent.setup();
    const { transport, paths } = daemon({
      "/projects/SAGA/tasks": successReply({ entries: [ENTRY], excluded: [] }),
      [TASK_PATH]: task({ fields: { workflow: "dev", step: "research" } }),
    });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);
    paths.length = 0;

    await user.click(screen.getByRole("link", { name: "Build the parser" }));

    expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-3");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Build the parser");
    expect(paths).toEqual([TASK_PATH]);
  });
});

describe("polling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
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

  it("reads the task and the project again every 5 seconds", async () => {
    const { transport, paths, replies } = daemon({ [TASK_PATH]: task({ comments: [comment(1)] }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    paths.length = 0;

    replies[TASK_PATH] = task({ comments: [comment(1), comment(2)] });
    await poll();

    expect(paths.toSorted()).toEqual(["/projects/SAGA", TASK_PATH]);
    expect(screen.getByRole("region", { name: "Comments 2" })).toBeTruthy();
  });

  it("keeps the DOM of a comment a poll did not change", async () => {
    const { transport, replies } = daemon({ [TASK_PATH]: task({ comments: [comment(1), comment(2)] }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    const unchanged = screen.getByText("Body of note 1.");

    replies[TASK_PATH] = task({ comments: [comment(1), comment(2, { body: "Rewritten." })] });
    await poll();

    expect(screen.getByText("Rewritten.")).toBeTruthy();
    expect(screen.getByText("Body of note 1.")).toBe(unchanged);
  });

  it("opens a comment a poll gives text, unless its file says collapsed", async () => {
    const { transport, replies } = daemon({
      [TASK_PATH]: task({ comments: [comment(1, { body: "" }), comment(2, { body: "", collapsed: true })] }),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    replies[TASK_PATH] = task({ comments: [comment(1), comment(2, { collapsed: true })] });
    await poll();

    expect(within(commentCard("Note 1")).getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Body of note 1.")).toBeTruthy();
    expect(within(commentCard("Note 2")).getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  it("gives an open comment whose text a poll removes the closed header", async () => {
    const { transport, replies } = daemon({ [TASK_PATH]: task({ comments: [comment(1)] }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    expect(commentCard("Note 1").hasAttribute("data-open")).toBe(true);

    replies[TASK_PATH] = task({ comments: [comment(1, { body: "" })] });
    await poll();

    const card = commentCard("Note 1");
    expect(card.hasAttribute("data-open")).toBe(false);
    expect(card.hasAttribute("data-closed")).toBe(true);
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("shows the step of a workflow a poll brings once its read lands", async () => {
    const { transport, replies } = daemon();
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    expect(metaLine().children).toHaveLength(1);

    replies[TASK_PATH] = task({ fields: { workflow: "dev", step: "research" } });
    await poll();

    await vi.waitFor(() => {
      expect(metaLine().children[1]?.textContent).toBe("research, step 1 of 2, an agent's step");
    });
  });
});

describe("the warnings of the task read", () => {
  const BLOCKER: Diagnostic = { code: "blocked-by-unresolved", message: "SAGA-9 names no task", path: "/p/SAGA-3.md" };
  const STALE: Diagnostic = { code: "stale-next-comment-id", message: "next_comment_id is below 4", path: "/p/SAGA-3.md", line: 4 };

  function notices(): HTMLElement[] {
    return screen.queryAllByText(/warnings? about SAGA-/);
  }

  it("opens one warning notice, which a poll with the same warnings does not open again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { transport, replies } = daemon({ [TASK_PATH]: task({ diagnostics: [BLOCKER, STALE] }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const [title] = notices();
    expect(title?.textContent).toBe("2 warnings about SAGA-3");
    const words = within(title!.parentElement!).getAllByRole("listitem").map((item) => item.textContent);
    expect(words).toEqual(["blocked-by-unresolved · SAGA-9 names no task", "stale-next-comment-id · next_comment_id is below 4"]);

    replies[TASK_PATH] = task({ diagnostics: [{ ...BLOCKER }, { ...STALE }] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_010);
    });

    expect(notices()).toEqual([title]);
    expect(screen.queryByRole("heading", { level: 2, name: /warning/ })).toBeNull();
  });

  it("closes the notice when the reader goes to the board", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({
      [TASK_PATH]: task({ diagnostics: [BLOCKER] }),
      "/projects/SAGA/tasks": successReply({ entries: [], excluded: [] }),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    expect(notices().map((notice) => notice.textContent)).toEqual(["1 warning about SAGA-3"]);

    await user.click(backLink());

    expect(notices()).toEqual([]);
  });

  it("starts the next task afresh: its comments as its file says, and no notice of the task before", async () => {
    const { transport } = daemon({
      [TASK_PATH]: task({ comments: [comment(1, { collapsed: true })], diagnostics: [BLOCKER] }),
      "/projects/SAGA/tasks/SAGA-4": task({ fields: { id: "SAGA-4", title: "Write the docs" }, comments: [comment(1)] }),
    });
    const router = await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    expect(within(commentCard("Note 1")).getByRole("button").getAttribute("aria-expanded")).toBe("false");
    expect(notices()).toHaveLength(1);

    await act(async () => {
      await router.navigate({ to: "/tasks/$project/$task", params: { project: "SAGA", task: "SAGA-4" } });
    });

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Write the docs");
    expect(within(commentCard("Note 1")).getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(notices()).toEqual([]);
  });
});

describe("a failed load", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("hands an id no URL segment can carry to the not-found screen, with no request", async () => {
    const { transport, paths } = daemon();
    await renderWithRouter("/tasks/SAGA/%5C", transport);

    expect(screen.getByRole("main").textContent).toContain("names nothing the application can show");
    expect(paths).toEqual([]);
  });

  it.each<{ case: string; path: string; replies: Record<string, TransportReply>; words: string[] }>([
    {
      case: "a task the project does not hold",
      path: "/tasks/SAGA/OTHER-1",
      replies: {
        "/projects/SAGA/tasks/OTHER-1": refusalReply(404, { kind: "store", code: "task-not-found", message: "no task OTHER-1" }),
      },
      words: ["store/task-not-found", "no task OTHER-1"],
    },
    {
      case: "a task file that does not parse",
      path: "/tasks/SAGA/SAGA-3",
      replies: {
        [TASK_PATH]: refusalReply(422, {
          kind: "parse",
          code: "frontmatter-invalid",
          message: "/repos/saga/tasks/SAGA-3.md:2: the frontmatter is not YAML",
          line: 2,
        }),
      },
      words: ["parse/frontmatter-invalid", "SAGA-3.md:2: the frontmatter is not YAML"],
    },
    {
      case: "a project the daemon refuses",
      path: "/tasks/SAGA/SAGA-3",
      replies: { "/projects/SAGA": refusalReply(422, { kind: "store", code: "config-invalid", message: "statuses is empty" }) },
      words: ["store/config-invalid", "statuses is empty"],
    },
  ])("shows the refusal for $case", async ({ path, replies, words }) => {
    const { transport } = daemon(replies);
    await renderWithRouter(path, transport);

    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("heading", { level: 1 }).textContent).toBe("the daemon refused this request");
    for (const word of words) {
      expect(alert.textContent).toContain(word);
    }
  });

  it.each([
    { case: "an answer with no envelope", reply: { status: 502 }, heading: "tasma cannot read the daemon's answer" },
    { case: "no answer at all", reply: null, heading: "tasma cannot reach the daemon" },
  ])("shows the transport failure for $case, with Retry", async ({ reply, heading }) => {
    const { transport: answering } = daemon();
    const transport: Transport = (request) =>
      request.path === TASK_PATH
        ? reply === null ? Promise.reject(new Error("connection refused")) : Promise.resolve(reply)
        : answering(request);

    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("heading", { level: 1 }).textContent).toBe(heading);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
