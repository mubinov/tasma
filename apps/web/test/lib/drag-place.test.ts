import { describe, expect, it } from "vitest";
import { dropPlace, samePlace, scrollStep, type CardBox, type ColumnBox, type DragGeometry } from "../../src/lib/drag-place";

const GAP = 8;
const CARD = 100;
const ROW = CARD + GAP;
/** The first card's top. The column starts above it, under its header. */
const TOP = 200;
const HEADER = 40;
const WIDTH = 280;

/**
 * A column of cards `CARD` tall. `indexes` is each rendered row's index in the
 * visible list without the moved card, `null` for the moved card's own row.
 * `slotAt` inserts the slot at that row, which pushes the rows under it down.
 */
function column(index: number, left: number, indexes: readonly (number | null)[], slotAt?: number): ColumnBox {
  const rows: (number | null | "slot")[] = [...indexes];
  if (slotAt !== undefined) {
    rows.splice(slotAt, 0, "slot");
  }

  const cards: CardBox[] = [];
  let slot: ColumnBox["slot"] = null;

  for (const [row, at] of rows.entries()) {
    const top = TOP + row * ROW;
    if (at === "slot") {
      slot = { top, height: CARD };
    } else {
      cards.push({ top, height: CARD, index: at });
    }
  }

  return { index, left, right: left + WIDTH, top: TOP - HEADER, cards, slot };
}

function geometry(...columns: ColumnBox[]): DragGeometry {
  return { columns, gap: GAP };
}

/** The pointer at the middle of the card standing at `row`, `off` pixels down. */
function atRow(row: number, off = 0): { x: number; y: number } {
  return { x: 100, y: TOP + row * ROW + CARD / 2 + off };
}

describe("the column under the pointer", () => {
  const BOARD = geometry(column(0, 0, [0, 1]), column(1, 320, [0]));

  it("has no bottom edge, so the empty area under a short column is its end", () => {
    expect(dropPlace({ x: 100, y: 4_000 }, BOARD)).toEqual({ column: 0, index: 2 });
  });

  it("is none in the gap between two columns", () => {
    expect(dropPlace({ x: 300, y: TOP }, BOARD)).toBeNull();
  });

  it("is none above the row of columns", () => {
    expect(dropPlace({ x: 100, y: TOP - HEADER - 1 }, BOARD)).toBeNull();
  });

  it("is the one the pointer stands in", () => {
    expect(dropPlace({ x: 400, y: TOP }, BOARD)).toEqual({ column: 1, index: 0 });
  });

  it("holds its own edges", () => {
    expect(dropPlace({ x: WIDTH, y: TOP - HEADER }, BOARD)).toEqual({ column: 0, index: 0 });
  });
});

describe("the place in the column", () => {
  it("is the first card whose middle is below the pointer", () => {
    const board = geometry(column(0, 0, [0, 1, 2]));

    expect(dropPlace(atRow(0, -1), board)).toEqual({ column: 0, index: 0 });
    expect(dropPlace(atRow(0, 1), board)).toEqual({ column: 0, index: 1 });
    expect(dropPlace(atRow(1, 1), board)).toEqual({ column: 0, index: 2 });
  });

  it("is after the last card when no card is below the pointer", () => {
    expect(dropPlace(atRow(2, 1), geometry(column(0, 0, [0, 1, 2])))).toEqual({ column: 0, index: 3 });
  });

  it("is the first of a column with no card", () => {
    expect(dropPlace({ x: 100, y: TOP }, geometry(column(0, 0, [])))).toEqual({ column: 0, index: 0 });
  });

  it("leaves the moved card's own row out of the count", () => {
    const board = geometry(column(0, 0, [0, null, 1]));

    expect(dropPlace(atRow(1, 1), board)).toEqual({ column: 0, index: 1 });
    expect(dropPlace(atRow(2, 1), board)).toEqual({ column: 0, index: 2 });
  });

  it("reads the geometry as if no slot were shown", () => {
    const shown = geometry(column(0, 0, [0, 1, 2], 1));
    const hidden = geometry(column(0, 0, [0, 1, 2]));

    for (const point of [atRow(0, -1), atRow(0, 1), atRow(1, 1), atRow(2, 1)]) {
      expect(dropPlace(point, shown)).toEqual(dropPlace(point, hidden));
    }
  });
});

describe("a folded final column, which renders its first 20 cards", () => {
  const CAP = 20;

  it("ends after the 19th other card when the moved card is one of the 20", () => {
    const indexes = Array.from({ length: CAP }, (_, row) => (row === 5 ? null : row - (row > 5 ? 1 : 0)));

    expect(dropPlace({ x: 100, y: 9_000 }, geometry(column(0, 0, indexes)))).toEqual({ column: 0, index: 19 });
  });

  it("ends after the 20th card when the moved card comes from another column", () => {
    const indexes = Array.from({ length: CAP }, (_, row) => row);

    expect(dropPlace({ x: 100, y: 9_000 }, geometry(column(0, 0, indexes)))).toEqual({ column: 0, index: 20 });
  });
});

describe("two places", () => {
  it("are the same only when both are none or both name the same column and index", () => {
    expect(samePlace(null, null)).toBe(true);
    expect(samePlace(null, { column: 0, index: 0 })).toBe(false);
    expect(samePlace({ column: 0, index: 0 }, null)).toBe(false);
    expect(samePlace({ column: 0, index: 1 }, { column: 0, index: 1 })).toBe(true);
    expect(samePlace({ column: 0, index: 1 }, { column: 1, index: 1 })).toBe(false);
    expect(samePlace({ column: 0, index: 1 }, { column: 0, index: 2 })).toBe(false);
  });
});

describe("the scroll of a frame", () => {
  const VIEWPORT = { width: 1_000, height: 800 };

  it("is nothing while the pointer is clear of every edge", () => {
    expect(scrollStep({ x: 500, y: 400 }, VIEWPORT)).toEqual({ x: 0, y: 0 });
  });

  it("goes toward the edge the pointer is near, and grows with the depth into the band", () => {
    expect(scrollStep({ x: 40, y: 400 }, VIEWPORT)).toEqual({ x: -3, y: 0 });
    expect(scrollStep({ x: 24, y: 400 }, VIEWPORT)).toEqual({ x: -8, y: 0 });
    expect(scrollStep({ x: 500, y: 776 }, VIEWPORT)).toEqual({ x: 0, y: 8 });
    expect(scrollStep({ x: 976, y: 760 }, VIEWPORT)).toEqual({ x: 8, y: 3 });
  });

  it("stops at the cap, at the edge and past it", () => {
    expect(scrollStep({ x: 0, y: 800 }, VIEWPORT)).toEqual({ x: -16, y: 16 });
    expect(scrollStep({ x: -400, y: 1_200 }, VIEWPORT)).toEqual({ x: -16, y: 16 });
  });
});
