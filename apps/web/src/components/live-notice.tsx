import type { ReactNode } from "react";
import { WarningIcon } from "../lib/icons";
import { NOTE_CLASS, NOTE_SIGNAL_TITLE_CLASS } from "./control-classes";

/** `project`: the tag of the project the notice is about. Without it, the notice says "this project". */
type LiveNoticeProps = { project?: string; className?: string };

/**
 * `live` is false only where the last repair of the index did not work, so the
 * notice says the index stopped following the disk rather than that anything
 * is broken. The daemon tries the repair again by itself and sends a `project`
 * event when it works. A lost disk needs a human, which is what `signal` marks.
 */
export function LiveNotice({ project, className }: LiveNoticeProps): ReactNode {
  const owner = project ?? "this project";

  return (
    <div role="note" className={`${NOTE_CLASS} ${className ?? ""}`}>
      <WarningIcon size={20} aria-hidden="true" className="mt-px shrink-0 text-signal" />
      <div>
        <p className={NOTE_SIGNAL_TITLE_CLASS}>
          {project === undefined ? "The index is not following the disk" : `The index of ${project} is not following the disk`}
        </p>
        <p className="mt-0.5 text-sm text-subtle">
          {`The daemon could not repair the index of ${owner}. What it reports about ${owner} `
            + "can be older than the files on disk. The daemon tries the repair again."}
        </p>
      </div>
    </div>
  );
}
