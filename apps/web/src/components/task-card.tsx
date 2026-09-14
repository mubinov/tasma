import type { StepOwner, TaskEntry } from "@tasma/protocol";
import type { ReactNode } from "react";
import type { StepView } from "../lib/board";
import { ProhibitIcon } from "../lib/icons";

type TaskCardProps = {
  entry: TaskEntry;
  view: StepView;
  /** The task has the first configured priority. */
  top: boolean;
};

const DOT_CLASS: Record<StepOwner, string> = {
  agent: "bg-running",
  human: "bg-signal",
};

const OWNER_WORDS: Record<StepOwner, string> = {
  agent: "an agent's step",
  human: "a human's step",
};

function segmentClass(owner: StepOwner, index: number, current: number): string {
  if (owner === "agent") {
    if (index === current) {
      return "h-[5px] w-2.5 rounded-[2px] bg-running";
    }
    return `h-[3px] w-2 rounded-[2px] ${index < current ? "bg-graphic" : "bg-line"}`;
  }
  if (index === current) {
    return "size-[9px] rounded-full border-[1.5px] border-signal bg-signal";
  }
  return `size-[7px] rounded-full border-[1.5px] ${index < current ? "border-graphic" : "border-line"}`;
}

function FlowRow({ view }: { view: StepView }): ReactNode {
  if (view.kind === "none") {
    return null;
  }
  if (view.kind === "stale") {
    return (
      <div className="mt-2.5 flex items-center gap-2">
        <span className="font-mono text-xs text-dim">{view.name}</span>
      </div>
    );
  }

  const { name, owner, current, owners } = view;

  return (
    <div className="mt-2.5 flex items-center gap-2">
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT_CLASS[owner]}`} />
      <span className="font-mono text-xs text-text">{name}</span>
      <span className="sr-only">{`, step ${String(current + 1)} of ${String(owners.length)}, ${OWNER_WORDS[owner]}`}</span>
      <span aria-hidden="true" className="ml-auto inline-flex items-center gap-0.5">
        {owners.map((segment, index) => (
          // The steps of a workflow are positions: two steps can have the same owner.
          // eslint-disable-next-line @eslint-react/no-array-index-key
          <i key={index} className={segmentClass(segment, index, current)} />
        ))}
      </span>
    </div>
  );
}

export function TaskCard({ entry, view, top }: TaskCardProps): ReactNode {
  const { id, blocked, frontmatter: { title, priority, labels = [] } } = entry;

  return (
    <div className="rounded-card border border-line bg-surface px-3 pt-2.5 pb-3 hover:border-graphic">
      <div className="flex h-4.25 items-center gap-2">
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
      <div className="mt-1 pr-6 text-sm font-medium wrap-anywhere">{title}</div>
      <FlowRow view={view} />
      {labels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {labels.map((label, index) => (
            // A hand-edited task file can hold the same label twice.
            // eslint-disable-next-line @eslint-react/no-array-index-key
            <span key={index} className="inline-flex items-center gap-1.5 text-xs text-muted">
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-graphic" />
              <span className="min-w-0 wrap-anywhere">{label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
