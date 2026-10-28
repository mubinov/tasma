import type { Diagnostic, ExcludedFile, FeedEvent, Frontmatter, TaskEntry } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { daemonKeys } from "../../src/api/queries";
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
import {
  countReads,
  heldBack,
  openWithFeed,
  projectEvent,
  refusalReply,
  renderWithRouter,
  startWithFeed,
  successReply,
  taskEvent,
  type FeedStub,
} from "../helpers";
import { frame } from "../setup/notice-store";
import { backLink, topBar } from "../task-screen-fixtures";

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

/** The events, the retry of an unreadable answer, and the notification of the cache. */
async function sendAndWaitPastRetry(feed: FeedStub, events: FeedEvent[]) {
  await feed.send(events);
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
    lastBoard: null,
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
      + "The board shows the other projects, and shows SAGA again when SAGA changes on disk."
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
    expect(screen.getByRole("searchbox", { name: "Search" })).toBeTruthy();
    expect(screen.getByText("No tasks in these projects yet.")).toBeTruthy();
    expect(window.localStorage.getItem("tasma.tasks.project")).toBe("DELTA,SAGA");
    expect(useUiStore.getState().lastTasksProject).toBe("DELTA,SAGA");
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

  it("shows the failure screen with the refusal of the first project and the projects of the address in the picker when every project is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = refusalReply(422, { kind: "store", code: "project-invalid", message: "config.yml is broken" });
    const { transport } = twoProjects({ "/projects/DELTA": INVALID, "/projects/SAGA/tasks": broken });
    await renderWithRouter("/tasks?projects=SAGA,DELTA", transport);

    expect(screen.getByRole("alert").textContent).toContain("store/config-invalid");
    expect(screen.getByRole("alert").textContent).not.toContain("config.yml is broken");
    expect(screen.getByRole("combobox", { name: "Project Delta, Saga" })).toBeTruthy();
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

  it("shows the failure screen with All projects in the picker when all projects are refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport } = twoProjects({ "/projects/SAGA": INVALID, "/projects/DELTA/tasks": INVALID });
    await renderWithRouter("/tasks?projects=all", transport);

    expect(screen.getByRole("alert").textContent).toContain("store/config-invalid");
    expect(screen.getByRole("combobox", { name: "Project All projects" })).toBeTruthy();
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

  it("shows a project added to the tree after an event, and leaves out a project removed from it", async () => {
    const stub = twoProjects({
      "/projects": successReply([SAGA]),
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    const { router, feed } = await openWithFeed("/tasks?projects=all", stub);
    expect(columnNames()).toEqual(CONFIG.statuses);

    stub.replies["/projects"] = successReply(SORTED);
    await sendAndWaitPastRetry(feed, [projectEvent("DELTA", "created")]);
    await vi.waitFor(() => {
      expect(titlesIn("Review")).toEqual(["Task 11"]);
    });
    expect(columnNames()).toEqual(MERGED);

    stub.replies["/projects"] = successReply([DELTA]);
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA", "deleted")]);
    await vi.waitFor(() => {
      expect(columnNames()).toEqual(OTHER_CONFIG.statuses);
    });
    expect(screen.queryByText("Task 1")).toBeNull();
    expect(router.state.location.search).toEqual({ projects: "all" });
  });

  it("shows the empty-tree screen on an empty tree, and the board of all projects when a project appears", async () => {
    const stub = twoProjects({ "/projects": successReply([]) });
    const { router, feed } = await openWithFeed("/tasks?projects=all", stub);
    expect(screen.getByText(/^No projects yet/)).toBeTruthy();

    stub.replies["/projects"] = successReply([SAGA]);
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA", "created")]);

    await vi.waitFor(() => {
      expect(screen.getByText("No tasks in these projects yet.")).toBeTruthy();
    });
    expect(router.state.location.search).toEqual({ projects: "all" });
  });

  it("shows a project that joins when a label click comes while the load that reads it runs", async () => {
    const user = userEvent.setup({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) });
    const listingRead = heldBack();
    const stub = twoProjects({
      "/projects": successReply([SAGA]),
      "/projects/SAGA/tasks": listing([entry(1, { labels: ["web"] })]),
      "/projects/DELTA/tasks": listingRead.reply,
    });
    const { router, feed } = await openWithFeed("/tasks?projects=all", stub);

    stub.replies["/projects"] = successReply(SORTED);
    await sendAndWaitPastRetry(feed, [projectEvent("DELTA", "created")]);
    await user.click(screen.getByRole("combobox", { name: /^Labels/ }));
    await user.click(await screen.findByRole("option", { name: /web/ }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ projects: "all", labels: "web" });
    });

    await act(async () => {
      listingRead.answer(listing([delta(11, { status: "Review", labels: ["web"] })]));
    });

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

    it("stays where it is when a project joins after an event, and goes to the top on a label change", async () => {
      const stub = twoProjects({
        "/projects": successReply([SAGA]),
        "/projects/SAGA/tasks": listing([entry(1)]),
        "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
      });
      const { router, feed } = await openWithFeed("/tasks?projects=all", stub);
      const scrollTo = stubWindowScroll(600);

      stub.replies["/projects"] = successReply(SORTED);
      await sendAndWaitPastRetry(feed, [projectEvent("DELTA", "created")]);
      await vi.waitFor(() => {
        expect(titlesIn("Review")).toEqual(["Task 11"]);
      });
      const reads = countReads(stub, "/projects/DELTA/tasks");
      await sendAndWaitPastRetry(feed, [projectEvent("DELTA")]);

      expect(reads()).toBeGreaterThan(0);
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
      const stub = twoProjects({
        "/projects": successReply([SAGA]),
        "/projects/SAGA/tasks": listing([entry(1, { status: "In Progress" }), ...done]),
        "/projects/DELTA/tasks": listing([delta(2, { status: "Review" })]),
      });
      const { feed } = await openWithFeed("/tasks?projects=all", stub);
      await user.click(screen.getByRole("button", { name: "Show all" }));
      await focusOn(cardLink("Task 1"));

      stub.replies["/projects"] = successReply(SORTED);
      await sendAndWaitPastRetry(feed, [projectEvent("DELTA", "created")]);
      await vi.waitFor(() => {
        expect(columnNames()).toEqual(MERGED);
      });

      expect(document.activeElement).toBe(cardLink("Task 1"));
      expect(titlesIn("Done")).toHaveLength(25);
    });

    it("stays on a card when a project leaves and takes a column before it", async () => {
      const stub = twoProjects({
        "/projects/SAGA/tasks": listing([entry(1, { status: "In Progress" })]),
        "/projects/DELTA/tasks": listing([delta(2, { status: "Review" })]),
      });
      const { feed } = await openWithFeed("/tasks?projects=all", stub);
      await focusOn(cardLink("Task 1"));

      stub.replies["/projects"] = successReply([SAGA]);
      await sendAndWaitPastRetry(feed, [projectEvent("DELTA", "deleted")]);
      await vi.waitFor(() => {
        expect(columnNames()).toEqual(CONFIG.statuses);
      });

      expect(document.activeElement).toBe(cardLink("Task 1"));
    });

    it("goes to the heading of the column of a focused card whose project leaves", async () => {
      const stub = twoProjects({
        "/projects/DELTA": project("DELTA", { config: TRIAGE_CONFIG }),
        "/projects/SAGA/tasks": listing([entry(1)]),
        "/projects/DELTA/tasks": listing([delta(2, { status: "To Do" })]),
      });
      const { feed } = await openWithFeed("/tasks?projects=all", stub);
      expect(columnNames()).toEqual(["Triage", "Backlog", "To Do", "In Progress", "Done"]);
      await focusOn(cardLink("Task 2"));

      stub.replies["/projects"] = successReply([SAGA]);
      await sendAndWaitPastRetry(feed, [projectEvent("DELTA", "deleted")]);

      await vi.waitFor(() => {
        expect(document.activeElement).toBe(columnHeading("To Do"));
      });
    });

    it("goes to the heading of the column at the old place when the card's column left with its project", async () => {
      const stub = twoProjects({
        "/projects/SAGA/tasks": listing([entry(1)]),
        "/projects/DELTA/tasks": listing([delta(2, { status: "Review" })]),
      });
      const { feed } = await openWithFeed("/tasks?projects=all", stub);
      await focusOn(cardLink("Task 2"));

      stub.replies["/projects"] = successReply([SAGA]);
      await sendAndWaitPastRetry(feed, [projectEvent("DELTA", "deleted")]);

      await vi.waitFor(() => {
        expect(document.activeElement).toBe(columnHeading("In Progress"));
      });
    });

    it("goes to the heading of the column at the old place when a focused heading's column leaves with its project", async () => {
      const stub = twoProjects({ "/projects/DELTA/tasks": listing([delta(2, { status: "Review" })]) });
      const { feed } = await openWithFeed("/tasks?projects=all", stub);
      await focusOn(columnHeading("Review"));

      stub.replies["/projects"] = successReply([SAGA]);
      await sendAndWaitPastRetry(feed, [projectEvent("DELTA", "deleted")]);

      await vi.waitFor(() => {
        expect(document.activeElement).toBe(columnHeading("In Progress"));
      });
    });

    it("goes to the heading of the column at the old place when Show all leaves with its project", async () => {
      const closed = Array.from({ length: 25 }, (_, index) => delta(index + 1, { status: "Closed" }));
      const stub = twoProjects({
        "/projects/DELTA": project("DELTA", {
          config: { ...OTHER_CONFIG, statuses: ["To Do", "Review", "Closed"], final_statuses: ["Closed"] },
        }),
        "/projects/DELTA/tasks": listing(closed),
      });
      const { feed } = await openWithFeed("/tasks?projects=all", stub);
      expect(columnNames()).toEqual(["Backlog", "To Do", "Review", "Closed", "In Progress", "Done"]);
      await focusOn(screen.getByRole("button", { name: "Show all" }));

      stub.replies["/projects"] = successReply([SAGA]);
      await sendAndWaitPastRetry(feed, [projectEvent("DELTA", "deleted")]);

      await vi.waitFor(() => {
        expect(document.activeElement).toBe(columnHeading("Done"));
      });
    });

    it("goes to the main region when the last project leaves", async () => {
      const stub = twoProjects({
        "/projects": successReply([SAGA]),
        "/projects/SAGA/tasks": listing([entry(1)]),
      });
      const { feed } = await openWithFeed("/tasks?projects=all", stub);
      await focusOn(cardLink("Task 1"));

      stub.replies["/projects"] = successReply([]);
      await sendAndWaitPastRetry(feed, [projectEvent("SAGA", "deleted")]);

      await vi.waitFor(() => {
        expect(screen.getByText(/^No projects yet/)).toBeTruthy();
      });
      expect(document.activeElement).toBe(screen.getByRole("main"));
    });
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

  it("takes out the cards of a project a read refuses, and brings them back when a read succeeds", async () => {
    const words = recordAnnounced();
    const stub = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1, { status: "To Do" })]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    const { feed } = await openWithFeed("/tasks?projects=DELTA,SAGA", stub);
    await focusOn(cardLink("Task 1"));

    stub.replies["/projects/SAGA/tasks"] = INVALID;
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(columnHeading("To Do"));
    });
    expect(screen.queryByText("Task 1")).toBeNull();
    expect(columnNames()).toEqual(OTHER_CONFIG.statuses);
    expect(screen.getByRole("note").textContent).toContain("store/config-invalid · statuses is empty");
    expect(boardState()).toBe("SAGA did not load.");
    const reads = countReads(stub, "/projects/SAGA/tasks");
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);
    expect(reads()).toBeGreaterThan(0);
    expect(useNoticeStore.getState().notices).toEqual([]);
    expect(words.filter((said) => said.includes("is not up to date"))).toEqual([]);

    stub.replies["/projects/SAGA/tasks"] = listing([entry(1, { status: "To Do" })]);
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);

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
    const stub = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1, { status: "To Do" })]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    const { feed } = await openWithFeed("/tasks?projects=DELTA,SAGA", stub);
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

    stub.replies["/projects/SAGA/tasks"] = INVALID;
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);

    await vi.waitFor(() => {
      expect(boardState()).toBe("SAGA did not load.");
    });
    expect(document.activeElement).toBe(columnHeading("To Do"));
    expect(saidAtFocus).toEqual([""]);
  });

  it("keeps the status regions out of what the delete dialog hides, and hides a block that a read adds", async () => {
    const user = userEvent.setup({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) });
    const stub = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    const { feed } = await openWithFeed("/tasks?projects=DELTA,SAGA", stub);
    await user.click(menuButton("Task 11"));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Delete / }));
    await screen.findByRole("alertdialog");

    stub.replies["/projects/SAGA/tasks"] = INVALID;
    stub.replies["/projects/DELTA/tasks"] = listing([delta(11, { status: "Review" })], [], [BLOCKER]);
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA"), taskEvent("DELTA-11")]);

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
    const stub = twoProjects({ "/projects/SAGA/tasks": listing([entry(1)]) });
    const { feed } = await openWithFeed("/tasks?projects=SAGA", stub);
    await user.click(menuButton("Task 1"));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Delete / }));
    const dialog = await screen.findByRole("alertdialog");

    stub.replies["/projects/SAGA/tasks"] = INVALID;
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);
    await focusOn(screen.getByRole("button", { name: "Dismiss" }));

    const words = recordAnnounced();
    stub.replies["/projects/SAGA/tasks"] = listing([entry(1)]);
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);

    await vi.waitFor(() => {
      expect(useNoticeStore.getState().notices).toEqual([]);
    });
    expect(document.activeElement).toBe(dialog);
    await vi.waitFor(() => {
      expect(words).toContain("The board is up to date.");
    });
  });

  it("shows no column and gives the focus to the main region when a read refuses every project", async () => {
    const stub = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    const { feed } = await openWithFeed("/tasks?projects=DELTA,SAGA", stub);
    await focusOn(cardLink("Task 11"));

    stub.replies["/projects/SAGA"] = INVALID;
    stub.replies["/projects/DELTA"] = INVALID;
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA"), projectEvent("DELTA")]);

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("main"));
    });
    expect(columnNames()).toEqual([]);
    expect(screen.queryByText("No tasks in these projects yet.")).toBeNull();
    expect(blocksUnderHeading()).toEqual(["DELTA did not load", "SAGA did not load"]);

    stub.replies["/projects/DELTA"] = project("DELTA", { config: OTHER_CONFIG });
    await sendAndWaitPastRetry(feed, [projectEvent("DELTA")]);
    await vi.waitFor(() => {
      expect(titlesIn("Review")).toEqual(["Task 11"]);
    });
    await focusOn(cardLink("Task 11"));

    stub.replies["/projects/DELTA/tasks"] = listing([]);
    await sendAndWaitPastRetry(feed, [taskEvent("DELTA-11", "deleted")]);

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(columnHeading("Review"));
    });
  });

  it("gives the focus to the main region after a delete confirmed when no column is left", async () => {
    const user = userEvent.setup({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) });
    const stub = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
      "DELETE /projects/DELTA/tasks/DELTA-11": heldBack().reply,
    });
    const { feed } = await openWithFeed("/tasks?projects=DELTA,SAGA", stub);
    await user.click(menuButton("Task 11"));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Delete / }));
    const dialog = await screen.findByRole("alertdialog");

    stub.replies["/projects/SAGA"] = INVALID;
    stub.replies["/projects/DELTA"] = INVALID;
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA"), projectEvent("DELTA")]);
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
    const stub = twoProjects({
      "/projects/SAGA": INVALID,
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    const { feed } = await openWithFeed("/tasks?projects=DELTA,SAGA", stub);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(words).toEqual([]);

    stub.replies["/projects/SAGA"] = project("SAGA");
    stub.replies["/projects/SAGA/tasks"] = listing([entry(1)]);
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);

    await vi.waitFor(() => {
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    });
    expect(screen.queryByRole("note")).toBeNull();
    await vi.waitFor(() => {
      expect(words).toEqual(["SAGA loaded."]);
    });
  });

  it("brings back a project refused at the load that changes while its read is on its way", async () => {
    const words = recordAnnounced();
    const projectRead = heldBack();
    const stub = twoProjects({
      "/projects/SAGA": projectRead.reply,
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    const { feed } = await startWithFeed("/tasks?projects=DELTA,SAGA", stub);
    await vi.waitFor(() => {
      expect(stub.paths).toContain("/projects/SAGA");
    });

    stub.replies["/projects/SAGA"] = project("SAGA");
    stub.replies["/projects/SAGA/tasks"] = listing([entry(1)]);
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);
    await act(async () => {
      projectRead.answer(INVALID);
    });

    await vi.waitFor(() => {
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    });
    expect(screen.queryByRole("note")).toBeNull();
    await vi.waitFor(() => {
      expect(words).toEqual(["SAGA loaded."]);
    });
  });

  it("brings back a project refused at the load that changes before the board shows it", async () => {
    const words = recordAnnounced();
    const listingRead = heldBack();
    const stub = twoProjects({ "/projects/SAGA": INVALID, "/projects/DELTA/tasks": listingRead.reply });
    const { router, feed } = await startWithFeed("/tasks?projects=DELTA,SAGA", stub);
    const { queryClient } = router.options.context;
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(daemonKeys.project("SAGA"))?.status).toBe("error");
    });

    stub.replies["/projects/SAGA"] = project("SAGA");
    stub.replies["/projects/SAGA/tasks"] = listing([entry(1)]);
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);
    await act(async () => {
      listingRead.answer(listing([delta(11, { status: "Review" })]));
    });

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
    const stub = twoProjects({ "/projects/SAGA": INVALID, "/workflows/dev": workflowRead.reply });
    const { feed } = await openWithFeed("/tasks?projects=DELTA,SAGA", stub);

    stub.replies["/projects/SAGA"] = project("SAGA");
    stub.replies["/projects/SAGA/tasks"] = listing([entry(1, { workflow: "dev", step: "approve" })]);
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);

    await vi.waitFor(() => {
      expect(screen.getByRole("note").textContent).toBe(
        "SAGA did not loadThe board shows the other projects, and shows SAGA again when SAGA changes on disk.",
      );
    });

    await act(async () => {
      workflowRead.answer(successReply(WORKFLOW));
    });
    await vi.waitFor(() => {
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    });
  });

  it("shows a tag the project list did not hold once a read of the list holds it, and says so", async () => {
    const words = recordAnnounced();
    const stub = twoProjects({
      "/projects/ECHO": project("ECHO"),
      "/projects/ECHO/tasks": listing([taggedEntry("ECHO", 21)]),
    });
    const { feed } = await openWithFeed("/tasks?projects=DELTA,ECHO", stub);
    expect(blocksUnderHeading()).toEqual(["ECHO is not a project"]);

    stub.replies["/projects"] = successReply([DELTA, { tag: "ECHO" }, SAGA]);
    await sendAndWaitPastRetry(feed, [projectEvent("ECHO", "created")]);

    await vi.waitFor(() => {
      expect(titlesIn("Backlog")).toEqual(["Task 21"]);
    });
    expect(screen.queryByRole("note")).toBeNull();
    await vi.waitFor(() => {
      expect(words).toEqual(["ECHO loaded."]);
    });
  });

  it("shows the old cards of a failing project whose next read gets no answer, with no word that it loaded", async () => {
    const words = recordAnnounced();
    const stub = twoProjects({
      "/projects/SAGA/tasks": listing([entry(1)]),
      "/projects/DELTA/tasks": listing([delta(11, { status: "Review" })]),
    });
    const { feed } = await openWithFeed("/tasks?projects=DELTA,SAGA", stub);
    stub.replies["/projects/SAGA/tasks"] = INVALID;
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);
    await vi.waitFor(() => {
      expect(screen.queryByText("Task 1")).toBeNull();
    });

    stub.replies["/projects/SAGA/tasks"] = { status: 502 };
    stub.replies["/projects/DELTA/tasks"] = { status: 502 };
    await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1"), taskEvent("DELTA-11")]);

    await vi.waitFor(() => {
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    });
    expect(screen.queryByRole("note")).toBeNull();
    expect(useNoticeStore.getState().notices).toEqual([]);

    const sagaReads = countReads(stub, "/projects/SAGA/tasks");
    const deltaReads = countReads(stub, "/projects/DELTA/tasks");
    await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1"), taskEvent("DELTA-11")]);
    expect(sagaReads()).toBeGreaterThan(0);
    expect(deltaReads()).toBeGreaterThan(0);
    expect(useNoticeStore.getState().notices).toEqual([]);

    stub.replies["/projects/SAGA/tasks"] = listing([entry(1)]);
    stub.replies["/projects/DELTA/tasks"] = listing([delta(11, { status: "Review" })]);
    await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1"), taskEvent("DELTA-11")]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(sagaReads()).toBeGreaterThan(0);
    expect(words).not.toContain("SAGA loaded.");
  });

  it("starts no load on a read of an unchanged project list of all projects with a refused project", async () => {
    const stub = twoProjects({ "/projects/SAGA": INVALID });
    const { router, feed } = await openWithFeed("/tasks?projects=all", stub);
    const invalidate = vi.spyOn(router, "invalidate");
    const reads = countReads(stub, "/projects");

    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);
    expect(reads()).toBeGreaterThan(0);
    await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);
    expect(reads()).toBeGreaterThan(0);

    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 2, name: "SAGA did not load" })).toBeTruthy();
  });

  it("changes only the filter result on a label change, and only the board state on a read that changes a warning", async () => {
    const stub = twoProjects({ "/projects/SAGA/tasks": listing([entry(1, { labels: ["web"] }), entry(2)]) });
    const { router, feed } = await openWithFeed("/tasks?projects=DELTA,SAGA", stub);
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

    stub.replies["/projects/SAGA/tasks"] = listing([entry(1, { labels: ["web"] }), entry(2)], [], [BLOCKER]);
    await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1")]);

    await vi.waitFor(() => {
      expect(state.textContent).toBe("1 warning about SAGA.");
    });
    expect(filterChanges()).toBe(filterChanged);
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
  it("shows the search field, and no New task and no plus", async () => {
    const { transport } = twoProjects({ "/projects/SAGA/tasks": listing([entry(1)]) });
    await renderWithRouter("/tasks?projects=DELTA,SAGA", transport);

    expect(screen.getByRole("searchbox", { name: "Search" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^New task in / })).toEqual([]);
    expect(titlesIn("Backlog")).toEqual(["Task 1"]);
  });

  it("shows the names of the board in the picker, where a click removes a project and keeps the labels", async () => {
    const user = userEvent.setup();
    const { transport } = twoProjects();
    const router = await renderWithRouter("/tasks?projects=SAGA,DELTA&labels=web", transport);

    await user.click(screen.getByRole("combobox", { name: "Project Delta, Saga" }));
    const saga = await screen.findByRole("option", { name: /Saga/ });
    await act(async () => {
      await user.click(saga);
    });

    expect(router.state.location.search).toEqual({ projects: "DELTA", labels: "web" });
  });

  it.each([
    { path: "/tasks?projects=DELTA,SAGA", stored: "DELTA,SAGA" },
    { path: "/tasks?projects=all", stored: "all" },
    { path: "/tasks?projects=DELTA,NOPE", stored: "DELTA,NOPE" },
  ])("stores the board value of $path", async ({ path, stored }) => {
    const { transport } = twoProjects();
    await renderWithRouter(path, transport);

    expect(window.localStorage.getItem("tasma.tasks.project")).toBe(stored);
    expect(useUiStore.getState().lastTasksProject).toBe(stored);
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
      "/projects/SAGA/tasks/SAGA-2/chats": successReply([]),
      "/projects/DELTA/tasks/DELTA-11": successReply({
        frontmatter: delta(11, { status: "To Do", labels: ["web"] }).frontmatter,
        body: "",
        comments: [],
      }),
      "/projects/DELTA/tasks/DELTA-11/chats": successReply([]),
      "DELETE /projects/SAGA/tasks/SAGA-2": successReply({ id: "SAGA-2" }),
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

  it.each([
    { address: "/tasks?projects=DELTA,SAGA&labels=web", search: { projects: "DELTA,SAGA", labels: "web" } },
    { address: "/tasks?projects=all", search: { projects: "all" } },
  ])("leads back from $address with its labels, scrolled where it was, with the card in focus", async ({ address, search }) => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter(address, transport);

    await user.click(cardLink("Task 2"));
    expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-2");

    await user.click(backLink());

    expect(router.state.location.search).toEqual(search);
    await waitFor(() => {
      expect(restoredTo(scrollTo)).toEqual([SCROLL_X, SCROLL_Y]);
    });
    await nextFrame();
    expect(document.activeElement).toBe(cardLink("Task 2"));
  });

  it("puts the merged board back from a task page reached with no board visit after the card open", async () => {
    const user = userEvent.setup();
    const scrollTo = watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=DELTA,SAGA&labels=web", transport);

    await user.click(cardLink("Task 2"));
    await act(async () => {
      await router.navigate({ to: "/tasks/$project/$task", params: { project: "DELTA", task: "DELTA-11" } });
    });
    await user.click(backLink());

    expect(router.state.location.search).toEqual({ projects: "DELTA,SAGA", labels: "web" });
    await waitFor(() => {
      expect(restoredTo(scrollTo)).toEqual([SCROLL_X, SCROLL_Y]);
    });
    await nextFrame();
    expect(document.activeElement).toBe(cardLink("Task 2"));
  });

  it("replaces the task page with the merged board after a delete", async () => {
    const user = userEvent.setup();
    watchScroll();
    const { transport } = boardDaemon();
    const router = await renderWithRouter("/tasks?projects=DELTA,SAGA&labels=web", transport);

    await user.click(cardLink("Task 2"));
    const entries = router.history.length;
    await user.click(within(topBar()).getByRole("button", { name: "Task menu" }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Delete task" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    });
    expect(router.state.location.search).toEqual({ projects: "DELTA,SAGA", labels: "web" });
    expect(router.history.length).toBe(entries);
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
