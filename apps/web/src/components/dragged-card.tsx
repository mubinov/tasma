import type { TaskEntry } from "@tasma/protocol";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import type { StepView } from "../lib/board";
import { CARD_CLASS, CARD_TITLE_CLASS, CardFace } from "./card-face";

type DraggedCardProps = {
  elementRef: RefObject<HTMLDivElement | null>;
  /** The width of the origin card, which the lifted card keeps. */
  width: number;
  entry: TaskEntry;
  view: StepView;
  /** The task has the first configured priority. */
  top: boolean;
};

/**
 * The card that follows the pointer during a drag.
 *
 * It renders on the body, over every layer of the board, so no column clips it.
 * Its transform is written to the element rather than rendered: a render of the
 * board mid-drag would put the card back where the drag started.
 */
export function DraggedCard({ elementRef, width, entry, view, top }: DraggedCardProps): ReactNode {
  return createPortal(
    <div
      ref={elementRef}
      inert
      aria-hidden="true"
      style={{ width: `${String(width)}px` }}
      className="pointer-events-none fixed top-0 left-0 z-(--layer-drag) origin-top-left rounded-card shadow-float"
    >
      <div className={`${CARD_CLASS} border-graphic`}>
        <CardFace
          entry={entry}
          view={view}
          top={top}
          title={<p className={CARD_TITLE_CLASS}>{entry.frontmatter.title}</p>}
        />
      </div>
    </div>,
    document.body,
  );
}
