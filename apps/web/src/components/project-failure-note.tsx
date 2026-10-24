import { useQueries } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { projectQuery, tasksQuery } from "../api/queries";
import { failureWords, joinFailureWords } from "../lib/failure-words";
import { WarningIcon } from "../lib/icons";
import { NOTE_CLASS, NOTE_SIGNAL_TITLE_CLASS, NOTICE_WORDS_CLASS } from "./control-classes";

// Reached by id rather than imported: routes.tsx imports this file through the tasks screen.
const route = getRouteApi("/tasks");

/** `missing`: the daemon's project list does not hold the tag. Otherwise the daemon refused a read of the project. */
type ProjectFailureNoteProps = { tag: string; missing: boolean; className: string };

/** A project of a board of several projects that the board does not show, and why. */
export function ProjectFailureNote({ tag, missing, className }: ProjectFailureNoteProps): ReactNode {
  return (
    <div role="note" className={`${NOTE_CLASS} w-full max-w-2xl ${className}`}>
      <WarningIcon size={20} aria-hidden="true" className="mt-px shrink-0 text-signal" />
      <div className="min-w-0 flex-1">
        <h2 className={NOTE_SIGNAL_TITLE_CLASS}>
          {missing ? `${tag} is not a project` : `${tag} did not load`}
        </h2>
        <p className="mt-0.5 text-sm text-subtle">
          {missing
            ? `The daemon's project list has no project with this tag. The board shows ${tag} when a project with this tag appears.`
            : `The board shows the other projects. It tries ${tag} again every 5 seconds.`}
        </p>
        {!missing && <RefusalWords tag={tag} />}
      </div>
    </div>
  );
}

/**
 * The words of the error of the project read, else of the listing read: a
 * fixed order, so the words stay the same from poll to poll when both fail.
 * Read from the cache, so only this renders again when the words change.
 */
function RefusalWords({ tag }: { tag: string }): ReactNode {
  const { client } = route.useRouteContext();
  const words = useQueries({
    queries: [{ ...projectQuery(client, tag), enabled: false }, { ...tasksQuery(client, tag), enabled: false }],
    combine: ([projectRead, listingRead]) => {
      const error = projectRead.error ?? listingRead.error;

      return error === null ? null : joinFailureWords(failureWords(error));
    },
  });

  return words === null ? null : <p className={NOTICE_WORDS_CLASS}>{words}</p>;
}
