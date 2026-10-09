import type { TransportReply } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_URL } from "../../src/api/transport";
import { BUSY_ANNOUNCE_DELAY } from "../../src/lib/use-board-search";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { CONFIG, column, countOf, daemon, entry, listing, titlesIn } from "../board-fixtures";
import { heldBack, refusalReply, renderWithRouter, successReply } from "../helpers";

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

  function status(): string | null {
    return screen.getByRole("status").textContent;
  }

  function spinning(): boolean {
    return screen.getByRole("searchbox").parentElement!.querySelector("svg")!.classList.contains("animate-spin");
  }

  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
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

  async function go(router: Awaited<ReturnType<typeof renderWithRouter>>, search: Record<string, string>) {
    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "SAGA", ...search } });
    });
    await settle();
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
      expect(status()).toBe("");
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
      expect(status()).toBe("2 of 4 tasks match \"parser\".");
    });

    it("shows a card only when it matches the search and carries a selected label", async () => {
      const user = setUser();
      const { transport } = searchDaemon();
      await renderWithRouter("/tasks?projects=SAGA&labels=web&q=parser", transport);
      await settle();

      expect(CONFIG.statuses.map(countOf)).toEqual(["1 of 3", "0 of 0", "0 of 0", "0 of 1"]);
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
      expect(status()).toBe("1 of 4 tasks match \"parser\" and carry a selected label.");

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
      expect(status()).toBe("0 of 4 tasks match \"release\".");
    });

    it("says no task matches the search and carries a selected label", async () => {
      const { transport } = searchDaemon();
      await renderWithRouter("/tasks?projects=SAGA&labels=web&q=docs", transport);
      await settle();

      expect(screen.getByText("No task in Saga matches the search and carries a selected label.")).toBeTruthy();
      expect(status()).toBe("0 of 4 tasks match \"docs\" and carry a selected label.");
    });

    it("shows every card again when the search is cleared", async () => {
      const { transport } = searchDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      await go(router, {});

      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2", "Task 3"]);
      expect(countOf("Backlog")).toBe("3");
      expect(status()).toBe("");
    });
  });

  describe("the wait", () => {
    const observers: MutationObserver[] = [];

    afterEach(() => {
      for (const observer of observers.splice(0)) {
        observer.disconnect();
      }
    });

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
      const region = screen.getByRole("status");
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

    it("keeps the old sentence while the request for a new text runs shorter than the delay", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [DOCS]: held.reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      const start = Date.now();
      await go(router, { q: "docs" });
      await advanceToBeforeDelay(start);

      expect(status()).toBe("2 of 4 tasks match \"parser\".");
    });

    it("says the busy sentence after the delay, and then the result with no old sentence between", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [DOCS]: held.reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const record = recordStatus();

      await go(router, { q: "docs" });
      await advancePastDelay();
      expect(status()).toBe("Searching for \"docs\".");

      await act(async () => {
        held.answer(listing([ENTRIES[1]!]));
      });
      await settle();
      expect(status()).toBe("1 of 4 tasks match \"docs\".");
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
      expect(status()).toBe("");

      await advancePastDelay();

      expect(status()).toBe("Searching for \"parser\".");
    });

    it("says no busy sentence for an answer that comes before the delay", async () => {
      const { transport } = searchDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const record = recordStatus();

      await go(router, { q: "docs" });
      await advancePastDelay();

      expect(status()).toBe("1 of 4 tasks match \"docs\".");
      expect(record().filter((text) => text.includes("Searching"))).toEqual([]);
    });

    it("says only the busy sentence while labels are selected", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [DOCS]: held.reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&labels=web&q=parser", transport);
      await settle();

      await go(router, { labels: "web", q: "docs" });
      await advancePastDelay();

      expect(status()).toBe("Searching for \"docs\".");
    });

    it("keeps the busy sentence of the earlier text until a new text has run for the delay", async () => {
      const { transport } = searchDaemon({ [DOCS]: heldBack().reply, [RELEASE]: heldBack().reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const record = recordStatus();

      await go(router, { q: "docs" });
      await advancePastDelay();
      expect(status()).toBe("Searching for \"docs\".");

      const start2 = Date.now();
      await go(router, { q: "release" });
      await advanceToBeforeDelay(start2);
      expect(status()).toBe("Searching for \"docs\".");

      await advancePastDelay();
      expect(status()).toBe("Searching for \"release\".");
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

      expect(status()).toBe(FAILED_LINE);
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
      expect(status()).toBe("");
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
      expect(status()).toBe("2 of 4 tasks match \"parser\".");

      await advancePastDelay();
      expect(status()).toBe("Searching for \"release\".");
    });

    it("keeps the result it shows and turns the spinner while the request for a new text runs", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [DOCS]: held.reply });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      await go(router, { q: "docs" });
      expect(spinning()).toBe(true);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2"]);
      expect(status()).toBe("2 of 4 tasks match \"parser\".");

      await act(async () => {
        held.answer(listing([ENTRIES[1]!]));
      });
      await settle();
      expect(spinning()).toBe(false);
      expect(titlesIn("Backlog")).toEqual(["Task 2"]);
      expect(status()).toBe("1 of 4 tasks match \"docs\".");
    });

    it("shows every card for a first search while its request runs", async () => {
      const held = heldBack();
      const { transport } = searchDaemon({ [PARSER]: held.reply });
      await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      expect(spinning()).toBe(true);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2", "Task 3"]);
      expect(status()).toBe("");
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

    it("turns no spinner while a poll of a text with a result runs", async () => {
      const { transport, replies } = searchDaemon();
      await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      replies[PARSER] = heldBack().reply;
      await poll();

      expect(spinning()).toBe(false);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2"]);
      expect(status()).not.toContain("Searching");
    });

    it("turns no spinner while a poll of a failed text runs", async () => {
      const { transport, replies } = searchDaemon({ [PARSER]: REFUSED });
      await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      replies[PARSER] = heldBack().reply;
      await poll();

      expect(spinning()).toBe(false);
      expect(screen.getByText(FAILED_LINE, { selector: "p" })).toBeTruthy();
      expect(status()).not.toContain("Searching");
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
      expect(status()).toBe("1 of 4 tasks match \"docs\".");

      await advanceToBeforeDelay(start);
      expect(status()).toBe("1 of 4 tasks match \"docs\".");
      await advancePastDelay();
      expect(status()).toBe("Searching for \"parser\".");
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
      expect(status()).toBe(FAILED_LINE);
    });

    it("says the label sentence after the failure sentence", async () => {
      const { transport } = searchDaemon({ [PARSER]: REFUSED });
      await renderWithRouter("/tasks?projects=SAGA&labels=web&q=parser", transport);
      await settle();

      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
      expect(status()).toBe(`${FAILED_LINE} 2 of 4 tasks carry a selected label.`);
    });

    it("asks again on each poll, keeps q, and applies the first result", async () => {
      const { transport, replies, paths } = searchDaemon({ [PARSER]: REFUSED });
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const asked = paths.filter((path) => path === PARSER).length;

      replies[PARSER] = listing([ENTRIES[0]!]);
      await poll();

      expect(paths.filter((path) => path === PARSER).length).toBeGreaterThan(asked);
      expect(router.state.location.search).toEqual({ projects: "SAGA", q: "parser" });
      expect(screen.queryByText(FAILED_LINE, { selector: "p" })).toBeNull();
      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
    });

    it("keeps the result a failed poll of the same text leaves, and opens the poll notice after two", async () => {
      const { transport, replies } = searchDaemon();
      await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      replies[PARSER] = UNREADABLE;
      await poll();
      expect(useNoticeStore.getState().notices).toEqual([]);
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2"]);
      expect(screen.queryByText(FAILED_LINE, { selector: "p" })).toBeNull();

      await poll();
      expect(useNoticeStore.getState().notices).toMatchObject([
        {
          key: "board-poll:SAGA",
          title: "The board is not up to date",
          words: [`${DAEMON_URL} · HTTP 502 · GET ${PARSER} answered with no envelope`],
        },
      ]);
    });

    it("opens no poll notice while a search with no result fails", async () => {
      const { transport } = searchDaemon({ [PARSER]: UNREADABLE });
      await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();

      await poll();
      await poll();
      await poll();

      expect(useNoticeStore.getState().notices).toEqual([]);
    });
  });

  describe("focus", () => {
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
    });

    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    });

    it("moves to the heading of the column of a focused card that a new result hides", async () => {
      const { transport } = searchDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      act(() => {
        screen.getByRole("link", { name: "Task 1" }).focus();
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
      const card = screen.getByRole("link", { name: "Task 1" }).closest<HTMLElement>("[data-task-id]")!;
      await user.click(within(card).getByRole("button", { name: "Task menu" }));
      await screen.findByRole("menu");

      await go(router, { q: "docs" });

      expect(document.activeElement).toBe(within(column("Backlog")).getByRole("heading", { level: 2 }));
    });

    it("stays on a card the new result keeps", async () => {
      const { transport } = searchDaemon();
      const router = await renderWithRouter("/tasks?projects=SAGA&q=parser", transport);
      await settle();
      const link = screen.getByRole("link", { name: "Task 2" });
      act(() => {
        link.focus();
      });

      await go(router, { q: "docs" });

      expect(document.activeElement).toBe(link);
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
      const card = screen.getByRole("link", { name: "Task 1" }).closest<HTMLElement>("[data-task-id]")!;
      await user.click(within(card).getByRole("button", { name: "Task menu" }));
      const menu = await screen.findByRole("menu");
      await user.click(within(menu).getByRole("menuitemradio", { name: "To Do" }));
      await settle();

      const moved = within(column("To Do")).getByRole("link", { name: "Task 1" }).closest<HTMLElement>("[data-task-id]")!;
      expect(document.activeElement).toBe(within(moved).getByRole("button", { name: "Task menu" }));
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

    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
    });

    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    });

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
        expect(document.activeElement).toBe(screen.getByRole("link", { name: "Task 7" }));
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
        expect(document.activeElement).toBe(screen.getByRole("link", { name: "Task 7" }));
      });
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2", "Task 7"]);
    });
  });
});
