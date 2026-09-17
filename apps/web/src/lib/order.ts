import type { TaskEntry } from "@tasma/protocol";
import type { TaskWrite } from "./board";

const STEP = 1000;

function hasOrder(entry: TaskEntry | undefined): entry is TaskEntry & { frontmatter: { order: number } } {
  return typeof entry?.frontmatter.order === "number";
}

/**
 * The writes that put `moved` at `index` of `column`: the other cards first, the
 * moved card last. Each prefix of them keeps the other cards in their sequence.
 * A write that changes no stored value is left out.
 *
 * @param column Every task of the target column in display order, the tasks the
 *   label filter hides included, `moved` excluded.
 * @param status Given only when the card changes column.
 */
export function placeWrites(
  column: readonly TaskEntry[],
  moved: TaskEntry,
  index: number,
  status?: string,
): TaskWrite[] {
  const prev = column[index - 1];
  const next = column[index];
  const others: TaskWrite[] = [];
  let order: number;

  if (prev === undefined) {
    order = hasOrder(next) ? next.frontmatter.order - STEP : 0;
  } else if (!hasOrder(prev)) {
    // Ordered cards sort before the others, so every card from the first one
    // without order down to `prev` has none.
    const unorderedFrom = column.findIndex((entry) => !hasOrder(entry));
    const lastOrdered = column[unorderedFrom - 1];
    let lastOrder = hasOrder(lastOrdered) ? lastOrdered.frontmatter.order : -STEP;

    for (const entry of column.slice(unorderedFrom, index)) {
      lastOrder += STEP;
      others.push({ id: entry.id, change: { order: lastOrder } });
    }
    order = lastOrder + STEP;
  } else if (!hasOrder(next)) {
    order = prev.frontmatter.order + STEP;
  } else if (next.frontmatter.order - prev.frontmatter.order >= 2) {
    order = prev.frontmatter.order + Math.floor((next.frontmatter.order - prev.frontmatter.order) / 2);
  } else {
    order = prev.frontmatter.order + STEP;
    let lastOrder = order;

    for (const entry of column.slice(index)) {
      if (!hasOrder(entry) || entry.frontmatter.order > lastOrder) {
        break;
      }
      lastOrder += STEP;
      // Bottom-up: a card raised before the card below it would pass that card.
      others.unshift({ id: entry.id, change: { order: lastOrder } });
    }
  }

  const unchanged = moved.frontmatter.order === order && (status === undefined || moved.frontmatter.status === status);
  if (unchanged) {
    return others;
  }

  return [...others, { id: moved.id, change: status === undefined ? { order } : { status, order } }];
}

function indexIn(column: readonly TaskEntry[], card: TaskEntry): number {
  const index = column.findIndex(({ id }) => id === card.id);
  if (index === -1) {
    throw new Error(`${card.id} is not in the column`);
  }

  return index;
}

/**
 * The place in `column` of a place in the visible list: directly after the
 * visible card above it, or directly before the first visible card.
 *
 * @param visible The column after the label filter, the moved task excluded.
 */
export function fullIndex(column: readonly TaskEntry[], visible: readonly TaskEntry[], visibleIndex: number): number {
  if (visibleIndex < 0 || visibleIndex > visible.length) {
    throw new Error(`${String(visibleIndex)} is not a place in the visible list`);
  }

  const above = visible[visibleIndex - 1];
  if (above !== undefined) {
    return indexIn(column, above) + 1;
  }

  const firstVisible = visible[0];
  return firstVisible === undefined ? 0 : indexIn(column, firstVisible);
}
