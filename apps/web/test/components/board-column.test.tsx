import type { Frontmatter, TaskEntry, Workflow } from "@tasma/protocol";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardColumn } from "../../src/components/board-column";
import type { ColumnData } from "../../src/lib/board";
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
  instructions: [],
  steps: [{ name: "implement", file: "/w/dev/implement.md", owner: "agent" }],
};

async function renderColumn(column: Partial<ColumnData>, filtered = false) {
  const data: ColumnData = { status: "In Progress", final: false, matching: [], total: 0, ...column };

  return renderBesideTaskRoute(
    <BoardColumn
      tag="SAGA"
      column={data}
      filtered={filtered}
      priorities={["high", "low"]}
      workflows={new Map([["dev", WORKFLOW]])}
      statuses={["To Do", "In Progress", "Done"]}
      pendingIds={new Set()}
      onMove={() => {}}
      focusId={null}
      onMenuFocused={() => {}}
    />,
  );
}

function cardTitles(): string[] {
  return screen.getAllByText(/^Task \d+$/).map((title) => title.textContent);
}

/* jsdom has no layout; a card measures as tall as the column estimates it. */
beforeEach(() => {
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
  await renderColumn({ matching: entries(2), total: 5 }, true);

  expect(screen.getByRole("heading", { level: 2 }).nextElementSibling?.textContent).toBe("2 of 5");
});

it("renders no list for a column with no card", async () => {
  await renderColumn({ matching: [], total: 4 }, true);

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
