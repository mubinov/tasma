import type { TaskEntry } from "@tasma/protocol";
import type { ReactNode } from "react";
import type { StepView } from "../lib/board";
import { ProhibitIcon } from "../lib/icons";
import { LabelList } from "./label-list";
import { StepMark, StepTrack } from "./step-view";

/** The frame every card of a task draws, whatever its state. */
export const CARD_CLASS
  = "group/card relative cursor-pointer rounded-card border border-line bg-surface px-3 pt-2.5 pb-3";

export const CARD_TITLE_CLASS = "mt-1 block text-sm font-medium wrap-anywhere";

type CardFaceProps = {
  entry: TaskEntry;
  view: StepView;
  /** The task has the first configured priority. */
  top: boolean;
  /** A link on a card of the board, plain text on the card a drag carries. */
  title: ReactNode;
  /** The card a drag carries has none. */
  menu?: ReactNode;
};

function FlowRow({ view }: { view: StepView }): ReactNode {
  if (view.kind === "none") {
    return null;
  }

  return (
    <div className="mt-2.5 flex items-center gap-2">
      <StepMark view={view} />
      {view.kind === "step" && <StepTrack owners={view.owners} current={view.current} className="ml-auto" />}
    </div>
  );
}

/** What every card of a task draws: the id row, the title, the flow row and the labels. */
export function CardFace({ entry, view, top, title, menu }: CardFaceProps): ReactNode {
  const { id, blocked, frontmatter: { priority, labels = [] } } = entry;

  return (
    <>
      {/* The menu button sits over the right padding. */}
      <div className="flex h-4.25 items-center gap-2 pr-6">
        <span className="font-mono text-xs text-dim">{id}</span>
        {blocked && (
          <span className="inline-flex items-center gap-1 text-xs text-dim">
            <ProhibitIcon size={12} aria-hidden="true" />
            blocked
          </span>
        )}
        {priority !== undefined && (
          <span className={`ml-auto text-xs ${top ? "font-medium text-text" : "text-muted"}`}>{priority}</span>
        )}
      </div>
      {title}
      {/* After the title, so the menu button follows it in the tab order. */}
      {menu}
      <FlowRow view={view} />
      {labels.length > 0 && <LabelList labels={labels} className="mt-2 text-xs" />}
    </>
  );
}
