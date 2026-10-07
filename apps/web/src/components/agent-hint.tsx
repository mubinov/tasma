import type { ReactNode } from "react";
import { InfoIcon } from "../lib/icons";

type AgentHintProps = { sentence: string; example: string; className?: string };

/** How to make a change through an agent. A note with no heading, so it stays out of the heading list. */
export function AgentHint({ sentence, example, className }: AgentHintProps): ReactNode {
  return (
    <div role="note" className={`flex w-full max-w-2xl gap-3 rounded-card border border-line bg-surface px-4 py-3 ${className ?? ""}`}>
      <InfoIcon size={20} aria-hidden="true" className="mt-px shrink-0 text-dim" />
      <div className="min-w-0">
        <p className="mt-0.5 text-sm text-muted">{sentence}</p>
        <p className="mt-2 rounded-card bg-surface-2 px-3 py-2.5 font-mono text-xs wrap-anywhere">{example}</p>
      </div>
    </div>
  );
}
