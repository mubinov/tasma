import type { FeedEvent, TransportReply } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonKeys } from "../../src/api/queries";
import { BUSY_ANNOUNCE_DELAY } from "../../src/lib/use-board-search";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import {
  CONFIG,
  column,
  countOf,
  daemon,
  DELTA,
  entry,
  filterRegion,
  filterResult,
  listing,
  SAGA,
  taggedEntry,
  titlesIn,
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
import { backLink } from "../task-screen-fixtures";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    lastTasksProject: null,
    boardReturn: null,
    boardRestorePending: false,
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

describe("the search", () => {
  const ENTRIES = [
    entry(1, { labels: ["web"] }),
    entry(2, { labels: ["docs"] }),
    entry(3),
    entry(4, { status: "Done", labels: ["web"] }),
  ];
  const PARSER = "/projects/SAGA/tasks?q=parser";
  const DOCS = "/projects/SAGA/tasks?q=docs";
  const RELEASE = "/projects/SAGA/tasks?q=release";
  const UNREADABLE: TransportReply = { status: 502 };
  const REFUSED = refusalReply(422, { kind: "store", code: "project-invalid", message: "config.yml is broken" });
  const FAILED_LINE = "The search failed. The board shows all tasks.";

  function setUser() {
    return userEvent.setup({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) });
  }

  function searchDaemon(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
    return daemon({
      "/projects/SAGA/tasks": listing(ENTRIES),
      [PARSER]: listing([ENTRIES[0]!, ENTRIES[1]!]),
      [DOCS]: listing([ENTRIES[1]!]),
      [RELEASE]: listing([]),
      ...replies,
    });
  }

  function spinning(): boolean {
    return screen.getByRole("searchbox").parentElement!.querySelector("svg")!.classList.contains("animate-spin");
  }

  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }

  /** The retry of an unreadable answer, and the notification of the cache. */
  async function waitPastRetry() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_010);
    });
  }

  async function sendAndWaitPastRetry(feed: FeedStub, events: FeedEvent[]) {
    await feed.send(events);
    await waitPastRetry();
  }

  async function go(router: Awaited<ReturnType<typeof renderWithRouter>>, search: Record<string, string>) {
    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "SAGA", ...search } });
    });
    await settle();
  }

  const observers: MutationObserver[] = [];

  /** Called after the navigation, so the timer has started and fires. */
  async function advancePastDelay() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BUSY_ANNOUNCE_DELAY);
    });
  }

  /**
   * Records every text the status region takes from now on. `act` runs the
   * urgent and the deferred commit with no microtask between them, so the old
   * texts come from the mutation records, not from reads of the region.
   */
  function recordStatus(): () => string[] {
    const region = filterRegion();
    const texts: string[] = [];
    const take = (records: MutationRecord[]) => {
      for (const record of records) {
        texts.push(record.type === "characterData"
          ? record.oldValue ?? ""
          : [...record.removedNodes].map((node) => node.textContent).join(""));
      }
    };
    const observer = new MutationObserver(take);

    observer.observe(region, { childList: true, characterData: true, characterDataOldValue: true, subtree: true });
    observers.push(observer);

    return () => {
      take(observer.takeRecords());

      return [...texts, region.textContent ?? ""].filter((text, index, all) => index === 0 || text !== all[index - 1]);
    };
  }

  function textsFrom(texts: string[], first: string): string[] {
    return texts.slice(texts.indexOf(first));
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
  });

  afterEach(() => {
    for (const observer of observers.splice(0)) {
      observer.disconnect();
    }
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  describe("the address", () => {
    it("keeps q, and asks the daemon for the tasks that match it", async () => {
      const { transport, paths } = searchDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      expect(router.state.location.search).toEqual({ projects: "SAGA", q: "parser" });
      expect(paths).toContain(PARSER);
    });

    it.each([
      { what: "an empty q", search: "&q=" },
      { what: "a blank q", search: "&q=%20%20" },
    ])("reads $what as no search", async ({ search }) => {
      const { transport, paths } = searchDaemon();
      await renderWithRouter(`/tasks?projects=SAGA${search}`, transport);
      await settle();

      expect(paths.filter((path) => path.includes("?q="))).toEqual([]);
      expect(countOf("Backlog")).toBe("3");
      expect(filterResult()).toBe("");
    });

    it("asks with the text trimmed", async () => {
      const { transport, paths } = searchDaemon();
      await renderWithRouter("/tasks?projects=SAGA&q=%20parser%20", transport);
      await settle();

      expect(paths.filter((path) => path.includes("?q="))).toEqual([PARSER]);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2"]);
    });
  });

  describe("the board", () => {
    it("hides the cards the search does not give back, and counts every task", async () => {
      const { transport } = searchDaemon();
      await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      expect(CONFIG.statuses.map(countOf)).toEqual(["2 of 3", "0 of 0", "0 of 0", "0 of 1"]);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2"]);
      expect(filterResult()).toBe("2 of 4 tasks match \"parser\".");
    });

    it("shows a card only when it matches the search and carries a selected label", async () => {
      const user = setUser();
      const { transport } = searchDaemon();
      await renderWithRouter("/tasks?projects=SAGA&labels=web&q=parser", transport);
      await settle();

      expect(CONFIG.statuses.map(countOf)).toEqual(["1 of 3", "0 of 0", "0 of 0", "0 of 1"]);
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
      expect(filterResult()).toBe("1 of 4 tasks match \"parser\" and carry a selected label.");

      await user.click(screen.getByRole("combobox", { name: /^Labels/ }));
      const options = within(await screen.findByRole("listbox")).getAllByRole("option");
      const counts = options.map((option) => [option.childNodes[2]?.textContent, option.lastElementChild?.textContent]);
      expect(counts).toEqual([
        ["docs", "1"],
        ["web", "2"],
      ]);
    });

    it("says no task matches the search", async () => {
      const { transport } = searchDaemon();
      await renderWithRouter("/tasks?projects=SAGA&q=release", transport);
      await settle();

      expect(screen.getByText("No task in Saga matches the search.")).toBeTruthy();
      expect(filterResult()).toBe("0 of 4 tasks match \"release\".");
    });

    it("says no task matches the search and carries a selected label", async () => {
      const { transport } = searchDaemon();
      await renderWithRouter("/tasks?projects=SAGA&labels=web&q=docs", transport);
      await settle();

      expect(screen.getByText("No task in Saga matches the search and carries a selected label.")).toBeTruthy();
      expect(filterResult()).toBe("0 of 4 tasks match \"docs\" and carry a selected label.");
    });

    it("shows every card again when the search is cleared", async () => {
      const { transport } = searchDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      await go(router, {});

      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2", "Task 3"]);
      expect(countOf("Backlog")).toBe("3");
      expect(filterResult()).toBe("");
    });
  });

  describe("the wait", () => {
    /** The fake clock also moves with real time, so a wait ends at a time point, not after a duration. */
    async function advanceTo(time: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(Math.max(0, time - Date.now()));
      });
    }

    /** `start` is a clock read before the navigation, so the timer has not fired yet. */
    async function advanceToBeforeDelay(start: number) {
      await advanceTo(start + BUSY_ANNOUNCE_DELAY - 300);
    }

    it("keeps the old sentence while the request for a new text runs shorter than the delay", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [DOCS]: held.reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      const start = Date.now();
      await go(router, { q: "docs" });
      await advanceToBeforeDelay(start);

      expect(filterResult()).toBe("2 of 4 tasks match \"parser\".");
    });

    it("says the busy sentence after the delay, and then the result with no old sentence between", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [DOCS]: held.reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const record = recordStatus();

      await go(router, { q: "docs" });
      await advancePastDelay();
      expect(filterResult()).toBe("Searching for \"docs\".");

      await act(async () => {
        held.answer(listing([ENTRIES[1]!]));
      });
      await settle();
      expect(filterResult()).toBe("1 of 4 tasks match \"docs\".");
      expect(textsFrom(record(), "Searching for \"docs\".")).toEqual([
        "Searching for \"docs\".",
        "1 of 4 tasks match \"docs\".",
      ]);
    });

    it("says the busy sentence after the delay for a first search", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [PARSER]: held.reply });
      await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      expect(filterResult()).toBe("");

      await advancePastDelay();

      expect(filterResult()).toBe("Searching for \"parser\".");
    });

    it("says no busy sentence for an answer that comes before the delay", async () => {
      const { transport } = searchDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const record = recordStatus();

      await go(router, { q: "docs" });
      await advancePastDelay();

      expect(filterResult()).toBe("1 of 4 tasks match \"docs\".");
      expect(record().filter((text) => text.includes("Searching"))).toEqual([]);
    });

    it("says only the busy sentence while labels are selected", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [DOCS]: held.reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&labels=web&q=parser", transport);
      await settle();

      await go(router, { labels: "web", q: "docs" });
      await advancePastDelay();

      expect(filterResult()).toBe("Searching for \"docs\".");
    });

    it("keeps the busy sentence of the earlier text until a new text has run for the delay", async () => {
      const { transport } = searchDaemon({ [DOCS]: heldBack().reply, [RELEASE]: heldBack().reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const record = recordStatus();

      await go(router, { q: "docs" });
      await advancePastDelay();
      expect(filterResult()).toBe("Searching for \"docs\".");

      const start2 = Date.now();
      await go(router, { q: "release" });
      await advanceToBeforeDelay(start2);
      expect(filterResult()).toBe("Searching for \"docs\".");

      await advancePastDelay();
      expect(filterResult()).toBe("Searching for \"release\".");
      expect(textsFrom(record(), "Searching for \"docs\".")).toEqual([
        "Searching for \"docs\".",
        "Searching for \"release\".",
      ]);
    });

    it("goes from the busy sentence to the failure sentence with no old sentence between", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [DOCS]: held.reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const record = recordStatus();

      await go(router, { q: "docs" });
      await advancePastDelay();
      await act(async () => {
        held.answer(REFUSED);
      });
      await settle();

      expect(filterResult()).toBe(FAILED_LINE);
      expect(textsFrom(record(), "Searching for \"docs\".")).toEqual(["Searching for \"docs\".", FAILED_LINE]);
    });

    it("goes from the busy sentence to silence on Escape, with no old sentence between", async () => {
      const user = setUser();
      const { transport } = searchDaemon({ [DOCS]: heldBack().reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const record = recordStatus();

      await go(router, { q: "docs" });
      await advancePastDelay();
      act(() => {
        screen.getByRole("searchbox").focus();
      });
      await user.keyboard("{Escape}");
      await settle();

      expect(router.state.location.search).toEqual({ projects: "SAGA" });
      expect(filterResult()).toBe("");
      expect(textsFrom(record(), "Searching for \"docs\".")).toEqual(["Searching for \"docs\".", ""]);
    });

    it("starts the delay again for a new text in the first part of the wait", async () => {
      const { transport } = searchDaemon({ [DOCS]: heldBack().reply, [RELEASE]: heldBack().reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      const start = Date.now();
      await go(router, { q: "docs" });
      await advanceTo(start + BUSY_ANNOUNCE_DELAY / 2);
      const start2 = Date.now();
      await go(router, { q: "release" });
      await advanceToBeforeDelay(start2);
      expect(filterResult()).toBe("2 of 4 tasks match \"parser\".");

      await advancePastDelay();
      expect(filterResult()).toBe("Searching for \"release\".");
    });

    it("says the result, and not the busy sentence of an answered wait, while the next request runs shorter than the delay", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [DOCS]: held.reply, [RELEASE]: heldBack().reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      await go(router, { q: "docs" });
      await advancePastDelay();
      await act(async () => {
        held.answer(listing([ENTRIES[1]!]));
      });
      await settle();

      const start = Date.now();
      await go(router, { q: "release" });
      await advanceToBeforeDelay(start);
      expect(filterResult()).toBe("1 of 4 tasks match \"docs\".");
    });

    it("keeps the result it shows and turns the spinner while the request for a new text runs", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [DOCS]: held.reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      await go(router, { q: "docs" });
      expect(spinning()).toBe(true);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2"]);
      expect(filterResult()).toBe("2 of 4 tasks match \"parser\".");

      await act(async () => {
        held.answer(listing([ENTRIES[1]!]));
      });
      await settle();
      expect(spinning()).toBe(false);
      expect(titlesIn("Backlog")).toEqual(["Task 2"]);
      expect(filterResult()).toBe("1 of 4 tasks match \"docs\".");
    });

    it("shows every card for a first search while its request runs", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [PARSER]: held.reply });
      await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      expect(spinning()).toBe(true);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2", "Task 3"]);
      expect(filterResult()).toBe("");
    });

    it("shows every card after a clear while the request for the next text runs", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [DOCS]: held.reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      await go(router, {});
      await go(router, { q: "docs" });

      expect(spinning()).toBe(true);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2", "Task 3"]);
    });

    it("turns no spinner while a read of a text with a result runs", async () => {
      const stub = searchDaemon();
      const { feed } = await openWithFeed("/tasks?projects=SAGA&q=parser", stub);
      await settle();

      stub.replies[PARSER] = heldBack().reply;
      const reads = countReads(stub, PARSER);
      await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1")]);

      expect(reads()).toBeGreaterThan(0);
      expect(spinning()).toBe(false);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2"]);
      expect(filterResult()).not.toContain("Searching");
    });

    it("turns no spinner while a read of a failed text runs", async () => {
      const stub = searchDaemon({ [PARSER]: REFUSED });
      const { feed } = await openWithFeed("/tasks?projects=SAGA&q=parser", stub);
      await settle();

      stub.replies[PARSER] = heldBack().reply;
      const reads = countReads(stub, PARSER);
      await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1")]);

      expect(reads()).toBeGreaterThan(0);
      expect(spinning()).toBe(false);
      expect(screen.getByText(FAILED_LINE, { selector: "p" })).toBeTruthy();
      expect(filterResult()).not.toContain("Searching");
    });

    it("turns the spinner and keeps the shown result while a text that failed before is asked again", async () => {
      const { transport, replies } = searchDaemon({ [PARSER]: REFUSED });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      await go(router, { q: "docs" });
      replies[PARSER] = heldBack().reply;
      const start = Date.now();
      await go(router, { q: "parser" });

      expect(spinning()).toBe(true);
      expect(screen.queryByText(FAILED_LINE, { selector: "p" })).toBeNull();
      expect(titlesIn("Backlog")).toEqual(["Task 2"]);
      expect(filterResult()).toBe("1 of 4 tasks match \"docs\".");

      await advanceToBeforeDelay(start);
      expect(filterResult()).toBe("1 of 4 tasks match \"docs\".");
      await advancePastDelay();
      expect(filterResult()).toBe("Searching for \"parser\".");
    });
  });

  describe("a failed search", () => {
    it("shows every card, the failure line and the failure sentence", async () => {
      const { transport } = searchDaemon({ [PARSER]: REFUSED });
      await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2", "Task 3"]);
      expect(countOf("Backlog")).toBe("3");
      expect(screen.getByText(FAILED_LINE, { selector: "p" })).toBeTruthy();
      expect(filterResult()).toBe(FAILED_LINE);
    });

    it("says the label sentence after the failure sentence", async () => {
      const { transport } = searchDaemon({ [PARSER]: REFUSED });
      await renderWithRouter("/tasks?projects=SAGA&labels=web&q=parser", transport);
      await settle();

      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
      expect(filterResult()).toBe(`${FAILED_LINE} 2 of 4 tasks carry a selected label.`);
    });

    it("asks again on each event, keeps q, and applies the first result", async () => {
      const stub = searchDaemon({ [PARSER]: REFUSED });
      const { router, feed } = await openWithFeed("/tasks?projects=SAGA&q=parser", stub);
      await settle();
      const reads = countReads(stub, PARSER);

      stub.replies[PARSER] = listing([ENTRIES[0]!]);
      await sendAndWaitPastRetry(feed, [taskEvent("SAGA-2")]);

      expect(reads()).toBeGreaterThan(0);
      expect(router.state.location.search).toEqual({ projects: "SAGA", q: "parser" });
      expect(screen.queryByText(FAILED_LINE, { selector: "p" })).toBeNull();
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    });

    it("keeps the result that reads of the same text with no envelope leave, and opens no board notice", async () => {
      const stub = searchDaemon();
      const { feed } = await openWithFeed("/tasks?projects=SAGA&q=parser", stub);
      await settle();

      stub.replies[PARSER] = UNREADABLE;
      const reads = countReads(stub, PARSER);
      await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1")]);
      expect(reads()).toBeGreaterThan(0);
      await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1")]);
      expect(reads()).toBeGreaterThan(0);

      expect(useNoticeStore.getState().notices).toEqual([]);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2"]);
      expect(screen.queryByText(FAILED_LINE, { selector: "p" })).toBeNull();
    });

    it("opens the board notice on a refused read of a search with a result, with the words of the refusal", async () => {
      const stub = searchDaemon();
      const { feed } = await openWithFeed("/tasks?projects=SAGA&q=parser", stub);
      await settle();

      stub.replies[PARSER] = REFUSED;
      await sendAndWaitPastRetry(feed, [projectEvent("SAGA")]);

      expect(useNoticeStore.getState().notices).toMatchObject([
        {
          key: "board-refusal:SAGA",
          title: "The board is not up to date",
          words: ["store/project-invalid · config.yml is broken"],
        },
      ]);
    });

    it("opens no board notice while a search with no result is refused", async () => {
      const stub = searchDaemon({ [PARSER]: REFUSED });
      const { feed } = await openWithFeed("/tasks?projects=SAGA&q=parser", stub);
      await settle();

      const reads = countReads(stub, PARSER);
      await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1")]);
      expect(reads()).toBeGreaterThan(0);
      await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1")]);
      expect(reads()).toBeGreaterThan(0);
      await sendAndWaitPastRetry(feed, [taskEvent("SAGA-1")]);
      expect(reads()).toBeGreaterThan(0);

      expect(useNoticeStore.getState().notices).toEqual([]);
    });
  });

  describe("focus", () => {
    it("moves to the heading of the column of a focused card that a new result hides", async () => {
      const { transport } = searchDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      act(() => {
        screen.getByRole("link", { name: "SAGA-1 Task 1" }).focus();
      });

      await go(router, { q: "docs" });

      expect(titlesIn("Backlog")).toEqual(["Task 2"]);
      expect(document.activeElement).toBe(within(column("Backlog")).getByRole("heading", { level: 2 }));
    });

    it("moves to the heading when the card's menu holds focus", async () => {
      const user = setUser();
      const { transport } = searchDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const card = screen.getByRole("link", { name: "SAGA-1 Task 1" }).closest<HTMLElement>("[data-task-id]")!;
      await user.click(within(card).getByRole("button", { name: "Task menu SAGA-1" }));
      await screen.findByRole("menu");

      await go(router, { q: "docs" });

      expect(document.activeElement).toBe(within(column("Backlog")).getByRole("heading", { level: 2 }));
    });

    it("stays on a card the new result keeps", async () => {
      const { transport } = searchDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const link = screen.getByRole("link", { name: "SAGA-2 Task 2" });
      act(() => {
        link.focus();
      });

      await go(router, { q: "docs" });

      expect(document.activeElement).toBe(link);
    });

    it("moves to the search field and selects its text on Cmd+F, and not for a press before the board", async () => {
      useUiStore.getState().requestFind();
      const { transport } = searchDaemon();
      await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const field = screen.getByRole<HTMLInputElement>("searchbox");
      expect(document.activeElement).not.toBe(field);

      act(() => {
        useUiStore.getState().requestFind();
      });

      expect(document.activeElement).toBe(field);
      expect([field.selectionStart, field.selectionEnd]).toEqual([0, "parser".length]);
    });

    it("stays in the search field when a new result hides a card", async () => {
      const { transport } = searchDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      act(() => {
        screen.getByRole("searchbox").focus();
      });

      await go(router, { q: "docs" });

      expect(document.activeElement).toBe(screen.getByRole("searchbox"));
    });

    it("leaves focus with the card a menu move focuses", async () => {
      const user = setUser();
      const { transport } = searchDaemon({ "PATCH /projects/SAGA/tasks/SAGA-1": heldBack().reply });
      await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const card = screen.getByRole("link", { name: "SAGA-1 Task 1" }).closest<HTMLElement>("[data-task-id]")!;
      await user.click(within(card).getByRole("button", { name: "Task menu SAGA-1" }));
      const menu = await screen.findByRole("menu");
      await user.click(within(menu).getByRole("menuitemradio", { name: "To Do" }));
      await settle();

      const moved = within(column("To Do")).getByRole("link", { name: "SAGA-1 Task 1" }).closest<HTMLElement>("[data-task-id]")!;
      expect(document.activeElement).toBe(within(moved).getByRole("button", { name: "Task menu SAGA-1" }));
    });
  });

  describe("creating a task", () => {
    const CREATE = "POST /projects/SAGA/tasks";
    const CREATED = entry(7);

    function announced(): string[] {
      return useNoticeStore.getState().announced.map(({ words }) => words);
    }

    async function create(user: ReturnType<typeof setUser>) {
      await user.click(screen.getByRole("button", { name: "New task" }));
      const input = await screen.findByRole("textbox", { name: "Title" });
      await waitFor(() => {
        expect(document.activeElement).toBe(input);
      });
      await user.keyboard("Task 7");
      await user.click(within(screen.getByRole("dialog", { name: "New task" })).getByRole("button", { name: "Create" }));
    }

    it.each([
      { what: "the search", search: "&q=parser", words: "SAGA-7 was created. The search hides it." },
      { what: "both filters", search: "&labels=web&q=parser", words: "SAGA-7 was created. The filters hide it." },
    ])("focuses the heading of the column when $what hides the new card, and says so", async ({ search, words }) => {
      const user = setUser();
      const { transport, replies } = searchDaemon({ [CREATE]: successReply({ id: "SAGA-7", status: "Backlog" }) });
      await renderWithRouter(`/tasks?projects=SAGA${search}`, transport);
      await settle();
      replies["/projects/SAGA/tasks"] = listing([...ENTRIES, CREATED]);

      await create(user);

      await waitFor(() => {
        expect(document.activeElement).toBe(within(column("Backlog")).getByRole("heading", { level: 2 }));
      });
      await waitFor(() => {
        expect(announced()).toContain(words);
      });
    });

    it("focuses the new card when the search failed, which shows every card", async () => {
      const user = setUser();
      const { transport, replies } = searchDaemon({
        [PARSER]: REFUSED,
        [CREATE]: successReply({ id: "SAGA-7", status: "Backlog" }),
      });
      await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      replies["/projects/SAGA/tasks"] = listing([...ENTRIES, CREATED]);

      await create(user);

      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole("link", { name: "SAGA-7 Task 7" }));
      });
      await waitFor(() => {
        expect(announced()).toContain("SAGA-7 was created.");
      });
    });

    it("refetches the search with the listing, and shows the new card the search gives back", async () => {
      const user = setUser();
      const { transport, replies } = searchDaemon({ [CREATE]: successReply({ id: "SAGA-7", status: "Backlog" }) });
      await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      replies["/projects/SAGA/tasks"] = listing([...ENTRIES, CREATED]);
      replies[PARSER] = listing([ENTRIES[0]!, ENTRIES[1]!, CREATED]);

      await create(user);

      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole("link", { name: "SAGA-7 Task 7" }));
      });
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2", "Task 7"]);
    });
  });

  describe("on a board of several projects", () => {
    const BOTH = "DELTA,SAGA";
    const SAGA_ENTRIES = [entry(1), entry(2), entry(3, { status: "Done" })];
    const DELTA_ENTRIES = [taggedEntry("DELTA", 11), taggedEntry("DELTA", 12), taggedEntry("DELTA", 13, { status: "Done" })];
    const DELTA_PARSER = "/projects/DELTA/tasks?q=parser";
    const DELTA_DOCS = "/projects/DELTA/tasks?q=docs";
    const ALL_BACKLOG = ["Task 1", "Task 2", "Task 11", "Task 12"];

    function bothDaemon(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
      return daemon({
        "/projects/SAGA/tasks": listing(SAGA_ENTRIES),
        "/projects/DELTA/tasks": listing(DELTA_ENTRIES),
        [PARSER]: listing([SAGA_ENTRIES[0]!]),
        [DOCS]: listing([SAGA_ENTRIES[1]!]),
        [DELTA_PARSER]: listing([DELTA_ENTRIES[0]!]),
        [DELTA_DOCS]: listing([DELTA_ENTRIES[1]!]),
        ...replies,
      });
    }

    async function open(search: string, stub: ReturnType<typeof bothDaemon>) {
      const router = await renderWithRouter(`/tasks?projects=${BOTH}${search}`, stub.transport);
      await settle();

      return router;
    }

    async function answer(held: ReturnType<typeof heldBack>, reply: TransportReply) {
      await act(async () => {
        held.answer(reply);
      });
      await settle();
    }

    it("asks each project for q once, and shows the matches of both, counted over both", async () => {
      const stub = bothDaemon();
      await open("&q=parser", stub);

      expect(stub.paths.filter((path) => path.includes("?q="))).toEqual([DELTA_PARSER, PARSER]);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 11"]);
      expect(CONFIG.statuses.map(countOf)).toEqual(["2 of 4", "0 of 0", "0 of 0", "0 of 2"]);
      expect(filterResult()).toBe("2 of 6 tasks match \"parser\".");
    });

    it("shows every card while the search of one project runs, and filters both projects in one render when it answers", async () => {
      const held = heldBack();
      await open("&q=parser", bothDaemon({ [PARSER]: held.reply }));
      const record = recordStatus();

      expect(spinning()).toBe(true);
      expect(titlesIn("Backlog")).toEqual(ALL_BACKLOG);
      expect(filterResult()).toBe("");

      await answer(held, listing([SAGA_ENTRIES[0]!]));

      expect(spinning()).toBe(false);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 11"]);
      expect(record()).toEqual(["", "2 of 6 tasks match \"parser\"."]);
    });

    it("keeps the result of the earlier text in both projects until every project answers the new text", async () => {
      const held = heldBack();
      const router = await open("&q=parser", bothDaemon({ [DOCS]: held.reply }));

      await go(router, { projects: BOTH, q: "docs" });
      expect(spinning()).toBe(true);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 11"]);
      expect(filterResult()).toBe("2 of 6 tasks match \"parser\".");

      await answer(held, listing([SAGA_ENTRIES[1]!]));
      expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 12"]);
      expect(filterResult()).toBe("2 of 6 tasks match \"docs\".");
    });

    it("says the busy sentence while the search of one project runs past the delay, and then the result", async () => {
      const held = heldBack();
      await open("&q=parser", bothDaemon({ [PARSER]: held.reply }));
      const record = recordStatus();

      await advancePastDelay();
      expect(filterResult()).toBe("Searching for \"parser\".");

      await answer(held, listing([SAGA_ENTRIES[0]!]));
      expect(textsFrom(record(), "Searching for \"parser\".")).toEqual([
        "Searching for \"parser\".",
        "2 of 6 tasks match \"parser\".",
      ]);
    });

    it("starts the delay again when the board comes back to the projects of an earlier busy sentence", async () => {
      const held = heldBack();
      const router = await open("&q=parser", bothDaemon({ [PARSER]: held.reply }));
      await advancePastDelay();
      expect(filterResult()).toBe("Searching for \"parser\".");

      await go(router, { projects: "SAGA", q: "parser" });
      await go(router, { projects: BOTH, q: "parser" });
      expect(filterResult()).toBe("");

      await advancePastDelay();
      expect(filterResult()).toBe("Searching for \"parser\".");
    });

    it.each([
      { what: "an unreadable answer after the retry", reply: UNREADABLE },
      { what: "a refusal and never had a result", reply: REFUSED },
    ])("applies no result, and shows every card and the failure, when the search of one project gets $what", async ({ reply }) => {
      await open("&q=parser", bothDaemon({ [PARSER]: reply }));
      await waitPastRetry();

      const line = screen.getByText(FAILED_LINE, { selector: "p" });
      expect(titlesIn("Backlog")).toEqual(ALL_BACKLOG);
      expect(countOf("Backlog")).toBe("4");
      expect(filterResult()).toBe(FAILED_LINE);
      expect(screen.getByRole("searchbox").getAttribute("aria-describedby")).toBe(line.id);
      expect(useNoticeStore.getState().notices).toEqual([]);
    });

    it("keeps the failure of a project that stays on the board when the board adds a project", async () => {
      const { transport } = bothDaemon({ [PARSER]: REFUSED });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      expect(screen.getByText(FAILED_LINE, { selector: "p" })).toBeTruthy();

      await go(router, { projects: BOTH, q: "parser" });

      expect(spinning()).toBe(false);
      expect(screen.getByText(FAILED_LINE, { selector: "p" })).toBeTruthy();
      expect(titlesIn("Backlog")).toEqual(ALL_BACKLOG);
    });

    it("applies the result of the project that stays when a failed project leaves, and waits for the search of that project when it comes back", async () => {
      const stub = bothDaemon({ [PARSER]: REFUSED });
      const router = await open("&q=parser", stub);
      expect(screen.getByText(FAILED_LINE, { selector: "p" })).toBeTruthy();

      await go(router, { projects: "DELTA", q: "parser" });
      expect(screen.queryByText(FAILED_LINE, { selector: "p" })).toBeNull();
      expect(titlesIn("Backlog")).toEqual(["Task 11"]);
      expect(filterResult()).toBe("1 of 3 tasks match \"parser\".");

      const held = heldBack();
      stub.replies[PARSER] = held.reply;
      await go(router, { projects: BOTH, q: "parser" });
      expect(spinning()).toBe(true);
      expect(screen.queryByText(FAILED_LINE, { selector: "p" })).toBeNull();
      expect(titlesIn("Backlog")).toEqual(ALL_BACKLOG);

      await answer(held, listing([SAGA_ENTRIES[0]!]));
      expect(spinning()).toBe(false);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 11"]);
      expect(filterResult()).toBe("2 of 6 tasks match \"parser\".");
    });

    it("shows the failure of the search of a project that takes the place of the project of the board", async () => {
      const { transport } = bothDaemon({ [DELTA_PARSER]: REFUSED });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);

      await go(router, { projects: "DELTA", q: "parser" });
      await waitPastRetry();

      expect(spinning()).toBe(false);
      expect(screen.getByText(FAILED_LINE, { selector: "p" })).toBeTruthy();
      expect(titlesIn("Backlog")).toEqual(["Task 11", "Task 12"]);
      expect(filterResult()).toBe(FAILED_LINE);
    });

    it("keeps the result it shows, and shows no failure, while one project fails the new text and the other runs it", async () => {
      const held = heldBack();
      const router = await open("&q=parser", bothDaemon({ [DOCS]: REFUSED, [DELTA_DOCS]: held.reply }));

      await go(router, { projects: BOTH, q: "docs" });
      await waitPastRetry();
      expect(spinning()).toBe(true);
      expect(screen.queryByText(FAILED_LINE, { selector: "p" })).toBeNull();
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 11"]);
      expect(filterResult()).toBe("Searching for \"docs\".");

      await answer(held, listing([DELTA_ENTRIES[1]!]));
      expect(spinning()).toBe(false);
      expect(screen.getByText(FAILED_LINE, { selector: "p" })).toBeTruthy();
      expect(titlesIn("Backlog")).toEqual(ALL_BACKLOG);
      expect(filterResult()).toBe(FAILED_LINE);
    });

    it("asks no search of a project refused at the load, and filters the cards of the other", async () => {
      const stub = bothDaemon({ "/projects/SAGA": REFUSED });
      await open("&q=parser", stub);

      expect(stub.paths.filter((path) => path.includes("?q="))).toEqual([DELTA_PARSER]);
      expect(titlesIn("Backlog")).toEqual(["Task 11"]);
      expect(filterResult()).toBe("1 of 3 tasks match \"parser\".");
    });

    it("reads again only the search of the project of a task event, and shows a task that now matches", async () => {
      const changed = [SAGA_ENTRIES[0]!, entry(2, { title: "Fix the parser" }), SAGA_ENTRIES[2]!];
      const stub = bothDaemon();
      const { feed } = await openWithFeed(`/tasks?projects=${BOTH}&q=parser`, stub);
      await settle();
      const sagaReads = countReads(stub, PARSER);
      const deltaReads = countReads(stub, DELTA_PARSER);

      stub.replies["/projects/SAGA/tasks"] = listing(changed);
      stub.replies[PARSER] = listing([changed[0]!, changed[1]!]);
      await sendAndWaitPastRetry(feed, [taskEvent("SAGA-2")]);

      expect(sagaReads()).toBeGreaterThan(0);
      expect(deltaReads()).toBe(0);
      expect(within(column("Backlog")).getByText("Fix the parser")).toBeTruthy();
      expect(filterResult()).toBe("3 of 6 tasks match \"parser\".");
    });

    it("hides the cards of a project that joins the board of all projects until its search answers", async () => {
      const held = heldBack();
      const stub = bothDaemon({ "/projects": successReply([SAGA]), [DELTA_PARSER]: held.reply });
      const { feed } = await openWithFeed("/tasks?projects=all&q=parser", stub);
      await settle();
      expect(filterResult()).toBe("1 of 3 tasks match \"parser\".");

      stub.replies["/projects"] = successReply([DELTA, SAGA]);
      await sendAndWaitPastRetry(feed, [projectEvent("DELTA", "created")]);
      await vi.waitFor(() => {
        expect(countOf("Backlog")).toBe("1 of 4");
      });
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);

      await answer(held, listing([DELTA_ENTRIES[0]!]));
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 11"]);
      expect(filterResult()).toBe("2 of 6 tasks match \"parser\".");
    });

    it("shows the matches of a project that joins the board of all projects after the project it shows", async () => {
      const stub = bothDaemon({ "/projects": successReply([DELTA]) });
      const { feed } = await openWithFeed("/tasks?projects=all&q=parser", stub);
      await settle();
      expect(filterResult()).toBe("1 of 3 tasks match \"parser\".");

      stub.replies["/projects"] = successReply([DELTA, SAGA]);
      await sendAndWaitPastRetry(feed, [projectEvent("SAGA", "created")]);
      await vi.waitFor(() => {
        expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 11"]);
      });
      expect(filterResult()).toBe("2 of 6 tasks match \"parser\".");
    });

    it("keeps the result it shows while a new text runs, after the board of all projects moves to a list of the same projects", async () => {
      const held = heldBack();
      const stub = bothDaemon({ "/projects": successReply([DELTA, SAGA]), [DOCS]: held.reply });
      const router = await renderWithRouter("/tasks?projects=all&q=parser", stub.transport);
      await settle();
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 11"]);

      await go(router, { projects: BOTH, q: "parser" });
      await go(router, { projects: BOTH, q: "docs" });

      expect(spinning()).toBe(true);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 11"]);
      expect(filterResult()).toBe("2 of 6 tasks match \"parser\".");
    });

    it("says no search result when a read refuses every project of the board", async () => {
      const stub = bothDaemon();
      const { feed } = await openWithFeed(`/tasks?projects=${BOTH}&q=parser`, stub);
      await settle();
      expect(filterResult()).toBe("2 of 6 tasks match \"parser\".");

      stub.replies["/projects/DELTA"] = REFUSED;
      stub.replies["/projects/SAGA"] = REFUSED;
      await sendAndWaitPastRetry(feed, [projectEvent("DELTA"), projectEvent("SAGA")]);

      await vi.waitFor(() => {
        expect(filterResult()).toBe("");
      });
      expect(spinning()).toBe(false);
    });

    it("moves to the search field and selects its text on Cmd+F", async () => {
      await open("&q=parser", bothDaemon());
      const field = screen.getByRole<HTMLInputElement>("searchbox");

      act(() => {
        useUiStore.getState().requestFind();
      });

      expect(document.activeElement).toBe(field);
      expect([field.selectionStart, field.selectionEnd]).toEqual([0, "parser".length]);
    });

    it("keeps the focus on a card the new text hides until every project answers, then moves it to the heading", async () => {
      const held = heldBack();
      const router = await open("&q=parser", bothDaemon({ [DOCS]: held.reply }));
      const link = screen.getByRole("link", { name: "DELTA-11 Task 11" });
      act(() => {
        link.focus();
      });

      await go(router, { projects: BOTH, q: "docs" });
      expect(document.activeElement).toBe(link);

      await answer(held, listing([SAGA_ENTRIES[1]!]));
      expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 12"]);
      expect(document.activeElement).toBe(within(column("Backlog")).getByRole("heading", { level: 2 }));
    });

    it("comes back from a task page scrolled where it was, and focuses the card once every search answers", async () => {
      const user = setUser();
      const scrollTo = vi.fn<(...args: unknown[]) => void>();
      vi.stubGlobal("scrollTo", scrollTo);
      vi.stubGlobal("scrollX", 40);
      vi.stubGlobal("scrollY", 1200);
      const stub = bothDaemon({
        "/projects/DELTA/tasks/DELTA-11": successReply({ frontmatter: DELTA_ENTRIES[0]!.frontmatter, body: "", comments: [] }),
        "/projects/DELTA/tasks/DELTA-11/chats": successReply([]),
      });
      const router = await open("&q=parser", stub);
      const restoredTo = () => scrollTo.mock.calls.filter((call) => call.length === 2).at(-1) ?? null;

      await user.click(screen.getByRole("link", { name: "DELTA-11 Task 11" }));
      expect(router.state.location.pathname).toBe("/tasks/DELTA/DELTA-11");
      for (const tag of ["DELTA", "SAGA"]) {
        router.options.context.queryClient.removeQueries({ queryKey: daemonKeys.taskSearches(tag) });
      }
      const held = heldBack();
      stub.replies[PARSER] = held.reply;
      scrollTo.mockClear();

      await user.click(backLink());
      await settle();
      expect(router.state.location.search).toEqual({ projects: BOTH, q: "parser" });
      expect(restoredTo()).toBeNull();
      expect(useUiStore.getState().boardRestorePending).toBe(true);

      await answer(held, listing([SAGA_ENTRIES[0]!]));
      await waitFor(() => {
        expect(restoredTo()).toEqual([40, 1200]);
      });
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole("link", { name: "DELTA-11 Task 11" }));
      });
    });
  });
});
