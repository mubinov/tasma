import type { TaskEntry, Workflow } from "@tasma/protocol";
import { useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { isTopPriority, stepView, type ColumnData } from "../lib/board";
import { TaskCard } from "./task-card";
import { PageVirtualList } from "./virtual-list";

type BoardColumnProps = {
  /** The tag of the project the board shows. */
  tag: string;
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
  onMove: (id: string, status: string) => void;
  /** Moves the card one visible place up (`-1`) or down (`1`) in this column. */
  onMoveBy: (id: string, by: -1 | 1) => void;
  /** The task whose menu button takes focus once its card renders. */
  focusId: string | null;
  onMenuFocused: () => void;
};

const FINAL_CAP = 20;
const VIRTUAL_ABOVE = 50;
const ESTIMATED_CARD_HEIGHT = 96;

export function BoardColumn({
  tag,
  column,
  filtered,
  priorities,
  workflows,
  statuses,
  pendingIds,
  onMove,
  onMoveBy,
  focusId,
  onMenuFocused,
}: BoardColumnProps): ReactNode {
  const { status, final, matching, total } = column;
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const plainListRef = useRef<HTMLUListElement>(null);
  const [showAll, setShowAll] = useState(false);
  // By id: the heights the capped cards had when the column opened in full.
  const [cardHeights, setCardHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const capped = final && !showAll && matching.length > FINAL_CAP;
  const shown = capped ? matching.slice(0, FINAL_CAP) : matching;
  const focusIndex = shown.findIndex((entry) => entry.id === focusId);
  const focusCapped = capped && matching.findIndex((entry) => entry.id === focusId) >= FINAL_CAP;

  function openAll(): void {
    const rows = plainListRef.current?.children ?? [];

    setCardHeights(new Map(shown.map((entry, index) => [entry.id, (rows[index] as HTMLElement).offsetHeight])));
    setShowAll(true);
  }

  // Focus stays where it is: the card to focus takes it once it renders.
  const openKeepingFocus = useEffectEvent(openAll);

  useLayoutEffect(() => {
    if (focusCapped) {
      openKeepingFocus();
    }
  }, [focusCapped]);

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

  function renderCard(entry: TaskEntry, index: number): ReactNode {
    return (
      <TaskCard
        tag={tag}
        entry={entry}
        view={stepView(entry.frontmatter, final, workflows.get(entry.frontmatter.workflow ?? ""))}
        top={isTopPriority(entry.frontmatter.priority, priorities)}
        statuses={statuses}
        pending={pendingIds.has(entry.id)}
        onMove={(status) => {
          onMove(entry.id, status);
        }}
        onMoveUp={index > 0
          ? () => {
              onMoveBy(entry.id, -1);
            }
          : undefined}
        // The cap hides cards but does not stop a move past them, so both
        // bounds are in `matching`; `shown` is its prefix, so an index into
        // one is an index into the other.
        onMoveDown={index < matching.length - 1
          ? () => {
              onMoveBy(entry.id, 1);
            }
          : undefined}
        focusMenu={entry.id === focusId}
        onMenuFocused={onMenuFocused}
      />
    );
  }

  return (
    // No scroll container of its own: one would break the sticky header.
    <section ref={sectionRef} aria-labelledby={headingId} className="min-w-60 flex-1">
      {/* The page's scroll padding keeps a focus scroll's target and its ring clear of the header. */}
      <div className="sticky top-0 z-(--layer-column-header) -mt-3 flex items-baseline gap-2 bg-bg py-3 [html:has(&)]:scroll-pt-13">
        <h2 ref={headingRef} id={headingId} tabIndex={-1} className="font-chrome text-sm font-medium">
          {status}
        </h2>
        <span className="text-xs-plus text-dim">
          {filtered ? `${String(matching.length)} of ${String(total)}` : total}
        </span>
      </div>
      {shown.length > VIRTUAL_ABOVE
        ? (
            <PageVirtualList
              items={shown}
              estimateSize={(entry) => cardHeights.get(entry.id) ?? ESTIMATED_CARD_HEIGHT}
              getKey={(entry) => entry.id}
              renderItem={renderCard}
              labelledBy={headingId}
              gap={8}
              scrollToIndex={focusIndex < 0 ? undefined : focusIndex}
            />
          )
        : shown.length > 0 && (
          <ul ref={plainListRef} aria-labelledby={headingId} className="flex flex-col gap-2">
            {shown.map((entry, index) => (
              <li key={entry.id} data-index={index} tabIndex={-1}>
                {renderCard(entry, index)}
              </li>
            ))}
          </ul>
        )}
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
