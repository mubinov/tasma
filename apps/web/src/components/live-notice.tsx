import type { ReactNode } from "react";
import type { BoardSubject } from "../lib/board";
import { WarningIcon } from "../lib/icons";

const INDEX_OWNER_WORDS: Record<BoardSubject, string> = {
  "this project": "this project",
  "these projects": "one or more of these projects",
};

type LiveNoticeProps = { subject?: BoardSubject; className?: string };

/**
 * `live` is false only where a repair was attempted on this very request and did
 * not work, so the notice says the index stopped following the disk rather than
 * that anything is broken. A lost disk needs a human, which is what `signal`
 * marks.
 */
export function LiveNotice({ subject = "this project", className }: LiveNoticeProps): ReactNode {
  return (
    <div role="note" className={`flex gap-3 rounded-card border border-line bg-surface px-4 py-3 ${className ?? ""}`}>
      <WarningIcon size={20} aria-hidden="true" className="mt-px shrink-0 text-signal" />
      <div>
        <p className="font-chrome text-base font-medium text-signal">The index is not following the disk</p>
        <p className="mt-0.5 text-sm text-subtle">
          {`The daemon could not repair the index of ${INDEX_OWNER_WORDS[subject]} on this request. What it reports about ${subject} `
            + "can be older than the files on disk. Reload to try again."}
        </p>
      </div>
    </div>
  );
}
