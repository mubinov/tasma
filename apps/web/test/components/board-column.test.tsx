import type { Frontmatter, TaskEntry, Workflow } from "@tasma/protocol";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardColumn } from "../../src/components/board-column";
import type { ColumnData } from "../../src/lib/board";
import { useUiStore } from "../../src/store/ui";
import { renderBesideTaskRoute } from "../helpers";

function entry(number: number, fields: Partial<Frontmatter> = {}): TaskEntry {
  const id = `SAGA-${String(number)}`;

  return {
    id,
    path: `/tasks/${id}.md`,
    blocked: false,
    frontmatter: {
      id,
      title: `Task ${String(number)}`,
      status: "Done",
      created: "2026-09-01T10:00:00Z",
      updated: "2026-09-01T10:00:00Z",
      next_comment_id: 1,
      ...fields,
    },
  };
}

function entries(count: number): TaskEntry[] {
  return Array.from({ length: count }, (_, index) => entry(index + 1));
}

const WORKFLOW: Workflow = {
  name: "dev",
  file: "/w/dev/workflow.yml",
  instructions: [],
  steps: [{ name: "implement", file: "/w/dev/implement.md", owner: "agent" }],
};

type ColumnProps = Omit<ComponentProps<typeof BoardColumn>, "column">;

async function renderColumn(column: Partial<ColumnData>, props: Partial<ColumnProps> = {}) {
  const data: ColumnData = { status: "In Progress", final: false, matching: [], total: 0, ...column };

  return renderBesideTaskRoute(
    <BoardColumn
      tag="SAGA"
      place={0}
      column={data}
      filtered={false}
      priorities={["high", "low"]}
      workflows={new Map([["dev", WORKFLOW]])}
      statuses={["To Do", "In Progress", "Done"]}
      pendingIds={new Set()}
      movedIds={new Set()}
      onMove={() => {}}
      onMoveBy={() => {}}
      onOpen={() => {}}
      focusId={null}
      onMenuFocused={() => {}}
      draggingId={null}
      onPress={() => {}}
      {...props}
    />,
  );
}

function menuButton(title: string): HTMLElement {
  return within(screen.getByText(title).closest<HTMLElement>("[data-task-id]")!).getByRole("button", { name: "Task menu" });
}

/** The names of the place items in the card's menu. */
async function placeItems(title: string): Promise<string[]> {
  const user = userEvent.setup();
  await user.click(menuButton(title));
  const menu = await screen.findByRole("menu");
  const names = within(menu).getAllByRole("menuitem").map((item) => item.textContent).filter((name) => name.startsWith("Move"));
  await user.keyboard("{Escape}");

  return names;
}

function cardTitles(): string[] {
  return screen.getAllByText(/^Task \d+$/).map((title) => title.textContent);
}

/* jsdom has no layout; a card measures as tall as the column estimates it. */
beforeEach(() => {
  useUiStore.setState({ revealedColumns: new Set() });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(96);
  vi.stubGlobal("scrollTo", () => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("heads the column with its status and its count", async () => {
  await renderColumn({ matching: entries(3), total: 3 });

  const heading = screen.getByRole("heading", { level: 2, name: "In Progress" });
  expect(heading.nextElementSibling?.textContent).toBe("3");
  expect(screen.getByRole("region", { name: "In Progress" })).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "In Progress" })).getAllByRole("listitem")).toHaveLength(3);
});

it("sets the page's top scroll padding past the sticky header", async () => {
  await renderColumn({ matching: entries(1), total: 1 });

  const header = screen.getByRole("heading", { level: 2 }).parentElement!;
  expect(header.classList.contains("sticky")).toBe(true);
  expect(header.classList.contains("[html:has(&)]:scroll-pt-13")).toBe(true);
});

it("counts the matching tasks of all while labels are selected", async () => {
  await renderColumn({ matching: entries(2), total: 5 }, { filtered: true });

  expect(screen.getByRole("heading", { level: 2 }).nextElementSibling?.textContent).toBe("2 of 5");
});

it("renders no list for a column with no card", async () => {
  await renderColumn({ matching: [], total: 4 }, { filtered: true });

  expect(screen.queryByRole("list")).toBeNull();
  expect(screen.getByRole("heading", { level: 2 }).nextElementSibling?.textContent).toBe("0 of 4");
});

it("gives each card its step view and its priority", async () => {
  await renderColumn({ matching: [entry(1, { workflow: "dev", step: "implement", priority: "high" })], total: 1 });

  expect(screen.getByText("implement").className).toContain("text-text");
  expect(screen.getByText("high").className).toContain("font-medium");
});

it("shows no step in a final column", async () => {
  await renderColumn({ final: true, matching: [entry(1, { workflow: "dev", step: "implement" })], total: 1 });

  expect(screen.queryByText("implement")).toBeNull();
});

it("shows the stale step for a workflow the column has no read of", async () => {
  await renderColumn({ matching: [entry(1, { workflow: "gone", step: "implement" })], total: 1 });

  expect(screen.getByText("implement").className).toContain("text-dim");
});

it("shows the first 20 cards of a final column until Show all is used", async () => {
  const user = userEvent.setup();
  await renderColumn({ final: true, matching: entries(25), total: 25 });

  expect(cardTitles()).toHaveLength(20);
  const foot = screen.getByText(/20 of 25/);
  expect(foot.textContent).toBe("20 of 25 · Show all");

  await user.click(within(foot).getByRole("button", { name: "Show all" }));

  expect(cardTitles()).toHaveLength(25);
  expect(screen.queryByText(/20 of 25/)).toBeNull();
});

describe("a column Show all has opened, after the board was unmounted", () => {
  it("opens in full again, and a column of another project stays folded", async () => {
    const user = userEvent.setup();
    await renderColumn({ final: true, matching: entries(25), total: 25 });
    await user.click(screen.getByRole("button", { name: "Show all" }));
    cleanup();

    await renderColumn({ final: true, matching: entries(25), total: 25 });
    expect(cardTitles()).toHaveLength(25);
    cleanup();

    await renderColumn({ final: true, matching: entries(25), total: 25 }, { tag: "DELTA" });
    expect(cardTitles()).toHaveLength(20);
  });

  it("leaves the next column of its own project folded, that column carrying the same status", async () => {
    const user = userEvent.setup();
    await renderColumn({ status: "Done", final: true, matching: entries(25), total: 25 });
    await user.click(screen.getByRole("button", { name: "Show all" }));
    cleanup();

    await renderColumn({ status: "Done", final: true, matching: entries(25), total: 25 }, { place: 1 });
    expect(cardTitles()).toHaveLength(20);
  });
});

it("folds a final column out when a move in flight places a card past its cap", async () => {
  await renderColumn(
    { final: true, matching: entries(25), total: 25 },
    { pendingIds: new Set(["SAGA-25"]), movedIds: new Set(["SAGA-25"]) },
  );

  expect(cardTitles()).toHaveLength(25);
  expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  expect(document.activeElement).toBe(document.body);
});

it("leaves a final column folded when the move in flight places a card the cap shows", async () => {
  await renderColumn(
    { final: true, matching: entries(25), total: 25 },
    { pendingIds: new Set(["SAGA-3"]), movedIds: new Set(["SAGA-3"]) },
  );

  expect(cardTitles()).toHaveLength(20);
  expect(screen.getByRole("button", { name: "Show all" })).toBeTruthy();
});

it("leaves a final column folded when a move only renumbers the cards past its cap", async () => {
  await renderColumn(
    { final: true, matching: entries(25), total: 25 },
    { pendingIds: new Set(["SAGA-3", "SAGA-24", "SAGA-25"]), movedIds: new Set(["SAGA-3"]) },
  );

  expect(cardTitles()).toHaveLength(20);
  expect(screen.getByRole("button", { name: "Show all" })).toBeTruthy();
});

it("moves focus to the first card Show all reveals", async () => {
  const user = userEvent.setup();
  await renderColumn({ final: true, matching: entries(25), total: 25 });

  await user.click(screen.getByRole("button", { name: "Show all" }));

  const rows = within(screen.getByRole("list", { name: "In Progress" })).getAllByRole("listitem");
  expect(document.activeElement).toBe(rows[20]);
  expect(document.activeElement?.textContent).toContain("Task 21");
});

it("moves focus to the heading when the first revealed card is outside a virtual window", async () => {
  const user = userEvent.setup();
  await renderColumn({ final: true, matching: entries(60), total: 60 });

  await user.click(screen.getByRole("button", { name: "Show all" }));

  expect(screen.getAllByRole("listitem")[0]?.getAttribute("aria-setsize")).toBe("60");
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "In Progress" }));
});

describe("Show all on a final column of more than 50 cards, scrolled down to it", () => {
  const LIST_TOP = 3000;
  const CARD_HEIGHT = 60;
  const ROW = CARD_HEIGHT + 8;
  // The 17th card is at the top of the view, so "Show all" is in view.
  const SCROLL_Y = LIST_TOP + 16 * ROW;
  const scrollTo = vi.fn<(options: ScrollToOptions) => void>();

  /* The lists start LIST_TOP pixels down the page, and a card is shorter than the column estimates it. */
  beforeEach(() => {
    scrollTo.mockClear();
    vi.stubGlobal("scrollTo", scrollTo);
    vi.stubGlobal("scrollY", SCROLL_Y);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "LI" ? CARD_HEIGHT : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ top: LIST_TOP - window.scrollY }) as DOMRect,
    );
  });

  function row(index: number): HTMLElement | null {
    return document.querySelector(`li[data-index="${String(index)}"]`);
  }

  it("moves focus to the first card it reveals", async () => {
    const user = userEvent.setup();
    await renderColumn({ final: true, matching: entries(57), total: 57 });

    await user.click(screen.getByRole("button", { name: "Show all" }));

    expect(row(20)?.getAttribute("aria-setsize")).toBe("57");
    expect(document.activeElement).toBe(row(20));
    expect(document.activeElement?.textContent).toContain("Task 21");
  });

  it("keeps the cards in view in place, and does not scroll the page", async () => {
    const user = userEvent.setup();
    await renderColumn({ final: true, matching: entries(57), total: 57 });
    // The router scrolls to the top when it mounts.
    scrollTo.mockClear();

    await user.click(screen.getByRole("button", { name: "Show all" }));

    expect(row(19)?.style.transform).toBe(`translateY(${String(19 * ROW)}px)`);
    expect(row(20)?.style.transform).toBe(`translateY(${String(20 * ROW)}px)`);
    expect(scrollTo.mock.calls.map(([options]) => options.top).filter((top) => top !== SCROLL_Y)).toEqual([]);
  });
});

describe("a focus id under and above the cap", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("opens Show all, and focus goes to the card's menu button, not to the first revealed row", async () => {
    const onMenuFocused = vi.fn();

    await renderColumn({ final: true, matching: entries(25), total: 25 }, { focusId: "SAGA-23", onMenuFocused });

    expect(cardTitles()).toHaveLength(25);
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
    expect(document.activeElement).toBe(menuButton("Task 23"));
    expect(onMenuFocused).toHaveBeenCalledOnce();
  });

  it("keeps the column folded for a focus id above the cap", async () => {
    await renderColumn({ final: true, matching: entries(25), total: 25 }, { focusId: "SAGA-20" });

    expect(cardTitles()).toHaveLength(20);
    expect(document.activeElement).toBe(menuButton("Task 20"));
  });
});

describe("Move up and Move down", () => {
  it("offer only the places a visible card of the column holds", async () => {
    await renderColumn({ matching: entries(3), total: 5 }, { filtered: true });

    expect(await placeItems("Task 1")).toEqual(["Move down"]);
    expect(await placeItems("Task 2")).toEqual(["Move up", "Move down"]);
    expect(await placeItems("Task 3")).toEqual(["Move up"]);
  });

  it("offer nothing on the one card of a column", async () => {
    await renderColumn({ matching: entries(1), total: 1 });

    expect(await placeItems("Task 1")).toEqual([]);
  });

  it("count the cards under the cap of a folded final column", async () => {
    await renderColumn({ final: true, matching: entries(25), total: 25 });

    expect(await placeItems("Task 20")).toEqual(["Move up", "Move down"]);
  });

  it.each([
    { name: "Move up", by: -1 },
    { name: "Move down", by: 1 },
  ])("$name moves the card by $by", async ({ name, by }) => {
    const onMoveBy = vi.fn();
    const user = userEvent.setup();
    await renderColumn({ matching: entries(3), total: 3 }, { onMoveBy });

    await user.click(menuButton("Task 2"));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name }));

    expect(onMoveBy.mock.calls).toEqual([["SAGA-2", by]]);
  });
});

it("underlines Show all at rest", async () => {
  await renderColumn({ final: true, matching: entries(25), total: 25 });

  expect(screen.getByRole("button", { name: "Show all" }).classList.contains("underline")).toBe(true);
});

it("keeps the separator before Show all clear of the focus ring", async () => {
  await renderColumn({ final: true, matching: entries(25), total: 25 });

  const separator = screen.getByRole("button", { name: "Show all" }).previousElementSibling;
  expect(separator?.textContent).toBe(" · ");
  expect(separator?.classList.contains("mx-1")).toBe(true);
});

it("shows every card of an open column", async () => {
  await renderColumn({ matching: entries(25), total: 25 });

  expect(cardTitles()).toHaveLength(25);
  expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
});

it("shows every card of a final column that holds 20 or fewer", async () => {
  await renderColumn({ final: true, matching: entries(20), total: 20 });

  expect(cardTitles()).toHaveLength(20);
  expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
});

it("renders more than 50 cards through a list that holds only the rows in view", async () => {
  await renderColumn({ matching: entries(60), total: 60 });

  const rows = within(screen.getByRole("list", { name: "In Progress" })).getAllByRole("listitem");
  expect(rows.length).toBeLessThan(60);
  expect(rows[0]?.getAttribute("aria-setsize")).toBe("60");
});

it("renders 50 cards as a plain list", async () => {
  await renderColumn({ matching: entries(50), total: 50 });

  const rows = within(screen.getByRole("list", { name: "In Progress" })).getAllByRole("listitem");
  expect(rows).toHaveLength(50);
  expect(rows[0]?.getAttribute("aria-setsize")).toBeNull();
});

describe("the slot a drag shows", () => {
  function rows(): HTMLElement[] {
    return [...screen.getByRole("list").querySelectorAll("li")];
  }

  /** The task each row holds, empty for the slot. */
  function held(): (string | null)[] {
    return rows().map((row) => row.querySelector("[data-task-id]")?.getAttribute("data-task-id") ?? null);
  }

  it("stands before the card that holds the place, and counts in no list index", async () => {
    await renderColumn(
      { matching: entries(3), total: 3 },
      { draggingId: "SAGA-2", slot: { index: 1, height: 60 } },
    );

    const slot = rows()[2];
    expect(held()).toEqual(["SAGA-1", "SAGA-2", null, "SAGA-3"]);
    expect(rows().map((row) => row.getAttribute("data-index"))).toEqual(["0", "1", null, "2"]);
    expect(slot?.getAttribute("aria-hidden")).toBe("true");
    expect(slot?.firstElementChild?.getAttribute("style")).toBe("height: 60px;");
    expect(slot?.firstElementChild?.className).toContain("border-dashed");
  });

  it("ends the list when the place is under the last rendered card", async () => {
    await renderColumn(
      { matching: entries(2), total: 2 },
      { draggingId: "SAGA-1", slot: { index: 1, height: 60 } },
    );

    expect(held()).toEqual(["SAGA-1", "SAGA-2", null]);
  });

  it("stands outside a list in a column with no card, which reports no list at all", async () => {
    await renderColumn({ matching: [], total: 0 }, { draggingId: "SAGA-9", slot: { index: 0, height: 60 } });

    const region = screen.getByRole("region", { name: "In Progress" });
    expect(screen.queryByRole("list")).toBeNull();
    expect(region.querySelector("[data-drag-slot]")?.getAttribute("style")).toBe("height: 60px;");
  });

  it("stands where the cap hides the card that holds the place", async () => {
    await renderColumn(
      { final: true, matching: entries(25), total: 25 },
      { draggingId: "SAGA-25", slot: { index: 20, height: 60 } },
    );

    expect(rows()).toHaveLength(21);
    expect(rows()[20]?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is no part of the list a virtual column reports", async () => {
    await renderColumn(
      { matching: entries(60), total: 60 },
      { draggingId: "SAGA-1", slot: { index: 3, height: 60 } },
    );

    const listed = rows();
    const slot = listed.find((row) => row.querySelector("[data-drag-slot]") !== null)!;
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(listed.map((row) => row.getAttribute("aria-setsize"))).toEqual(Array.from(listed, () => "60"));
    expect(listed.filter((row) => row !== slot).map((row) => row.getAttribute("data-index")))
      .toEqual(Array.from({ length: listed.length - 1 }, (_, index) => String(index)));
    // The virtualizer measures rows by their own index, which the slot holds too.
    expect(listed.map((row) => row.getAttribute("data-row-index")))
      .toEqual(Array.from(listed, (_, index) => String(index)));
  });

  it("shows no slot while no drag names this column", async () => {
    await renderColumn({ matching: entries(3), total: 3 }, { draggingId: "SAGA-2" });

    expect(screen.getByRole("list").querySelector("[data-drag-slot]")).toBeNull();
    expect(rows()).toHaveLength(3);
  });
});

it("leaves the card a drag carries in place, dimmed", async () => {
  await renderColumn({ matching: entries(2), total: 2 }, { draggingId: "SAGA-1" });

  const cards = screen.getAllByText(/^Task \d+$/).map((title) => title.closest("[data-task-id]"));
  expect(cards[0]?.className).toContain("opacity-35");
  expect(cards[1]?.className).not.toContain("opacity-35");
});

it("names its position, so a drag can read the board", async () => {
  await renderColumn({ matching: entries(1), total: 1 }, { place: 2 });

  expect(screen.getByRole("region", { name: "In Progress" }).getAttribute("data-column-index")).toBe("2");
});
