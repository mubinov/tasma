/** A point in viewport coordinates. */
export type Point = { x: number; y: number };

/** Pixels between two cards of a column. */
export const CARD_GAP = 8;

/**
 * The attributes a drag reads the board off the page through: the column's
 * place in the row on its section, the task's id on its card, and the place a
 * drop writes to on the slot. Written through this constant too, so a rename
 * keeps the readers and the writers on the same names.
 */
export const DRAG_ATTRIBUTE = {
  column: "data-column-index",
  card: "data-task-id",
  slot: "data-drag-slot",
} as const;

/**
 * A rendered card row. `index` is the row's place in its column's visible list
 * without the moved card; the moved card's own row has none.
 */
export type CardBox = { top: number; height: number; index: number | null };

export type ColumnBox = {
  /** The column's position in the board's row. */
  index: number;
  left: number;
  right: number;
  top: number;
  /** In list order. */
  cards: readonly CardBox[];
  /** The slot the drag shows, given only for the column that holds it. */
  slot: { top: number; height: number } | null;
};

export type DragGeometry = {
  columns: readonly ColumnBox[];
  /** Pixels between two rows of a column's list. */
  gap: number;
};

/**
 * Where a card sits on the board: the column's position in the row, and the
 * card's index in that column's visible list without the dragged card.
 */
export type DropPlace = { column: number; index: number };

export function samePlace(a: DropPlace | null, b: DropPlace | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }

  return a.column === b.column && a.index === b.index;
}

/**
 * Where a card dropped at `point` lands, `null` in the gap between two columns
 * and above the row of columns.
 *
 * A column holds every point between its side edges and below its top edge, so
 * the empty area under a short column is its end. The slot is measured away, so
 * the place does not depend on where the slot stands.
 */
export function dropPlace(point: Point, geometry: DragGeometry): DropPlace | null {
  const column = geometry.columns.find(
    (candidate) => point.x >= candidate.left && point.x <= candidate.right && point.y >= candidate.top,
  );

  if (column === undefined) {
    return null;
  }

  const slotTop = column.slot?.top ?? Number.POSITIVE_INFINITY;
  const shift = column.slot === null ? 0 : column.slot.height + geometry.gap;
  let after = 0;

  for (const { top, height, index } of column.cards) {
    if (index === null) {
      continue;
    }
    if (point.y < (top >= slotTop ? top - shift : top) + height / 2) {
      return { column: column.index, index };
    }
    after = index + 1;
  }

  return { column: column.index, index: after };
}

/** How near an edge of the viewport a drag starts scrolling the page. */
const EDGE_BAND = 48;

/** The most one frame scrolls. */
const MAX_STEP = 16;

/** Grows with the depth into the band, and stops at the cap outside the viewport. */
function step(distance: number): number {
  return Math.ceil((Math.min(EDGE_BAND - distance, EDGE_BAND) / EDGE_BAND) * MAX_STEP);
}

function axisStep(at: number, length: number): number {
  if (at < EDGE_BAND) {
    return -step(at);
  }
  if (length - at < EDGE_BAND) {
    return step(length - at);
  }

  return 0;
}

/** The pixels a frame of a drag scrolls the page, so a drag reaches past the viewport. */
export function scrollStep(point: Point, viewport: { width: number; height: number }): Point {
  return { x: axisStep(point.x, viewport.width), y: axisStep(point.y, viewport.height) };
}
