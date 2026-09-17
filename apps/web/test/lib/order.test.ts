import type { Frontmatter, TaskEntry } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { applyPending, buildColumns } from "../../src/lib/board";
import { fullIndex, placeWrites } from "../../src/lib/order";

const STATUS = "Open";

function entry(id: string, fields: Partial<Frontmatter> = {}): TaskEntry {
  return {
    id,
    path: `/tasks/${id}.md`,
    blocked: false,
    frontmatter: {
      id,
      title: `Task ${id}`,
      status: STATUS,
      created: "2026-09-01T10:00:00Z",
      updated: "2026-09-01T10:00:00Z",
      next_comment_id: 1,
      ...fields,
    },
  };
}

function ids(entries: readonly TaskEntry[]): string[] {
  return entries.map(({ id }) => id);
}

/** The entries as a column of the board shows them. */
function display(entries: readonly TaskEntry[], final: boolean): TaskEntry[] {
  const [column] = buildColumns({ statuses: [STATUS], final_statuses: final ? [STATUS] : [] }, entries, []);

  return column!.matching;
}

const MOVED = entry("T-99");

type Row = {
  name: string;
  final?: boolean;
  column: TaskEntry[];
  index: number;
  writes: [string, number][];
};

const ROWS: Row[] = [
  { name: "the column is empty", column: [], index: 0, writes: [["T-99", 0]] },
  {
    name: "no prev, and next has an order",
    column: [entry("T-1", { order: 500 }), entry("T-2", { order: 900 })],
    index: 0,
    writes: [["T-99", -500]],
  },
  { name: "no prev, and next has no order", column: [entry("T-1"), entry("T-2")], index: 0, writes: [["T-99", 0]] },
  {
    name: "prev and next have an order 2 apart",
    column: [entry("T-1", { order: 4 }), entry("T-2", { order: 6 })],
    index: 1,
    writes: [["T-99", 5]],
  },
  {
    name: "prev and next have an order an odd distance apart",
    column: [entry("T-1", { order: 0 }), entry("T-2", { order: 1001 })],
    index: 1,
    writes: [["T-99", 500]],
  },
  {
    name: "prev has an order, and next has none",
    column: [entry("T-1", { order: 300 }), entry("T-2")],
    index: 1,
    writes: [["T-99", 1300]],
  },
  { name: "prev has an order, and there is no next", column: [entry("T-1", { order: 300 })], index: 1, writes: [["T-99", 1300]] },
  {
    name: "prev has no order, below an ordered card",
    column: [entry("T-1", { order: -50 }), entry("T-2"), entry("T-3"), entry("T-4")],
    index: 3,
    writes: [["T-2", 950], ["T-3", 1950], ["T-99", 2950]],
  },
  {
    name: "prev has no order, and no card has one",
    column: [entry("T-1"), entry("T-2"), entry("T-3")],
    index: 2,
    writes: [["T-1", 0], ["T-2", 1000], ["T-99", 2000]],
  },
  {
    name: "prev has no order in a final column, whose cards without order sort by update time",
    final: true,
    column: [
      entry("T-1", { order: 10 }),
      entry("T-3", { updated: "2026-09-05T10:00:00Z" }),
      entry("T-4", { updated: "2026-09-04T10:00:00Z" }),
      entry("T-2", { updated: "2026-09-03T10:00:00Z" }),
    ],
    index: 3,
    writes: [["T-3", 1010], ["T-4", 2010], ["T-99", 3010]],
  },
  {
    name: "prev and next are 1 apart, and the walk stops at a greater order",
    column: [entry("T-1", { order: 0 }), entry("T-2", { order: 1 }), entry("T-3", { order: 2 }), entry("T-4", { order: 5000 })],
    index: 1,
    writes: [["T-3", 3000], ["T-2", 2000], ["T-99", 1000]],
  },
  {
    name: "prev and next have equal orders, and the walk goes to the end",
    column: [entry("T-1", { order: 7 }), entry("T-2", { order: 7 }), entry("T-3", { order: 7 })],
    index: 1,
    writes: [["T-3", 3007], ["T-2", 2007], ["T-99", 1007]],
  },
  {
    name: "prev and next are 1 apart, and the walk stops at a card without order",
    column: [entry("T-1", { order: 0 }), entry("T-2", { order: 1 }), entry("T-3", { order: 1500 }), entry("T-4")],
    index: 1,
    writes: [["T-3", 3000], ["T-2", 2000], ["T-99", 1000]],
  },
  {
    name: "prev and next are 1 apart in a final column",
    final: true,
    column: [entry("T-1", { order: 0 }), entry("T-2", { order: 1 }), entry("T-3", { updated: "2026-09-05T10:00:00Z" })],
    index: 1,
    writes: [["T-2", 2000], ["T-99", 1000]],
  },
];

describe("placeWrites", () => {
  it.each(ROWS)("writes the orders when $name", ({ column, final = false, index, writes }) => {
    const shown = display(column, final);
    expect(ids(shown)).toEqual(ids(column));

    expect(placeWrites(shown, MOVED, index)).toEqual(writes.map(([id, order]) => ({ id, change: { order } })));
  });

  it.each(ROWS)("keeps the other cards in sequence after each write, and lands the card at its place, when $name", ({
    column,
    final = false,
    index,
  }) => {
    const shown = display(column, final);
    const writes = placeWrites(shown, MOVED, index);

    for (let count = 0; count <= writes.length; count += 1) {
      const pending = writes.slice(0, count).map((write) => ({ ...write, submittedAt: 0 }));
      const after = ids(display(applyPending([...shown, MOVED], pending), final));

      expect(after.filter((id) => id !== MOVED.id)).toEqual(ids(shown));
      if (count === writes.length) {
        expect(after).toEqual(ids(shown.toSpliced(index, 0, MOVED)));
      }
    }
  });

  it("puts the status on the moved card's write alone", () => {
    const column = [entry("T-1"), entry("T-2")];

    expect(placeWrites(column, entry("T-99", { status: "Done" }), 2, STATUS)).toEqual([
      { id: "T-1", change: { order: 0 } },
      { id: "T-2", change: { order: 1000 } },
      { id: "T-99", change: { status: STATUS, order: 2000 } },
    ]);
  });

  it("leaves out the moved card's write when the card already holds its values", () => {
    const column = [entry("T-1", { order: 500 })];

    expect(placeWrites(column, entry("T-99", { order: -500 }), 0)).toEqual([]);
    expect(placeWrites(column, entry("T-99", { order: -500 }), 0, STATUS)).toEqual([]);
  });

  it("keeps the moved card's write when only its status differs", () => {
    expect(placeWrites([], entry("T-99", { status: "Done", order: 0 }), 0, STATUS)).toEqual([
      { id: "T-99", change: { status: STATUS, order: 0 } },
    ]);
  });

  it("keeps the walk's writes when the moved card already holds its order", () => {
    expect(placeWrites([entry("T-1"), entry("T-2")], entry("T-99", { order: 1000 }), 1)).toEqual([
      { id: "T-1", change: { order: 0 } },
    ]);
  });
});

describe("fullIndex", () => {
  const A = entry("T-1");
  const B = entry("T-2");
  const HIDDEN = entry("T-5");

  it.each([
    { name: "the first place, with a hidden card above", column: [HIDDEN, A, B], visibleIndex: 0, index: 1 },
    { name: "the first place, with no hidden card above", column: [A, HIDDEN, B], visibleIndex: 0, index: 0 },
    { name: "a place between two visible cards, with a hidden card between", column: [A, HIDDEN, B], visibleIndex: 1, index: 1 },
    { name: "the last place, with a hidden card below", column: [A, B, HIDDEN], visibleIndex: 2, index: 2 },
  ])("puts $name directly after the visible card above it, or before the first visible card", ({
    column,
    visibleIndex,
    index,
  }) => {
    expect(fullIndex(column, [A, B], visibleIndex)).toBe(index);
  });

  it("gives 0 when no card is visible", () => {
    expect(fullIndex([HIDDEN, entry("T-6")], [], 0)).toBe(0);
  });

  it("finds the visible cards in the column by id, so both lists can come from different reads", () => {
    const column = [HIDDEN, A, B].map((card) => structuredClone(card));

    expect(fullIndex(column, [A, B], 0)).toBe(1);
    expect(fullIndex(column, [A, B], 2)).toBe(3);
  });

  it("throws when a visible card is not in the column", () => {
    expect(() => fullIndex([A], [A, B], 2)).toThrow("T-2 is not in the column");
    expect(() => fullIndex([A], [B], 0)).toThrow("T-2 is not in the column");
  });

  it.each([-1, 3])("throws for the place %i, which the visible list does not hold", (visibleIndex) => {
    expect(() => fullIndex([A, HIDDEN, B], [A, B], visibleIndex))
      .toThrow(`${String(visibleIndex)} is not a place in the visible list`);
  });
});
