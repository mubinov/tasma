import type { Diagnostic, ExcludedFile, Frontmatter, TaskEntry } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { formatClock } from "../../src/lib/clock";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import {
  boardState,
  boardStateRegion,
  CONFIG,
  DELTA,
  entry,
  filterRegion,
  filterResult,
  listing,
  OTHER_CONFIG,
  project,
  SAGA,
  taggedEntry,
  titlesIn,
  twoProjects,
  WORKFLOW,
} from "../board-fixtures";
import { heldBack, refusalReply, renderWithRouter, successReply } from "../helpers";
import { frame } from "../setup/notice-store";

/** The project list as the daemon sends it: sorted by tag. */
const SORTED = [DELTA, SAGA];

/** The columns of DELTA (To Do, Review, Done) merged with those of SAGA (Backlog, To Do, In Progress, Done). */
const MERGED = ["Backlog", "To Do", "Review", "In Progress", "Done"];

const INVALID = refusalReply(422, { kind: "store", code: "config-invalid", message: "statuses is empty" });

/** The titles of the notes and the warnings lines under the heading, in the order of the page. */
function blocksUnderHeading(): (string | null | undefined)[] {
  const board = screen.getByRole("heading", { level: 1 }).parentElement!.parentElement!;

  return [...board.children]
    .map((block) => (block.getAttribute("role") === "note"
      ? block.querySelector("h2, p")
      : block.querySelector(":scope > div > h2"))?.textContent)
    .filter((title) => title !== undefined);
}

function delta(number: number, fields: Partial<Frontmatter> = {}): TaskEntry {
  return taggedEntry("DELTA", number, fields);
}

/** The headings of the board's columns, in order. */
function columnNames(): (string | null)[] {
  return [...document.querySelectorAll("[data-column-index]")].map((section) => section.querySelector("h2")!.textContent);
}

function card(title: string): HTMLElement {
  return screen.getByText(title).closest<HTMLElement>("[data-task-id]")!;
}

function cardLink(title: string): HTMLElement {
  return within(card(title)).getByRole("link");
}

function menuButton(title: string): HTMLElement {
  const taskCard = card(title);

  return within(taskCard).getByRole("button", { name: `Task menu ${taskCard.dataset.taskId}` });
}

function patches(requests: { method: string; path: string; body?: unknown }[]) {
  return requests.filter(({ method }) => method === "PATCH").map(({ path, body }) => [path, body]);
}

function columnHeading(status: string): HTMLElement {
  return screen.getByRole("heading", { level: 2, name: status });
}

async function focusOn(element: HTMLElement) {
  await act(async () => {
    element.focus();
  });
  expect(document.activeElement).toBe(element);
}

/** Every text announced from now on, in order. */
function recordAnnounced(): string[] {
  const words: string[] = [];
  const stop = useNoticeStore.subscribe(({ announced }, previous) => {
    words.push(...announced.filter((message) => !previous.announced.includes(message)).map((message) => message.words));
  });

  onTestFinished(stop);
  return words;
}

/** One poll interval, the retry of an unreadable answer, and the notification of the cache. */
async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_010);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    lastTasksProject: null,
    boardReturn: null,
    boardRestorePending: false,
    revealedColumns: new Set(),
  });
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe("the address", () => {
  const BOTH = {
    "/projects/SAGA/tasks": listing([entry(1), entry(2, { status: "To Do" })]),
    "/projects/DELTA/tasks": listing([delta(11, { status: "To Do" }), delta(12, { status: "Review" })]),
  };

  it.each(["DELTA,SAGA", "SAGA,DELTA"])("opens %s without a redirect, as one row of merged columns", async (projects) => {
    const { transport } = twoProjects(BOTH);
    const router = await renderWithRouter(`/tasks?projects=${projects}`, transport);

    expect(router.state.location.search).toEqual({ projects });
    expect(columnNames()).toEqual(MERGED);
    expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    expect(titlesIn("To Do")).toEqual(["Task 2", "Task 11"]);
    expect(titlesIn("Review")).toEqual(["Task 12"]);
  });

  it("opens a tag named twice as a board of one project", async () => {
    const { transport } = twoProjects(BOTH);
    await renderWithRouter("/tasks?projects=SAGA,SAGA", transport);

    expect(columnNames()).toEqual(CONFIG.statuses);
    expect(screen.getByRole("button", { name: "New task" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search" })).toBeTruthy();
    expect(window.localStorage.getItem("tasma.tasks.project")).toBe("SAGA");
  });

  it("hands a tag no URL segment can carry in any place of the list to the not-found screen", async () => {
    const { transport, paths } = twoProjects();
    await renderWithRouter("/tasks?projects=SAGA,..", transport);

    expect(screen.getByRole("main").textContent).toContain("names nothing the application can show");
    expect(paths).toEqual([]);
  });

  it("shows the other project and a note with the daemon's words for a project whose read is refused", async () => {
    const { transport } = twoProjects({
      "/projects/SAGA": INVALID,
      "/projects/DELTA/tasks": listing([delta(11, { status: "To Do" })]),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    expect(columnNames()).toEqual(OTHER_CONFIG.statuses);
    expect(titlesIn("To Do")).toEqual(["Task 11"]);
    expect(screen.getByRole("note").textContent).toBe(
      "SAGA did not load"
      + "The board shows the other projects. It tries SAGA again every 5 seconds."
      + "store/config-invalid · statuses is empty",
    );
    expect(screen.getByRole("heading", { level: 2, name: "SAGA did not load" })).toBeTruthy();
    expect(boardState()).toBe("SAGA did not load.");
    expect(useNoticeStore.getState().notices).toEqual([]);
  });

  it("is a board of several projects while one of its two projects is refused", async () => {
    const { transport } = twoProjects({ "/projects/SAGA": INVALID, "/projects/SAGA/tasks": INVALID });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByText("No tasks in these projects yet.")).toBeTruthy();
    expect(window.localStorage.getItem("tasma.tasks.project")).toBeNull();
    expect(useUiStore.getState().lastTasksProject).toBeNull();
  });

  it("reads the project list once more for tags it does not hold, and sends no read for them", async () => {
    const { transport, paths } = twoProjects({ "/projects/DELTA/tasks": listing([delta(11, { status: "To Do" })]) });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);
    paths.splice(0);

    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "DELTA,NOPE,ZETA" } });
    });

    expect(titlesIn("To Do")).toEqual(["Task 11"]);
    expect(screen.getAllByRole("note").map((note) => note.textContent)).toEqual([
      "NOPE is not a project"
      + "The daemon's project list has no project with this tag. The board shows NOPE when a project with this tag appears.",
      "ZETA is not a project"
      + "The daemon's project list has no project with this tag. The board shows ZETA when a project with this tag appears.",
    ]);
    await frame();
    expect(boardState()).toBe("NOPE is not a project. ZETA is not a project.");
    expect(paths.filter((path) => path === "/projects")).toHaveLength(1);
    expect(paths.filter((path) => /^\/projects\/(NOPE|ZETA)/.test(path))).toEqual([]);
  });

  it("shows the projects of tags the cached project list does not hold and the list read again holds", async () => {
    const { transport, replies } = twoProjects({
      "/projects/ECHO": project("ECHO"),
      "/projects/ECHO/tasks": listing([taggedEntry("ECHO", 21)]),
      "/projects/FOXTROT": project("FOXTROT"),
      "/projects/FOXTROT/tasks": listing([taggedEntry("FOXTROT", 31, { status: "To Do" })]),
    });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);

    replies["/projects"] = successReply([DELTA, { tag: "ECHO" }, { tag: "FOXTROT" }, SAGA]);
    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "SAGA,FOXTROT,ECHO" } });
    });

    expect(titlesIn("Backlog")).toEqual(["Task 21"]);
    expect(titlesIn("To Do")).toEqual(["Task 31"]);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("shows the failure screen with the refusal of the first project when every project is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = refusalReply(422, { kind: "store", code: "project-invalid", message: "config.yml is broken" });
    const { transport } = twoProjects({ "/projects/DELTA": INVALID, "/projects/SAGA/tasks": broken });
    await renderWithRouter("/tasks?projects=SAGA,DELTA", transport);

    expect(screen.getByRole("alert").textContent).toContain("store/config-invalid");
    expect(screen.getByRole("alert").textContent).not.toContain("config.yml is broken");
    expect(screen.getByRole("button", { name: "Project Delta DELTA" })).toBeTruthy();
  });

  it("reads the first of the tags the project list does not hold once, for the failure screen, when no tag loads", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = refusalReply(404, { kind: "store", code: "project-not-found", message: "no project is tagged NOPE" });
    const { transport, paths } = twoProjects({ "/projects/NOPE": refusal, "/projects/NOPE/tasks": refusal });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);
    paths.splice(0);

    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "ZETA,NOPE" } });
    });

    expect(screen.getByRole("alert").textContent).toContain("no project is tagged NOPE");
    expect(paths.filter((path) => path === "/projects/NOPE")).toHaveLength(1);
    expect(paths.filter((path) => path.startsWith("/projects/ZETA"))).toEqual([]);
  });

  it("shows the first of the tags the project list does not hold when its reads succeed and no other tag loads", async () => {
    const { transport } = twoProjects({
      "/projects/ECHO": project("ECHO"),
      "/projects/ECHO/tasks": listing([taggedEntry("ECHO", 21)]),
    });
    await renderWithRouter("/tasks?projects=ECHO,ZETA", transport);

    expect(titlesIn("Backlog")).toEqual(["Task 21"]);
    expect(screen.getAllByRole("note").map((note) => note.querySelector("h2")?.textContent)).toEqual(["ZETA is not a project"]);
  });

  it("shows the failure screen when a read of one project gets no answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport } = twoProjects({ "/projects/SAGA": INVALID, "/projects/DELTA/tasks": { status: 502 } });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    expect(screen.getByRole("alert").textContent).toContain("HTTP 502");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("shows the projects of all projects that load, with a note for a refused one", async () => {
    const { transport } = twoProjects({
      "/projects/SAGA": INVALID,
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    await renderWithRouter("/tasks?projects=all", transport);

    expect(titlesIn("Review")).toEqual(["Task 11"]);
    expect(screen.getByRole("heading", { level: 2, name: "SAGA did not load" })).toBeTruthy();
  });

  it("shows the failure screen with the first project of the list in the picker when all projects are refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport } = twoProjects({ "/projects/SAGA": INVALID, "/projects/DELTA/tasks": INVALID });
    await renderWithRouter("/tasks?projects=all", transport);

    expect(screen.getByRole("alert").textContent).toContain("store/config-invalid");
    expect(screen.getByRole("button", { name: "Project Delta DELTA" })).toBeTruthy();
  });

  it("reads the workflows of the entries of both projects", async () => {
    const { transport, paths } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1, { workflow: "dev", step: "approve" })]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "To Do", workflow: "ops", step: "approve" })]),
      "/workflows/dev": successReply(WORKFLOW),
      "/workflows/ops": successReply({ ...WORKFLOW, name: "ops" }),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    expect(paths).toEqual(expect.arrayContaining(["/workflows/dev", "/workflows/ops"]));
    expect(within(card("Task 1")).getByText("approve").className).toContain("text-text");
    expect(within(card("Task 11")).getByText("approve").className).toContain("text-text");
  });
});

describe("the board of all projects", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("shows every project in the order of the project list", async () => {
    const { transport } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    const router = await renderWithRouter("/tasks?projects=all", transport);

    expect(router.state.location.search).toEqual({ projects: "all" });
    expect(columnNames()).toEqual(MERGED);
    expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    expect(titlesIn("Review")).toEqual(["Task 11"]);
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
  });

  it("shows a project added to the tree after a poll, and leaves out a project removed from it", async () => {
    const { transport, replies } = twoProjects({
      "/projects": successReply([SAGA]),
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    const router = await renderWithRouter("/tasks?projects=all", transport);
    expect(columnNames()).toEqual(CONFIG.statuses);

    replies["/projects"] = successReply(SORTED);
    await poll();
    await vi.waitFor(() => {
      expect(titlesIn("Review")).toEqual(["Task 11"]);
    });
    expect(columnNames()).toEqual(MERGED);

    replies["/projects"] = successReply([DELTA]);
    await poll();
    await vi.waitFor(() => {
      expect(columnNames()).toEqual(OTHER_CONFIG.statuses);
    });
    expect(screen.queryByText("Task 1")).toBeNull();
    expect(router.state.location.search).toEqual({ projects: "all" });
  });

  it("shows the empty-tree screen on an empty tree, and the board of all projects when a project appears", async () => {
    const { transport, replies } = twoProjects({ "/projects": successReply([]) });
    const router = await renderWithRouter("/tasks?projects=all", transport);
    expect(screen.getByText(/^No projects yet/)).toBeTruthy();

    replies["/projects"] = successReply([SAGA]);
    await poll();

    await vi.waitFor(() => {
      expect(screen.getByText("No tasks in these projects yet.")).toBeTruthy();
    });
    expect(router.state.location.search).toEqual({ projects: "all" });
  });

  it("shows a project that joins after the next poll when a label click drops the load that reads it", async () => {
    const user = userEvent.setup({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) });
    const listingRead = heldBack();
    const { transport, replies } = twoProjects({
      "/projects": successReply([SAGA]),
      "/projects/SAGA/tasks": listing([entry(1, { labels: ["web"] })]),
      "/projects/DELTA/tasks": listingRead.reply,
    });
    const router = await renderWithRouter("/tasks?projects=all", transport);

    replies["/projects"] = successReply(SORTED);
    await poll();
    await user.click(screen.getByRole("combobox", { name: /^Labels/ }));
    await user.click(await screen.findByRole("option", { name: /web/ }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ projects: "all", labels: "web" });
    });

    replies["/projects/DELTA/tasks"] = listing([delta(11, { status: "Review", labels: ["web"] })]);
    await act(async () => {
      listingRead.answer(listing([delta(11, { status: "Review", labels: ["web"] })]));
    });
    await poll();

    await vi.waitFor(() => {
      expect(titlesIn("Review")).toEqual(["Task 11"]);
    });
  });

  describe("the scroll", () => {
    /** Puts the page at `top`, and moves it where a scroll asks for. */
    function stubWindowScroll(top: number) {
      const scrollTo = vi.fn((to: ScrollToOptions | number, y = 0) => {
        vi.stubGlobal("scrollY", typeof to === "number" ? y : to.top);
      });
      vi.stubGlobal("scrollX", 0);
      vi.stubGlobal("scrollY", top);
      vi.stubGlobal("scrollTo", scrollTo);
      return scrollTo;
    }

    it("stays where it is when a project joins after a poll, and goes to the top on a label change", async () => {
      const { transport, replies } = twoProjects({
        "/projects": successReply([SAGA]),
        "/projects/SAGA/tasks": listing([entry(1)]),
        "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
      });
      const router = await renderWithRouter("/tasks?projects=all", transport);
      const scrollTo = stubWindowScroll(600);

      replies["/projects"] = successReply(SORTED);
      await poll();
      await vi.waitFor(() => {
        expect(titlesIn("Review")).toEqual(["Task 11"]);
      });
      await poll();

      expect(window.scrollY).toBe(600);
      expect(scrollTo).not.toHaveBeenCalled();

      await act(async () => {
        await router.navigate({ to: "/tasks", search: { projects: "all", labels: "web" } });
      });

      await vi.waitFor(() => {
        expect(window.scrollY).toBe(0);
      });
    });

    it("goes to the top on the sidebar Tasks link, which opens the same board", async () => {
      const user = userEvent.setup({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) });
      const { transport } = twoProjects({ "/projects/SAGA/tasks": listing([entry(1)]) });
      const router = await renderWithRouter("/tasks?projects=SAGA", transport);
      stubWindowScroll(600);

      await user.click(within(screen.getByRole("navigation")).getByRole("link", { name: "Tasks" }));

      await vi.waitFor(() => {
        expect(window.scrollY).toBe(0);
      });
      expect(router.state.location.search).toEqual({ projects: "SAGA" });
    });
  });

  describe("the focus", () => {
    /** DELTA with a status of its own before the To Do it shares with SAGA. */
    const TRIAGE_CONFIG = { ...OTHER_CONFIG, statuses: ["Triage", "To Do", "Done"] };

    it("stays on a card when a project joins with a column before it, and Show all stays open", async () => {
      const user = userEvent.setup({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) });
      const done = Array.from({ length: 25 }, (_, index) => entry(index + 10, { status: "Done" }));
      const { transport, replies } = twoProjects({
        "/projects": successReply([SAGA]),
        "/projects/SAGA/tasks": listing([entry(1, { status: "In Progress" }), ...done]),
        "/projects/DELTA/tasks": listing([delta(2, { status: "Review" })]),
      });
      await renderWithRouter("/tasks?projects=all", transport);
      await user.click(screen.getByRole("button", { name: "Show all" }));
      await focusOn(cardLink("Task 1"));

      replies["/projects"] = successReply(SORTED);
      await poll();
      await vi.waitFor(() => {
        expect(columnNames()).toEqual(MERGED);
      });

      expect(document.activeElement).toBe(cardLink("Task 1"));
      expect(titlesIn("Done")).toHaveLength(25);
    });

    it("stays on a card when a project leaves and takes a column before it", async () => {
      const { transport, replies } = twoProjects({
        "/projects/SAGA/tasks": listing([entry(1, { status: "In Progress" })]),
        "/projects/DELTA/tasks": listing([delta(2, { status: "Review" })]),
      });
      await renderWithRouter("/tasks?projects=all", transport);
      await focusOn(cardLink("Task 1"));

      replies["/projects"] = successReply([SAGA]);
      await poll();
      await vi.waitFor(() => {
        expect(columnNames()).toEqual(CONFIG.statuses);
      });

      expect(document.activeElement).toBe(cardLink("Task 1"));
    });

    it("goes to the heading of the column of a focused card whose project leaves", async () => {
      const { transport, replies } = twoProjects({
        "/projects/DELTA": project("DELTA", { config: TRIAGE_CONFIG }),
        "/projects/SAGA/tasks": listing([entry(1)]),
        "/projects/DELTA/tasks": listing([delta(2, { status: "To Do" })]),
      });
      await renderWithRouter("/tasks?projects=all", transport);
      expect(columnNames()).toEqual(["Triage", "Backlog", "To Do", "In Progress", "Done"]);
      await focusOn(cardLink("Task 2"));

      replies["/projects"] = successReply([SAGA]);
      await poll();

      await vi.waitFor(() => {
        expect(document.activeElement).toBe(columnHeading("To Do"));
      });
    });

    it("goes to the heading of the column at the old place when the card's column left with its project", async () => {
      const { transport, replies } = twoProjects({
        "/projects/SAGA/tasks": listing([entry(1)]),
        "/projects/DELTA/tasks": listing([delta(2, { status: "Review" })]),
      });
      await renderWithRouter("/tasks?projects=all", transport);
      await focusOn(cardLink("Task 2"));

      replies["/projects"] = successReply([SAGA]);
      await poll();

      await vi.waitFor(() => {
        expect(document.activeElement).toBe(columnHeading("In Progress"));
      });
    });

    it("goes to the heading of the column at the old place when a focused heading's column leaves with its project", async () => {
      const { transport, replies } = twoProjects({ "/projects/DELTA/tasks": listing([delta(2, { status: "Review" })]) });
      await renderWithRouter("/tasks?projects=all", transport);
      await focusOn(columnHeading("Review"));

      replies["/projects"] = successReply([SAGA]);
      await poll();

      await vi.waitFor(() => {
        expect(document.activeElement).toBe(columnHeading("In Progress"));
      });
    });

    it("goes to the heading of the column at the old place when Show all leaves with its project", async () => {
      const closed = Array.from({ length: 25 }, (_, index) => delta(index + 1, { status: "Closed" }));
      const { transport, replies } = twoProjects({
        "/projects/DELTA": project("DELTA", {
          config: { ...OTHER_CONFIG, statuses: ["To Do", "Review", "Closed"], final_statuses: ["Closed"] },
        }),
        "/projects/DELTA/tasks": listing(closed),
      });
      await renderWithRouter("/tasks?projects=all", transport);
      expect(columnNames()).toEqual(["Backlog", "To Do", "Review", "Closed", "In Progress", "Done"]);
      await focusOn(screen.getByRole("button", { name: "Show all" }));

      replies["/projects"] = successReply([SAGA]);
      await poll();

      await vi.waitFor(() => {
        expect(document.activeElement).toBe(columnHeading("Done"));
      });
    });

    it("goes to the main region when the last project leaves", async () => {
      const { transport, replies } = twoProjects({
        "/projects": successReply([SAGA]),
        "/projects/SAGA/tasks": listing([entry(1)]),
      });
      await renderWithRouter("/tasks?projects=all", transport);
      await focusOn(cardLink("Task 1"));

      replies["/projects"] = successReply([]);
      await poll();

      await vi.waitFor(() => {
        expect(screen.getByText(/^No projects yet/)).toBeTruthy();
      });
      expect(document.activeElement).toBe(screen.getByRole("main"));
    });
  });

  it("opens one notice about these projects when the reads of both projects fail two polls in a row", async () => {
    const { transport, replies } = twoProjects({ "/projects/SAGA/tasks": listing([entry(1)]) });
    const router = await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);
    const readAt = router.options.context.queryClient.getQueryState(["daemon", "projects", "DELTA", "tasks"])!.dataUpdatedAt;

    replies["/projects/SAGA/tasks"] = { status: 502 };
    replies["/projects/DELTA/tasks"] = { status: 502 };
    await poll();
    expect(useNoticeStore.getState().notices).toEqual([]);

    await poll();
    expect(useNoticeStore.getState().notices).toMatchObject([
      {
        key: "board-poll:DELTA,SAGA",
        title: "The board is not up to date",
        line: "The last reads of one or more of these projects failed. "
          + `The board shows the tasks of those projects as they were at ${formatClock(readAt)}.`,
      },
    ]);
    expect(titlesIn("Backlog")).toEqual(["Task 1"]);
  });
});

describe("a project that fails while the board is open", () => {
  const BLOCKER: Diagnostic = { code: "blocked-by-unresolved", message: "SAGA-9 names no task", path: "/p/SAGA-1.md" };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  /** Counts the changes of a region's text from now on. */
  function watch(region: Element): () => number {
    let count = 0;
    const observer = new MutationObserver((records) => {
      count += records.length;
    });

    observer.observe(region, { subtree: true, childList: true, characterData: true });
    onTestFinished(() => {
      observer.disconnect();
    });
    return () => {
      count += observer.takeRecords().length;
      return count;
    };
  }

  it("takes out the cards of a project a poll refuses, and brings them back when a poll succeeds", async () => {
    const words = recordAnnounced();
    const { transport, replies } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1, { status: "To Do" })]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);
    await focusOn(cardLink("Task 1"));

    replies["/projects/SAGA/tasks"] = INVALID;
    await poll();

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(columnHeading("To Do"));
    });
    expect(screen.queryByText("Task 1")).toBeNull();
    expect(columnNames()).toEqual(OTHER_CONFIG.statuses);
    expect(screen.getByRole("note").textContent).toContain("store/config-invalid · statuses is empty");
    expect(boardState()).toBe("SAGA did not load.");
    await poll();
    expect(useNoticeStore.getState().notices).toEqual([]);

    replies["/projects/SAGA/tasks"] = listing([entry(1, { status: "To Do" })]);
    await poll();

    await vi.waitFor(() => {
      expect(titlesIn("To Do")).toEqual(["Task 1"]);
    });
    expect(screen.queryByRole("note")).toBeNull();
    expect(boardState()).toBe("");
    await vi.waitFor(() => {
      expect(words).toEqual(["SAGA loaded."]);
    });
  });

  it("moves the focus before the board state says that the project of the focused card did not load", async () => {
    const { transport, replies } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1, { status: "To Do" })]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);
    await focusOn(cardLink("Task 1"));
    const region = boardStateRegion();
    const saidAtFocus: (string | null)[] = [];
    const record = () => {
      saidAtFocus.push(region.textContent);
    };
    document.addEventListener("focusin", record);
    onTestFinished(() => {
      document.removeEventListener("focusin", record);
    });

    replies["/projects/SAGA/tasks"] = INVALID;
    await poll();

    await vi.waitFor(() => {
      expect(boardState()).toBe("SAGA did not load.");
    });
    expect(document.activeElement).toBe(columnHeading("To Do"));
    expect(saidAtFocus).toEqual([""]);
  });

  it("keeps the status regions out of what the delete dialog hides, and hides a block that a poll adds", async () => {
    const user = userEvent.setup({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) });
    const { transport, replies } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);
    await user.click(menuButton("Task 11"));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Delete / }));
    await screen.findByRole("alertdialog");

    replies["/projects/SAGA/tasks"] = INVALID;
    replies["/projects/DELTA/tasks"] = listing([delta(11, { status: "Review" })], [], [BLOCKER]);
    await poll();

    await vi.waitFor(() => {
      expect(boardState()).toBe("SAGA did not load. 1 warning about DELTA.");
    });
    const hidden = "[aria-hidden='true'], [inert]";
    expect(screen.getByRole("main", { hidden: true }).getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("heading", { level: 1, hidden: true }).closest(hidden)).not.toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "SAGA did not load", hidden: true }).closest(hidden))
      .not.toBeNull();
    expect(screen.getByRole("button", { name: "Show 1 warning about DELTA", hidden: true }).closest(hidden))
      .not.toBeNull();
    expect(boardStateRegion().closest(hidden)).toBeNull();
    expect(filterRegion().closest(hidden)).toBeNull();
  });

  it("gives the focus to the delete dialog when a focused notice closes while the dialog is open", async () => {
    const user = userEvent.setup({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) });
    const { transport, replies } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);
    await user.click(menuButton("Task 11"));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Delete / }));
    const dialog = await screen.findByRole("alertdialog");

    replies["/projects/SAGA/tasks"] = { status: 502 };
    replies["/projects/DELTA/tasks"] = { status: 502 };
    await poll();
    await poll();
    await focusOn(screen.getByRole("button", { name: "Dismiss" }));

    replies["/projects/SAGA/tasks"] = listing([entry(1)]);
    replies["/projects/DELTA/tasks"] = listing([delta(11, { status: "Review" })]);
    await poll();

    await vi.waitFor(() => {
      expect(useNoticeStore.getState().notices).toEqual([]);
    });
    expect(document.activeElement).toBe(dialog);
  });

  it("shows no column and gives the focus to the main region when a poll refuses every project", async () => {
    const { transport, replies } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);
    await focusOn(cardLink("Task 11"));

    replies["/projects/SAGA"] = INVALID;
    replies["/projects/DELTA"] = INVALID;
    await poll();

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("main"));
    });
    expect(columnNames()).toEqual([]);
    expect(screen.queryByText("No tasks in these projects yet.")).toBeNull();
    expect(blocksUnderHeading()).toEqual(["DELTA did not load", "SAGA did not load"]);

    replies["/projects/DELTA"] = project("DELTA", { config: OTHER_CONFIG });
    await poll();
    await vi.waitFor(() => {
      expect(titlesIn("Review")).toEqual(["Task 11"]);
    });
    await focusOn(cardLink("Task 11"));

    replies["/projects/DELTA/tasks"] = listing([]);
    await poll();

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(columnHeading("Review"));
    });
  });

  it("gives the focus to the main region after a delete confirmed when no column is left", async () => {
    const user = userEvent.setup({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) });
    const { transport, replies } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
      "DELETE /projects/DELTA/tasks/DELTA-11": heldBack().reply,
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);
    await user.click(menuButton("Task 11"));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Delete / }));
    const dialog = await screen.findByRole("alertdialog");

    replies["/projects/SAGA"] = INVALID;
    replies["/projects/DELTA"] = INVALID;
    await poll();
    await vi.waitFor(() => {
      expect(columnNames()).toEqual([]);
    });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("main"));
    });
  });

  it("brings back the cards of a project refused at the load once both of its reads succeed, and says so", async () => {
    const words = recordAnnounced();
    const { transport, replies } = twoProjects({
      "/projects/SAGA": INVALID,
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(words).toEqual([]);

    replies["/projects/SAGA"] = project("SAGA");
    replies["/projects/SAGA/tasks"] = listing([entry(1)]);
    await poll();

    await vi.waitFor(() => {
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    });
    expect(screen.queryByRole("note")).toBeNull();
    await vi.waitFor(() => {
      expect(words).toEqual(["SAGA loaded."]);
    });
  });

  it("shows no words in the note of a refused project whose reads succeed while its load runs", async () => {
    const workflowRead = heldBack();
    const { transport, replies } = twoProjects({ "/projects/SAGA": INVALID, "/workflows/dev": workflowRead.reply });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    replies["/projects/SAGA"] = project("SAGA");
    replies["/projects/SAGA/tasks"] = listing([entry(1, { workflow: "dev", step: "approve" })]);
    await poll();

    await vi.waitFor(() => {
      expect(screen.getByRole("note").textContent).toBe(
        "SAGA did not loadThe board shows the other projects. It tries SAGA again every 5 seconds.",
      );
    });

    await act(async () => {
      workflowRead.answer(successReply(WORKFLOW));
    });
    await vi.waitFor(() => {
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    });
  });

  it("shows a tag the project list did not hold once a poll of the list holds it, and says so", async () => {
    const words = recordAnnounced();
    const { transport, replies } = twoProjects({
      "/projects/ECHO": project("ECHO"),
      "/projects/ECHO/tasks": listing([taggedEntry("ECHO", 21)]),
    });
    await renderWithRouter("/tasks?projects=DELTA,ECHO", transport);
    expect(blocksUnderHeading()).toEqual(["ECHO is not a project"]);

    replies["/projects"] = successReply([DELTA, { tag: "ECHO" }, SAGA]);
    await poll();

    await vi.waitFor(() => {
      expect(titlesIn("Backlog")).toEqual(["Task 21"]);
    });
    expect(screen.queryByRole("note")).toBeNull();
    await vi.waitFor(() => {
      expect(words).toEqual(["ECHO loaded."]);
    });
  });

  it("shows the old cards of a failing project whose next poll gets no answer, with no word that it loaded", async () => {
    const words = recordAnnounced();
    const { transport, replies } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);
    replies["/projects/SAGA/tasks"] = INVALID;
    await poll();
    await vi.waitFor(() => {
      expect(screen.queryByText("Task 1")).toBeNull();
    });

    replies["/projects/SAGA/tasks"] = { status: 502 };
    replies["/projects/DELTA/tasks"] = { status: 502 };
    await poll();

    await vi.waitFor(() => {
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    });
    expect(screen.queryByRole("note")).toBeNull();
    expect(useNoticeStore.getState().notices).toEqual([]);

    await poll();
    expect(useNoticeStore.getState().notices.map(({ key }) => key)).toEqual(["board-poll:DELTA,SAGA"]);

    replies["/projects/SAGA/tasks"] = listing([entry(1)]);
    replies["/projects/DELTA/tasks"] = listing([delta(11, { status: "Review" })]);
    await poll();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(words).not.toContain("SAGA loaded.");
  });

  it("starts no load on a poll of an unchanged project list of all projects with a refused project", async () => {
    const { transport } = twoProjects({ "/projects/SAGA": INVALID });
    const router = await renderWithRouter("/tasks?projects=all", transport);
    const invalidate = vi.spyOn(router, "invalidate");

    await poll();
    await poll();

    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 2, name: "SAGA did not load" })).toBeTruthy();
  });

  it("changes only the filter result on a label change, and only the board state on a poll that changes a warning", async () => {
    const { transport, replies } = twoProjects({ "/projects/SAGA/tasks": listing([entry(1, { labels: ["web"] }), entry(2)]) });
    const router = await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);
    const state = boardStateRegion();
    const filter = filterRegion();
    const stateChanges = watch(state);
    const filterChanges = watch(filter);

    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "DELTA,SAGA", labels: "web" } });
    });
    await vi.waitFor(() => {
      expect(filter.textContent).toBe("1 of 2 tasks carry a selected label.");
    });
    expect(stateChanges()).toBe(0);
    const filterChanged = filterChanges();

    replies["/projects/SAGA/tasks"] = listing([entry(1, { labels: ["web"] }), entry(2)], [], [BLOCKER]);
    await poll();

    await vi.waitFor(() => {
      expect(state.textContent).toBe("1 warning about SAGA.");
    });
    expect(filterChanges()).toBe(filterChanged);
  });

  describe("the general notice on the board of all projects", () => {
    async function failTwice() {
      const { transport, replies } = twoProjects({ "/projects": successReply([SAGA]) });
      await renderWithRouter("/tasks?projects=all", transport);

      replies["/projects/SAGA/tasks"] = { status: 502 };
      await poll();
      await poll();
      expect(useNoticeStore.getState().notices.map(({ key }) => key)).toEqual(["board-poll:all"]);
      return replies;
    }

    it("stays open when a project joins before the project whose reads fail", async () => {
      const replies = await failTwice();
      let closed = false;
      onTestFinished(useNoticeStore.subscribe(({ notices }) => {
        closed ||= notices.length === 0;
      }));

      replies["/projects"] = successReply(SORTED);
      await poll();
      await vi.waitFor(() => {
        expect(columnNames()).toEqual(MERGED);
      });
      await poll();

      expect(closed).toBe(false);
      expect(useNoticeStore.getState().notices.map(({ key }) => key)).toEqual(["board-poll:all"]);
    });

    it("stays closed after Dismiss when a project joins before the project whose reads fail", async () => {
      const replies = await failTwice();
      act(() => {
        useNoticeStore.getState().dismissNotice("board-poll:all");
      });

      replies["/projects"] = successReply(SORTED);
      await poll();
      await vi.waitFor(() => {
        expect(columnNames()).toEqual(MERGED);
      });
      await poll();
      await poll();

      expect(useNoticeStore.getState().notices).toEqual([]);
    });
  });
});

describe("the label filter", () => {
  async function openLabels(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await user.click(screen.getByRole("combobox", { name: /^Labels/ }));
    return screen.findByRole("listbox");
  }

  it("offers the labels of both projects, one label for each spelling without case", async () => {
    const user = userEvent.setup();
    const { transport } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1, { labels: ["web"] })]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "To Do", labels: ["Web", "api"] })]),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    const listbox = await openLabels(user);

    expect(within(listbox).getAllByRole("option").map((option) => option.textContent)).toEqual(["api1", "Web2"]);
  });

  it("filters the cards of both projects", async () => {
    const { transport } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1, { labels: ["web"] }), entry(2)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "To Do", labels: ["web"] }), delta(12, { status: "To Do" })]),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA&labels=web", transport);

    expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    expect(titlesIn("To Do")).toEqual(["Task 11"]);
    expect(filterResult()).toBe("2 of 4 tasks carry a selected label.");
    expect(boardState()).toBe("");
  });

  it("says no labels are in these projects", async () => {
    const user = userEvent.setup();
    const { transport } = twoProjects({ "/projects/SAGA/tasks": listing([entry(1)]) });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    await openLabels(user);

    expect(screen.getByText(/^No labels in these projects/)).toBeTruthy();
  });
});

describe("moving a card", () => {
  async function pick(title: string, name: string, role: "menuitem" | "menuitemradio") {
    const user = userEvent.setup();
    await user.click(menuButton(title));
    const menu = await screen.findByRole("menu");
    await act(async () => {
      await user.click(within(menu).getByRole(role, { name }));
    });
  }

  it("writes to the project of the moved card and of the neighbour it renumbers, and shows both writes", async () => {
    const neighbour = heldBack();
    const { transport, requests } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1, { status: "To Do" }), entry(3, { status: "To Do" })]),
      "/projects/DELTA/tasks": listing([delta(2, { status: "To Do" })]),
      "PATCH /projects/DELTA/tasks/DELTA-2": neighbour.reply,
      "PATCH /projects/SAGA/tasks/SAGA-1": heldBack().reply,
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);
    expect(titlesIn("To Do")).toEqual(["Task 1", "Task 2", "Task 3"]);

    await pick("Task 1", "Move down", "menuitem");

    expect(patches(requests)).toEqual([["/projects/DELTA/tasks/DELTA-2", { order: 0 }]]);
    expect(titlesIn("To Do")).toEqual(["Task 2", "Task 1", "Task 3"]);
    expect(["Task 1", "Task 2", "Task 3"].map((title) => card(title).hasAttribute("aria-busy"))).toEqual([true, true, false]);

    await act(async () => {
      neighbour.answer(successReply({ id: "DELTA-2" }));
    });

    await vi.waitFor(() => {
      expect(patches(requests)).toEqual([
        ["/projects/DELTA/tasks/DELTA-2", { order: 0 }],
        ["/projects/SAGA/tasks/SAGA-1", { order: 1000 }],
      ]);
    });
  });

  it("offers in the menu of a card only the statuses of the card's own project", async () => {
    const user = userEvent.setup();
    const { transport } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1, { status: "To Do" })]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "To Do" })]),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    await user.click(menuButton("Task 1"));
    const sagaMenu = await screen.findByRole("menu");
    expect(within(sagaMenu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(CONFIG.statuses);
    await user.keyboard("{Escape}");

    await user.click(menuButton("Task 11"));
    const deltaMenu = await screen.findByRole("menu");
    expect(within(deltaMenu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(OTHER_CONFIG.statuses);
  });

  it("moves a card to a status of its own project from the menu", async () => {
    const { transport, requests } = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "To Do" })]),
      "PATCH /projects/DELTA/tasks/DELTA-11": heldBack().reply,
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    await pick("Task 11", "Review", "menuitemradio");

    expect(patches(requests)).toEqual([["/projects/DELTA/tasks/DELTA-11", { status: "Review", order: 0 }]]);
    expect(titlesIn("Review")).toEqual(["Task 11"]);
  });
});

describe("the texts of a board of several projects", () => {
  const MISSING: Diagnostic = { code: "path-missing", message: "the repository is not on disk", path: "/repos/delta" };
  const BLOCKER: Diagnostic = { code: "blocked-by-unresolved", message: "SAGA-9 names no task", path: "/p/SAGA-1.md" };
  const EXCLUDED: ExcludedFile = { path: "/repos/saga/tasks/SAGA-7.md", code: "task-file-unreadable", message: "no frontmatter" };

  function warningLines(): (string | null)[] {
    return screen.getAllByRole("heading", { level: 2, name: /warning/ }).map((line) => line.textContent);
  }

  it("says these projects have no tasks yet", async () => {
    const { transport } = twoProjects();
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    expect(screen.getByText("No tasks in these projects yet.")).toBeTruthy();
  });

  it("says no task in these projects carries a selected label", async () => {
    const { transport } = twoProjects({ "/projects/SAGA/tasks": listing([entry(1)]) });
    await renderWithRouter("/tasks?projects=DELTA,SAGA&labels=web", transport);

    expect(screen.getByText("No task in these projects carries any of the selected labels.")).toBeTruthy();
  });

  it("shows a warnings line for each project, with the excluded files of the project in its own line", async () => {
    const user = userEvent.setup();
    const { transport } = twoProjects({
      "/projects/DELTA": successReply({ ...DELTA, live: true, config: OTHER_CONFIG }, [MISSING, BLOCKER]),
      "/projects/SAGA/tasks": listing([entry(1)], [EXCLUDED]),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    expect(warningLines()).toEqual(["2 warnings about DELTA", "1 warning about SAGA"]);
    expect(boardState()).toBe("2 warnings about DELTA. 1 warning about SAGA.");

    await user.click(screen.getByRole("button", { name: "Show 1 warning about SAGA" }));

    expect(screen.getByRole("list", { name: "1 warning about SAGA" }).textContent).toBe(
      "task-file-unreadableThe file was not read: no frontmatter/repos/saga/tasks/SAGA-7.md",
    );
  });

  it("shows an index note for each project that is not live, with its tag", async () => {
    const { transport } = twoProjects({
      "/projects/DELTA": successReply({ ...DELTA, live: false, config: OTHER_CONFIG }),
      "/projects/SAGA": successReply({ ...SAGA, live: false, config: CONFIG }),
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    expect(blocksUnderHeading()).toEqual([
      "The index of DELTA is not following the disk",
      "The index of SAGA is not following the disk",
    ]);
    expect(boardState()).toBe("The index of DELTA is not following the disk. The index of SAGA is not following the disk.");
  });

  it("shows the notes of the failed projects, then the index notes, then the warnings lines, each in board order", async () => {
    const { transport } = twoProjects({
      "/projects": successReply([DELTA, { tag: "ECHO" }, SAGA]),
      "/projects/DELTA": successReply({ ...DELTA, live: false, config: OTHER_CONFIG }, [MISSING]),
      "/projects/ECHO": successReply({ tag: "ECHO", live: false, config: CONFIG }, [BLOCKER]),
      "/projects/ECHO/tasks": listing([]),
      "/projects/SAGA": INVALID,
    });
    await renderWithRouter("/tasks?projects=SAGA,ECHO,DELTA,NOPE", transport);

    expect(blocksUnderHeading()).toEqual([
      "NOPE is not a project",
      "SAGA did not load",
      "The index of DELTA is not following the disk",
      "The index of ECHO is not following the disk",
      "1 warning about DELTA",
      "1 warning about ECHO",
    ]);
    expect(boardState()).toBe(
      "NOPE is not a project. SAGA did not load. "
      + "The index of DELTA is not following the disk. The index of ECHO is not following the disk. "
      + "1 warning about DELTA. 1 warning about ECHO.",
    );
  });

  it("gives the first note mt-6 and each later block mt-3", async () => {
    const { transport } = twoProjects({
      "/projects/DELTA": successReply({ ...DELTA, live: false, config: OTHER_CONFIG }, [MISSING]),
      "/projects/SAGA": INVALID,
    });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    const [failure, index] = screen.getAllByRole("note");
    expect(failure!.className).toContain("mt-6");
    expect(index!.className).toContain("mt-3");
    expect(screen.getByRole("heading", { level: 2, name: /warning/ }).parentElement?.parentElement?.className).toBe("mt-3");
  });

  it("gives a warnings line that is the first block mt-4", async () => {
    const { transport } = twoProjects({ "/projects/DELTA": successReply({ ...DELTA, live: true, config: OTHER_CONFIG }, [MISSING]) });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    expect(screen.getByRole("heading", { level: 2, name: /warning/ }).parentElement?.parentElement?.className).toBe("mt-4");
  });
});

describe("the controls of a board of several projects", () => {
  it("shows no search field, no New task and no plus, and asks for no search of a q in the address", async () => {
    const { transport, paths } = twoProjects({ "/projects/SAGA/tasks": listing([entry(1)]) });
    await renderWithRouter("/tasks?projects=DELTA,SAGA&q=parser", transport);

    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^New task in / })).toEqual([]);
    expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    expect(paths.filter((path) => path.includes("?q="))).toEqual([]);
  });

  it("shows the first project of the board in the picker, and a pick opens one project", async () => {
    const user = userEvent.setup();
    const { transport } = twoProjects();
    const router = await renderWithRouter("/tasks?projects=SAGA,DELTA&labels=web", transport);

    await user.click(screen.getByRole("button", { name: "Project Delta DELTA" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Saga/ }));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ projects: "SAGA" });
    });
  });

  it("does not save the last selection", async () => {
    const { transport } = twoProjects();
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    expect(window.localStorage.getItem("tasma.tasks.project")).toBeNull();
    expect(useUiStore.getState().lastTasksProject).toBeNull();
  });

  it("keeps Show all of a final column to its own board", async () => {
    const user = userEvent.setup();
    const done = Array.from({ length: 25 }, (_, index) => entry(index + 1, { status: "Done" }));
    const { transport } = twoProjects({ "/projects/SAGA/tasks": listing(done) });
    const router = await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(titlesIn("Done")).toHaveLength(25);

    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "SAGA" } });
    });

    expect(titlesIn("Done")).toHaveLength(20);
  });
});

describe("the board a card was opened from", () => {
  const SCROLL_X = 40;
  const SCROLL_Y = 1200;

  function boardDaemon() {
    return twoProjects({
      "/projects/SAGA/tasks": listing([entry(2, { labels: ["web"] })]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "To Do", labels: ["web"] })]),
      "/projects/SAGA/tasks/SAGA-2": successReply({ frontmatter: entry(2, { labels: ["web"] }).frontmatter, body: "", comments: [] }),
    });
  }

  function watchScroll() {
    const scrollTo = vi.fn<(...args: unknown[]) => void>();

    vi.stubGlobal("scrollTo", scrollTo);
    vi.stubGlobal("scrollX", SCROLL_X);
    vi.stubGlobal("scrollY", SCROLL_Y);

    return scrollTo;
  }

  function restoredTo(scrollTo: ReturnType<typeof watchScroll>): unknown[] | null {
    return scrollTo.mock.calls.filter((call) => call.length === 2).at(-1) ?? null;
  }

  async function nextFrame(): Promise<void> {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  }

  it("leads back to the task's own project, without the labels and the scroll of the merged board", async () => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=DELTA,SAGA&labels=web", transport);

    await user.click(cardLink("Task 2"));
    expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-2");
    expect(useUiStore.getState().boardReturn).toMatchObject({ projects: "DELTA,SAGA", labels: "web", taskId: "SAGA-2" });

    await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    await nextFrame();

    expect(router.state.location.search).toEqual({ projects: "SAGA" });
    expect(restoredTo(scrollTo)).toBeNull();
  });

  it("puts the merged board back after the browser Back button", async () => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=SAGA,DELTA&labels=web", transport);

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
});
