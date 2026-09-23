import type { TaskEntry, Workflow } from "@tasma/protocol";
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { isTopPriority, stepView, type ColumnData } from "../lib/board";
import { CARD_GAP, DRAG_ATTRIBUTE } from "../lib/drag-place";
import { PlusIcon } from "../lib/icons";
import { revealedColumnKey, useUiStore } from "../store/ui";
import { TaskCard, type CardFocus } from "./task-card";
import { PageVirtualList } from "./virtual-list";

type BoardColumnProps = {
  /** The tag of the project the board shows. */
  tag: string;
  /** The column's place on the board, which tells two columns of one status apart. */
  place: number;
  column: ColumnData;
  /** Labels are selected. */
  filtered: boolean;
  priorities: readonly string[];
  /** By name: the workflow, `null` for a refused read, `undefined` while pending. */
  workflows: ReadonlyMap<string, Workflow | null | undefined>;
  /** The project's statuses, in order. */
  statuses: readonly string[];
  /** The ids of the tasks a write the daemon has not answered yet changes. */
  pendingIds: ReadonlySet<string>;
  /** Of those, the ids of the tasks such a write moves rather than renumbers. */
  movedIds: ReadonlySet<string>;
  onMove: (id: string, status: string) => void;
  /** Moves the card one visible place up (`-1`) or down (`1`) in this column. */
  onMoveBy: (id: string, by: -1 | 1) => void;
  /** Called before the card opens its task in this tab. */
  onOpen: (id: string) => void;
  /** Asks to delete the task. */
  onDelete: (id: string) => void;
  /** The card that takes focus once it renders. */
  focusCard: CardFocus | null;
  onCardFocused: () => void;
  /** The heading takes focus, after which `onHeaderFocused` is called. */
  focusHeading: boolean;
  onHeaderFocused: () => void;
  /** Opens the create dialog on this column's status. `opener` is the control pressed. */
  onCreate: (status: string, opener: HTMLElement) => void;
  /** The task a drag carries, whose card stays in place at the origin. */
  draggingId: string | null;
  /** The slot a drag shows here: its index in the visible list without the dragged card. */
  slot?: { index: number; height: number };
  /** Every press on a card, whether or not it becomes a drag. */
  onPress: (event: PointerEvent<HTMLElement>, id: string) => void;
};

const FINAL_CAP = 20;
const VIRTUAL_ABOVE = 50;
const ESTIMATED_CARD_HEIGHT = 96;

/** A card, and its place in the column's rendered list, which the slot is no part of. */
type CardRow = { entry: TaskEntry; at: number };

type SlotRow = { height: number };

type Row = CardRow | SlotRow;

function isSlot(row: Row): row is SlotRow {
  return "height" in row;
}

/** The place a drop writes to, drawn as a gap of the dragged card's size. */
function DragSlot({ height }: { height: number }): ReactNode {
  return (
    <div
      {...{ [DRAG_ATTRIBUTE.slot]: "" }}
      style={{ height: `${String(height)}px` }}
      className="rounded-card border border-graphic border-dashed"
    />
  );
}

/**
 * The row of the rendered list the slot stands at, and the row it draws: before
 * the card that holds the place, or after the last rendered card when the cap
 * hides that card.
 */
function slotRow(
  shown: readonly TaskEntry[],
  visible: readonly TaskEntry[],
  slot: { index: number; height: number } | undefined,
): { at: number; row: SlotRow } | null {
  if (slot === undefined) {
    return null;
  }

  const below = visible[slot.index];
  const at = below === undefined ? -1 : shown.findIndex((entry) => entry.id === below.id);

  return { at: at === -1 ? shown.length : at, row: { height: slot.height } };
}

export function BoardColumn({
  tag,
  place,
  column,
  filtered,
  priorities,
  workflows,
  statuses,
  pendingIds,
  movedIds,
  onMove,
  onMoveBy,
  onOpen,
  onDelete,
  focusCard,
  onCardFocused,
  focusHeading,
  onHeaderFocused,
  onCreate,
  draggingId,
  slot,
  onPress,
}: BoardColumnProps): ReactNode {
  const { status, final, matching, total } = column;
  const focusId = focusCard?.id ?? null;
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const plainListRef = useRef<HTMLUListElement>(null);
  // In the store rather than in this component: the board unmounts while a task
  // page is open, and a card revealed here has to be back in place on return.
  const showAll = useUiStore((state) => state.revealedColumns.has(revealedColumnKey(tag, place)));
  const revealColumn = useUiStore((state) => state.revealColumn);
  // By id: the heights the capped cards had when the column opened in full.
  const [cardHeights, setCardHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const capped = final && !showAll && matching.length > FINAL_CAP;
  const shown = capped ? matching.slice(0, FINAL_CAP) : matching;

  // The cap gives way to a card bound for focus, and to the card a move in
  // flight places: a drop can land one past the cap, and it has to be seen to
  // land. The cards that move only renumbers leave the fold as the user set it.
  const hiddenByCap = capped
    && matching.slice(FINAL_CAP).some((entry) => entry.id === focusId || movedIds.has(entry.id));
  const placed = slotRow(shown, matching.filter((entry) => entry.id !== draggingId), slot);
  const cards: Row[] = shown.map((entry, at) => ({ entry, at }));
  const items = placed === null ? cards : cards.toSpliced(placed.at, 0, placed.row);
  const focusIndex = items.findIndex((row) => !isSlot(row) && row.entry.id === focusId);

  function openAll(): void {
    const rows = plainListRef.current?.children ?? [];

    setCardHeights(new Map(shown.map((entry, at) => [entry.id, (rows[at] as HTMLElement).offsetHeight])));
    revealColumn(tag, place);
  }

  // Focus stays where it is: the card to focus takes it once it renders.
  const openKeepingFocus = useEffectEvent(openAll);

  useLayoutEffect(() => {
    if (hiddenByCap) {
      openKeepingFocus();
    }
  }, [hiddenByCap]);

  const takeHeadingFocus = useEffectEvent(() => {
    headingRef.current?.focus();
    onHeaderFocused();
  });

  useEffect(() => {
    if (focusHeading) {
      takeHeadingFocus();
    }
  }, [focusHeading]);

  function openMovingFocus(): void {
    // The revealed cards have to be in the DOM, and placed by a virtual list,
    // before focus moves.
    // eslint-disable-next-line @eslint-react/dom-no-flush-sync -- focus moves to a card this update renders
    flushSync(openAll);

    // "Show all" removes itself, so focus moves to the first card it revealed.
    // A virtual list can leave that card out of the window; the heading is then
    // the target.
    const revealed = sectionRef.current?.querySelector<HTMLElement>(`li[data-index="${String(FINAL_CAP)}"]`);
    (revealed ?? headingRef.current)?.focus();
  }

  function renderCard(entry: TaskEntry, at: number): ReactNode {
    return (
      <TaskCard
        tag={tag}
        entry={entry}
        view={stepView(entry.frontmatter, final, workflows.get(entry.frontmatter.workflow ?? ""))}
        top={isTopPriority(entry.frontmatter.priority, priorities)}
        statuses={statuses}
        pending={pendingIds.has(entry.id)}
        dragging={entry.id === draggingId}
        onMove={(next) => {
          onMove(entry.id, next);
        }}
        onMoveUp={at > 0
          ? () => {
              onMoveBy(entry.id, -1);
            }
          : undefined}
        // The cap hides cards but does not stop a move past them, so both
        // bounds are in `matching`; `shown` is its prefix, so an index into
        // one is an index into the other.
        onMoveDown={at < matching.length - 1
          ? () => {
              onMoveBy(entry.id, 1);
            }
          : undefined}
        onOpen={() => {
          onOpen(entry.id);
        }}
        onDelete={onDelete}
        onPress={(event) => {
          onPress(event, entry.id);
        }}
        focusPart={focusCard?.id === entry.id ? focusCard.part : null}
        onFocused={onCardFocused}
      />
    );
  }

  function renderRow(row: Row): ReactNode {
    return isSlot(row) ? <DragSlot height={row.height} /> : renderCard(row.entry, row.at);
  }

  function cardList(): ReactNode {
    if (shown.length > VIRTUAL_ABOVE) {
      return (
        <PageVirtualList
          rows={items}
          estimateSize={(row) => (isSlot(row) ? row.height : cardHeights.get(row.entry.id) ?? ESTIMATED_CARD_HEIGHT)}
          getKey={(row) => (isSlot(row) ? "drag-slot" : row.entry.id)}
          renderRow={renderRow}
          labelledBy={headingId}
          gap={CARD_GAP}
          itemIndex={(row) => (isSlot(row) ? null : row.at)}
          itemCount={shown.length}
          scrollToIndex={focusIndex < 0 ? undefined : focusIndex}
        />
      );
    }

    // A column with no card draws the slot on its own: a list holding nothing
    // but a hidden row is an empty list to assistive technology.
    if (shown.length === 0) {
      return placed !== null && <DragSlot height={placed.row.height} />;
    }

    return (
      <ul
        ref={plainListRef}
        aria-labelledby={headingId}
        style={{ gap: `${String(CARD_GAP)}px` }}
        className="flex flex-col"
      >
        {items.map((row) => (isSlot(row)
          ? <li key="drag-slot" aria-hidden="true">{renderRow(row)}</li>
          : (
              <li key={row.entry.id} data-index={row.at} tabIndex={-1}>
                {renderRow(row)}
              </li>
            )))}
      </ul>
    );
  }

  return (
    // No scroll container of its own: one would break the sticky header.
    <section
      ref={sectionRef}
      {...{ [DRAG_ATTRIBUTE.column]: place }}
      aria-labelledby={headingId}
      className="group/column min-w-60 flex-1"
    >
      {/* The page's scroll padding keeps a focus scroll's target and its ring clear of the header. */}
      <div className="sticky top-0 z-(--layer-column-header) -mt-3 flex items-baseline gap-2 bg-bg py-3 [html:has(&)]:scroll-pt-13">
        <h2 ref={headingRef} id={headingId} tabIndex={-1} className="font-chrome text-sm font-medium">
          {status}
        </h2>
        <span className="text-xs-plus text-dim">
          {filtered ? `${String(matching.length)} of ${String(total)}` : total}
        </span>
        {/* 20px, under the 24px target size: no other control stands within 24px of it. It stays in the tab
            order, and focus on it is focus inside the column, which shows it. */}
        <button
          type="button"
          aria-label={`New task in ${status}`}
          onClick={(event) => {
            onCreate(status, event.currentTarget);
          }}
          className="ml-auto flex size-5 items-center justify-center self-center rounded-[4px] text-dim opacity-0 transition-opacity duration-(--duration-fast) ease-standard group-focus-within/column:opacity-100 group-hover/column:opacity-100 hover:bg-surface-2 hover:text-text"
        >
          <PlusIcon size={14} aria-hidden="true" />
        </button>
      </div>
      {cardList()}
      {capped && (
        <p className="mt-2 px-3 py-1.5 text-xs-plus/5.5 text-dim">
          {`${String(FINAL_CAP)} of ${String(matching.length)}`}
          {/* The margin keeps the focus ring of the button off the separator. */}
          <span className="mx-1">{" · "}</span>
          <button
            type="button"
            onClick={openMovingFocus}
            className="text-muted underline underline-offset-2 hover:text-text"
          >
            Show all
          </button>
        </p>
      )}
    </section>
  );
}
