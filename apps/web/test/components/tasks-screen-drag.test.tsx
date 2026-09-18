import type { TaskEntry } from "@tasma/protocol";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { column, daemon, entry, listing, titlesIn } from "../board-fixtures";
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

describe("dragging a card to a place", () => {
  const COLUMN_WIDTH = 300;
  const COLUMN_GAP = 24;
  const HEADER = 40;
  const CARD_HEIGHT = 96;
  const CARD_GAP = 8;
  const ROW = CARD_HEIGHT + CARD_GAP;
  /** The top of every column's first row. */
  const FIRST_ROW = 100;

  let frames: FrameRequestCallback[] = [];
  /** Kept before the stub replaces it, for the parts of Base UI that wait for a frame. */
  const nativeFrame = window.requestAnimationFrame.bind(window);

  /** The left edge of a column, which the columns of the board follow in order. */
  function columnLeft(index: number): number {
    return index * (COLUMN_WIDTH + COLUMN_GAP);
  }

  /** The middle of the row at `at` of a column, `off` pixels down. */
  function atRow(index: number, at: number, off = 0): { x: number; y: number } {
    return { x: columnLeft(index) + 20, y: FIRST_ROW + at * ROW + CARD_HEIGHT / 2 + off };
  }

  /**
   * jsdom lays nothing out. A column stands beside the one before it and has no
   * bottom; its rows, the slot included, stand one under the other.
   */
  function rect(left: number, top: number, height: number, width = COLUMN_WIDTH): DOMRect {
    const box = {
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
    };

    return { ...box, toJSON: () => box };
  }

  function box(element: HTMLElement): DOMRect {
    // An element off the page has no box at all, which is what makes measuring
    // one worth catching.
    if (!element.isConnected) {
      return rect(0, 0, 0, 0);
    }

    const section = element.closest<HTMLElement>("[data-column-index]");
    const left = columnLeft(Number(section?.dataset.columnIndex ?? 0));

    if (element === section) {
      return rect(left, FIRST_ROW - HEADER, 0);
    }

    const rows = [...(section?.querySelector("ul")?.children ?? [])];

    return rect(left, FIRST_ROW + rows.findIndex((row) => row.contains(element)) * ROW, CARD_HEIGHT);
  }

  function pointerEvent(type: string, at: { x: number; y: number }, pointerType = "mouse"): MouseEvent {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: at.x, clientY: at.y });
    Object.assign(event, { pointerType });

    return event;
  }

  function send(target: Element | Window, type: string, at: { x: number; y: number }, pointerType = "mouse"): void {
    fireEvent(target, pointerEvent(type, at, pointerType));
  }

  /** Runs the frames a drag has asked for, and the frames they ask for in turn. */
  function runFrames(count = 2): void {
    for (let round = 0; round < count; round += 1) {
      const pending = frames;
      frames = [];
      act(() => {
        for (const frame of pending) {
          frame(0);
        }
      });
    }
  }

  function cardIn(status: string, title: string): HTMLElement {
    return within(column(status)).getByText(title).closest<HTMLElement>("[data-task-id]")!;
  }

  /** Presses the card, which starts no drag until the pointer moves. */
  function press(status: string, title: string, pointerType = "mouse"): void {
    const element = cardIn(status, title);
    const { left, top } = element.getBoundingClientRect();

    send(element, "pointerdown", { x: left + 20, y: top + 20 }, pointerType);
  }

  function movePointer(to: { x: number; y: number }, pointerType = "mouse"): void {
    send(window, "pointermove", to, pointerType);
    runFrames();
  }

  async function release(at: { x: number; y: number }) {
    await act(async () => {
      send(window, "pointerup", at);
    });
  }

  /** The card the pointer carries, which renders on the body. */
  function lifted(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>("[inert]");
  }

  function slotIn(status: string): HTMLElement | null {
    return column(status).querySelector<HTMLElement>("[data-drag-slot]");
  }

  function patches(requests: { method: string; path: string; body?: unknown }[]) {
    return requests.filter(({ method }) => method === "PATCH").map(({ path, body }) => [path, body]);
  }

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("innerWidth", 1_400);
    vi.stubGlobal("innerHeight", 3_000);
    vi.stubGlobal("scrollBy", () => {});
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(CARD_HEIGHT);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return box(this);
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  describe("the press", () => {
    it("starts no drag under 4px, and the click that follows opens the task", async () => {
      const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1)]) });
      const router = await renderWithRouter("/tasks?projects=SAGA", transport);

      press("Backlog", "Task 1");
      movePointer({ x: 22, y: 122 });

      expect(lifted()).toBeNull();

      await release({ x: 22, y: 122 });
      await act(async () => {
        fireEvent.click(cardIn("Backlog", "Task 1"));
      });

      expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-1");
    });

    it("starts the drag when the pointer leaves the card before the threshold", async () => {
      const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1), entry(2, { status: "To Do" })]) });
      await renderWithRouter("/tasks?projects=SAGA", transport);

      press("Backlog", "Task 1");
      movePointer(atRow(1, 0));

      expect(lifted()?.textContent).toContain("Task 1");
    });

    it("starts no drag from a touch pointer", async () => {
      const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1)]) });
      await renderWithRouter("/tasks?projects=SAGA", transport);

      press("Backlog", "Task 1", "touch");
      movePointer(atRow(1, 0), "touch");

      expect(lifted()).toBeNull();
    });

    it("starts no drag from the menu button, which the press belongs to", async () => {
      const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1)]) });
      await renderWithRouter("/tasks?projects=SAGA", transport);

      send(within(cardIn("Backlog", "Task 1")).getByRole("button", { name: "Task menu" }), "pointerdown", { x: 20, y: 120 });
      movePointer(atRow(0, 2));

      expect(lifted()).toBeNull();
    });

    it("starts no drag from a button other than the primary one", async () => {
      const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1)]) });
      await renderWithRouter("/tasks?projects=SAGA", transport);

      const element = cardIn("Backlog", "Task 1");
      const event = new MouseEvent("pointerdown", { bubbles: true, button: 2, clientX: 20, clientY: 120 });
      Object.assign(event, { pointerType: "mouse" });
      fireEvent(element, event);
      movePointer(atRow(0, 2));

      expect(lifted()).toBeNull();
    });

    it("keeps the drag it already runs when another card is pressed", async () => {
      const { transport } = daemon({
        "/projects/SAGA/tasks": listing([entry(1), entry(2)]),
        "PATCH /projects/SAGA/tasks/SAGA-1": heldBack().reply,
      });
      await renderWithRouter("/tasks?projects=SAGA", transport);

      press("Backlog", "Task 1");
      movePointer(atRow(0, 1, 1));
      press("Backlog", "Task 2");

      expect(lifted()?.textContent).toContain("Task 1");
    });

    it("measures the card again when a poll replaced its element between the press and the drag", async () => {
      const { transport, replies } = daemon({
        "/projects/SAGA/tasks": listing([entry(1), entry(2, { status: "To Do" })]),
      });
      const router = await renderWithRouter("/tasks?projects=SAGA", transport);

      press("Backlog", "Task 1");
      // The card moves to another column, so its row unmounts and a row of the
      // other column's list takes over. The element the press held is off the page.
      replies["/projects/SAGA/tasks"] = listing([entry(1, { status: "To Do" }), entry(2, { status: "To Do" })]);
      await act(async () => {
        await router.options.context.queryClient.refetchQueries({ queryKey: ["daemon", "projects", "SAGA", "tasks"] });
      });
      await vi.waitFor(() => {
        expect(titlesIn("To Do")).toEqual(["Task 1", "Task 2"]);
      });
      movePointer(atRow(1, 1, 1));

      // The grab offset is read from the element that holds the card now, and
      // the pointer stands left of it: the press was made in the first column.
      expect(lifted()?.style.width).toBe(`${String(COLUMN_WIDTH)}px`);
      expect(lifted()?.style.transform).toBe("translate(648px, 233px) scale(1.02)");
    });

    it("starts no drag when the pressed card has left the page", async () => {
      const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1), entry(2, { status: "To Do" })]) });
      await renderWithRouter("/tasks?projects=SAGA", transport);

      press("Backlog", "Task 1");
      cardIn("Backlog", "Task 1").remove();
      movePointer(atRow(1, 0));

      expect(lifted()).toBeNull();
    });

    it("starts no drag when a poll takes the card off the board first", async () => {
      const { transport, replies } = daemon({ "/projects/SAGA/tasks": listing([entry(1), entry(2)]) });
      const router = await renderWithRouter("/tasks?projects=SAGA", transport);

      press("Backlog", "Task 1");
      replies["/projects/SAGA/tasks"] = listing([entry(2)]);
      await act(async () => {
        await router.options.context.queryClient.refetchQueries({ queryKey: ["daemon", "projects", "SAGA", "tasks"] });
      });
      await vi.waitFor(() => {
        expect(titlesIn("Backlog")).toEqual(["Task 2"]);
      });
      movePointer(atRow(0, 1));

      expect(lifted()).toBeNull();
    });

    it("starts no drag from the menu, whose popup sends its events through the card", async () => {
      vi.stubGlobal("requestAnimationFrame", nativeFrame);
      const user = userEvent.setup();
      const { transport } = daemon({ "/projects/SAGA/tasks": listing([entry(1)]) });
      await renderWithRouter("/tasks?projects=SAGA", transport);

      await user.click(within(cardIn("Backlog", "Task 1")).getByRole("button", { name: "Task menu" }));
      const menu = await screen.findByRole("menu");
      send(menu, "pointerdown", { x: 20, y: 120 });
      movePointer(atRow(1, 0));

      expect(lifted()).toBeNull();
    });
  });

  describe("the drag", () => {
    async function start() {
      const { transport, requests, replies } = daemon({
        "/projects/SAGA/tasks": listing([
          entry(1, { order: 1_000 }),
          entry(2, { order: 2_000 }),
          entry(3, { status: "To Do", order: 1_000 }),
        ]),
        "PATCH /projects/SAGA/tasks/SAGA-1": successReply({ id: "SAGA-1" }),
      });
      const router = await renderWithRouter("/tasks?projects=SAGA", transport);

      press("Backlog", "Task 1");

      return { requests, replies, router };
    }

    it("carries the card at the pointer and marks the place with a slot", async () => {
      await start();

      // The first frame can run before React has put the lifted card on the page.
      act(() => {
        window.dispatchEvent(pointerEvent("pointermove", atRow(1, 0, 1)));
        frames.shift()?.(0);
      });
      expect(lifted()?.style.transform).toBe("translate(324px, 129px) scale(1.02)");

      runFrames();

      expect(lifted()?.style.transform).toBe("translate(324px, 129px) scale(1.02)");
      expect(document.documentElement.className).toContain("cursor-grabbing");
      expect(cardIn("Backlog", "Task 1").className).toContain("opacity-35");
      expect(slotIn("To Do")).toBeTruthy();
      expect(slotIn("Backlog")).toBeNull();
    });

    it("shows no slot on the card's own place, and writes nothing when it is dropped there", async () => {
      const { requests } = await start();

      movePointer(atRow(0, 0, 1));

      expect(slotIn("Backlog")).toBeNull();

      await release(atRow(0, 0, 1));

      expect(patches(requests)).toEqual([]);
      expect(lifted()).toBeNull();
      // The frame the last one asked for runs after the drag has ended.
      runFrames();
      expect(lifted()).toBeNull();
    });

    it("shows no slot in the gap between two columns, and writes nothing when it is dropped there", async () => {
      const { requests } = await start();

      movePointer({ x: COLUMN_WIDTH + COLUMN_GAP / 2, y: FIRST_ROW });

      expect(slotIn("Backlog")).toBeNull();
      expect(slotIn("To Do")).toBeNull();

      await release({ x: COLUMN_WIDTH + COLUMN_GAP / 2, y: FIRST_ROW });

      expect(patches(requests)).toEqual([]);
    });

    it("runs on while another key is pressed", async () => {
      await start();

      movePointer(atRow(1, 0, 1));
      act(() => {
        fireEvent.keyDown(window, { key: "ArrowDown" });
      });

      expect(lifted()).toBeTruthy();
    });

    it("writes nothing when the pointer is cancelled", async () => {
      const { requests } = await start();

      movePointer(atRow(1, 0, 1));
      act(() => {
        send(window, "pointercancel", atRow(1, 0, 1));
      });

      expect(lifted()).toBeNull();
      expect(patches(requests)).toEqual([]);
    });

    it("writes nothing when the window loses focus", async () => {
      const { requests } = await start();

      movePointer(atRow(1, 0, 1));
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });

      expect(lifted()).toBeNull();
      expect(patches(requests)).toEqual([]);
    });

    it("leaves the next activation alone when the window took the drag, which fires no click", async () => {
      const { router } = await start();

      movePointer(atRow(1, 0, 1));
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      // No press before it: a click of this shape comes from the keyboard.
      await act(async () => {
        fireEvent.click(cardIn("Backlog", "Task 1"));
      });

      expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-1");
    });

    it("ends the press without swallowing the click when Escape comes before the threshold", async () => {
      const { requests, router } = await start();

      act(() => {
        fireEvent.keyDown(window, { key: "Escape" });
      });
      movePointer(atRow(1, 0, 1));

      expect(lifted()).toBeNull();

      await release(atRow(1, 0, 1));
      await act(async () => {
        fireEvent.click(cardIn("Backlog", "Task 1"));
      });

      expect(patches(requests)).toEqual([]);
      expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-1");
    });

    it("writes nothing and leaves the card in place when Escape cancels it", async () => {
      const { requests, router } = await start();

      movePointer(atRow(1, 0, 1));
      act(() => {
        fireEvent.keyDown(window, { key: "Escape" });
      });

      expect(lifted()).toBeNull();
      expect(document.documentElement.className).not.toContain("cursor-grabbing");
      expect(titlesIn("Backlog")).toEqual(["Task 1", "Task 2"]);

      await release(atRow(1, 0, 1));
      await act(async () => {
        fireEvent.click(cardIn("Backlog", "Task 1"));
      });

      expect(patches(requests)).toEqual([]);
      expect(router.state.location.pathname).toBe("/tasks");
    });

    it("keeps swallowing the click when Escape is pressed again before the release", async () => {
      const { requests, router } = await start();

      movePointer(atRow(1, 0, 1));
      act(() => {
        fireEvent.keyDown(window, { key: "Escape" });
        fireEvent.keyDown(window, { key: "Escape" });
      });

      await release(atRow(1, 0, 1));
      await act(async () => {
        fireEvent.click(cardIn("Backlog", "Task 1"));
      });

      expect(patches(requests)).toEqual([]);
      expect(router.state.location.pathname).toBe("/tasks");
    });
  });

  describe("the drop", () => {
    it("writes the status and the order when the card lands in another column", async () => {
      const { transport, requests } = daemon({
        "/projects/SAGA/tasks": listing([
          entry(1),
          entry(2, { status: "To Do", order: 1_000 }),
          entry(3, { status: "To Do", order: 2_000 }),
        ]),
        "PATCH /projects/SAGA/tasks/SAGA-1": heldBack().reply,
      });
      await renderWithRouter("/tasks?projects=SAGA", transport);

      press("Backlog", "Task 1");
      movePointer(atRow(1, 1, 1));
      await release(atRow(1, 1, 1));

      expect(patches(requests)).toEqual([["/projects/SAGA/tasks/SAGA-1", { status: "To Do", order: 3_000 }]]);
      expect(titlesIn("To Do")).toEqual(["Task 2", "Task 3", "Task 1"]);
      expect(titlesIn("Backlog")).toEqual([]);
    });

    it("writes the order alone when the card lands in its own column", async () => {
      const { transport, requests } = daemon({
        "/projects/SAGA/tasks": listing([
          entry(1, { order: 1_000 }),
          entry(2, { order: 2_000 }),
          entry(3, { order: 3_000 }),
        ]),
        "PATCH /projects/SAGA/tasks/SAGA-1": heldBack().reply,
      });
      await renderWithRouter("/tasks?projects=SAGA", transport);

      press("Backlog", "Task 1");
      movePointer(atRow(0, 1, 1));
      await release(atRow(0, 1, 1));

      expect(patches(requests)).toEqual([["/projects/SAGA/tasks/SAGA-1", { order: 2_500 }]]);
      expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 1", "Task 3"]);
    });

    it("counts the cards the label filter hides", async () => {
      const { transport, requests } = daemon({
        "/projects/SAGA/tasks": listing([
          entry(1, { status: "To Do", labels: ["web"], order: 5_000 }),
          entry(2, { labels: ["web"], order: 1_000 }),
          entry(3, { labels: ["docs"], order: 2_000 }),
          entry(4, { labels: ["web"], order: 3_000 }),
        ]),
        "PATCH /projects/SAGA/tasks/SAGA-1": heldBack().reply,
      });
      await renderWithRouter("/tasks?projects=SAGA&labels=web", transport);

      press("To Do", "Task 1");
      movePointer(atRow(0, 0, 1));
      await release(atRow(0, 0, 1));

      expect(patches(requests)).toEqual([["/projects/SAGA/tasks/SAGA-1", { status: "Backlog", order: 1_500 }]]);
      expect(titlesIn("Backlog")).toEqual(["Task 2", "Task 1", "Task 4"]);
    });

    it("does not open the task with the click the pointer release fires", async () => {
      const { transport } = daemon({
        "/projects/SAGA/tasks": listing([entry(1, { order: 1_000 }), entry(2, { order: 2_000 })]),
        "PATCH /projects/SAGA/tasks/SAGA-1": heldBack().reply,
      });
      const router = await renderWithRouter("/tasks?projects=SAGA", transport);

      press("Backlog", "Task 1");
      movePointer(atRow(0, 1, 1));
      await release(atRow(0, 1, 1));
      await act(async () => {
        fireEvent.click(cardIn("Backlog", "Task 1"));
      });

      expect(router.state.location.pathname).toBe("/tasks");
    });

    it("says the refused card was not moved, and leaves focus where it is", async () => {
      const { transport } = daemon({
        "/projects/SAGA/tasks": listing([entry(1, { order: 1_000 }), entry(2, { order: 2_000 })]),
        "PATCH /projects/SAGA/tasks/SAGA-1": refusalReply(404, {
          kind: "store",
          code: "task-not-found",
          message: "no task is SAGA-1",
        }),
      });
      await renderWithRouter("/tasks?projects=SAGA", transport);

      press("Backlog", "Task 1");
      movePointer(atRow(0, 1, 1));
      await release(atRow(0, 1, 1));

      await vi.waitFor(() => {
        expect(useNoticeStore.getState().notices.map(({ title }) => title)).toEqual(["SAGA-1 was not moved"]);
      });
      expect(document.activeElement).toBe(document.body);
    });

    it("opens Show all when the card lands under the cap of a folded final column", async () => {
      const done = Array.from({ length: 25 }, (_, index) => entry(index + 10, {
        status: "Done",
        order: (index + 1) * 1_000,
      }));
      const { transport, requests } = daemon({
        "/projects/SAGA/tasks": listing([entry(1), ...done]),
        "PATCH /projects/SAGA/tasks/SAGA-1": heldBack().reply,
      });
      await renderWithRouter("/tasks?projects=SAGA", transport);
      expect(titlesIn("Done")).toHaveLength(20);

      press("Backlog", "Task 1");
      movePointer(atRow(3, 19, 1));
      await release(atRow(3, 19, 1));

      expect(patches(requests)).toEqual([["/projects/SAGA/tasks/SAGA-1", { status: "Done", order: 20_500 }]]);
      expect(within(column("Done")).queryByRole("button", { name: "Show all" })).toBeNull();
      expect(titlesIn("Done").slice(19, 22)).toEqual(["Task 29", "Task 1", "Task 30"]);
      expect(document.activeElement).toBe(document.body);
    });

    it("keeps a folded final column folded when a later poll carries the dropped card past its cap", async () => {
      const done = Array.from({ length: 25 }, (_, index) => entry(index + 10, {
        status: "Done",
        order: (index + 1) * 1_000,
      }));
      const { transport, replies } = daemon({
        "/projects/SAGA/tasks": listing([entry(1, { order: 1_000 }), entry(2, { order: 2_000 }), ...done]),
        "PATCH /projects/SAGA/tasks/SAGA-1": successReply({ id: "SAGA-1" }),
      });
      const router = await renderWithRouter("/tasks?projects=SAGA", transport);

      // A drop inside Backlog, which folds nothing away. Its write lands, so
      // nothing of the drop is left in flight.
      press("Backlog", "Task 1");
      movePointer(atRow(0, 1, 1));
      await release(atRow(0, 1, 1));
      await vi.waitFor(() => {
        expect(cardIn("Backlog", "Task 1").getAttribute("aria-busy")).toBeNull();
      });

      // The poll puts the same task at the end of Done, past the cap. Nothing
      // the user did asks for that column to open.
      replies["/projects/SAGA/tasks"] = listing([
        entry(2, { order: 2_000 }),
        ...done,
        entry(1, { status: "Done", order: 26_000 }),
      ]);
      await act(async () => {
        await router.options.context.queryClient.refetchQueries({ queryKey: ["daemon", "projects", "SAGA", "tasks"] });
      });

      await vi.waitFor(() => {
        expect(titlesIn("Backlog")).toEqual(["Task 2"]);
      });
      expect(within(column("Done")).getByRole("button", { name: "Show all" })).toBeTruthy();
      expect(titlesIn("Done")).toHaveLength(20);
    });
  });

  describe("a poll that lands during the drag", () => {
    async function pollDuringDrag(moved: TaskEntry) {
      const { transport, requests, replies } = daemon({
        "/projects/SAGA/tasks": listing([
          entry(1, { order: 1_000 }),
          entry(2, { status: "To Do", order: 1_000 }),
        ]),
        "PATCH /projects/SAGA/tasks/SAGA-1": heldBack().reply,
      });
      const router = await renderWithRouter("/tasks?projects=SAGA", transport);

      press("Backlog", "Task 1");
      movePointer(atRow(1, 0, 1));

      replies["/projects/SAGA/tasks"] = listing([moved, entry(2, { status: "To Do", order: 1_000 })]);
      await act(async () => {
        await router.options.context.queryClient.refetchQueries({ queryKey: ["daemon", "projects", "SAGA", "tasks"] });
      });

      return { requests, router };
    }

    it("leaves the board as the drag started it, and writes from that board", async () => {
      const { requests } = await pollDuringDrag(entry(1, { status: "Done", order: 1_000 }));

      expect(titlesIn("Backlog")).toEqual(["Task 1"]);
      expect(titlesIn("Done")).toEqual([]);

      await release(atRow(1, 0, 1));

      expect(patches(requests)).toEqual([["/projects/SAGA/tasks/SAGA-1", { status: "To Do", order: 2_000 }]]);
    });

    it("shows the listing the poll brought once the drag has ended", async () => {
      await pollDuringDrag(entry(1, { title: "Task 1", status: "Done", order: 1_000 }));

      act(() => {
        fireEvent.keyDown(window, { key: "Escape" });
      });

      await vi.waitFor(() => {
        expect(titlesIn("Done")).toEqual(["Task 1"]);
      });
    });
  });
});
