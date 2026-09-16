import type { StepOwner } from "@tasma/protocol";
import type { ReactNode } from "react";
import type { StepView } from "../lib/board";

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

/** The owner's dot, the step name and what a screen reader says, as siblings for the caller's flex row. */
export function StepMark({ view }: { view: Exclude<StepView, { kind: "none" }> }): ReactNode {
  if (view.kind === "stale") {
    return <span className="font-mono text-xs text-dim">{view.name}</span>;
  }

  const { name, owner, current, owners } = view;

  return (
    <>
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT_CLASS[owner]}`} />
      <span className="font-mono text-xs text-text">{name}</span>
      <span className="sr-only">{`, step ${String(current + 1)} of ${String(owners.length)}, ${OWNER_WORDS[owner]}`}</span>
    </>
  );
}

type StepTrackProps = {
  owners: readonly StepOwner[];
  current: number;
  className: string;
};

export function StepTrack({ owners, current, className }: StepTrackProps): ReactNode {
  return (
    <span aria-hidden="true" className={`${className} inline-flex items-center gap-0.5`}>
      {owners.map((segment, index) => (
        // The steps of a workflow are positions: two steps can have the same owner.
        // eslint-disable-next-line @eslint-react/no-array-index-key
        <i key={index} className={segmentClass(segment, index, current)} />
      ))}
    </span>
  );
}
