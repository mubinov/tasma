import { hashKey, useMutationState } from "@tanstack/react-query";
import { ProtocolError, TransportError, type Diagnostic, type SerializeErrorCode } from "@tasma/protocol";
import { failureWords, joinFailureWords } from "../../lib/failure-words";
import { noticeWords, useNoticeStore, type Notice } from "../../store/notices";
import { warningCount } from "../../lib/warning-count";
import { daemonKeys } from "../queries";

export type FailureKind = "refused" | "unanswered" | "address" | "unsent";

export function failureKind(cause: unknown): FailureKind {
  if (cause instanceof ProtocolError) {
    return "refused";
  }
  if (cause instanceof TransportError) {
    return cause.status === undefined ? "unanswered" : "address";
  }
  return "unsent";
}

/** A write failed. The domain that sent it subclasses this to add what its own notice reads. */
export class WriteError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "WriteError";
  }
}

/** Closed first, so the notice of an earlier write, dismissed or not, does not hold this one back. */
export function openWriteNotice(notice: Notice): void {
  useNoticeStore.getState().closeNotice(notice.key);
  useNoticeStore.getState().showNotice(notice);
}

export const FAILURE_KEY_PREFIX = "task-write-failure:";

export const COMMENT_FAILURE_KEY_PREFIX = "comment-write-failure:";

export const WARNING_KEY_PREFIX = "task-write-warnings:";

/**
 * The one queue of a project's writes, so a create waits for a move or an edit
 * in flight. The comment writes share it: the daemon queues per task file too,
 * so without one client queue two writes would be ordered there rather than in
 * the order the reader saw.
 */
export function taskWriteScope(tag: string) {
  return { id: `task-write:${tag}` };
}

/** Opens the warning notice of a write, for the diagnostics the reader's screen does not already show. */
export function openWarnings(id: string, fresh: readonly Diagnostic[]): void {
  if (fresh.length > 0) {
    openWriteNotice({
      key: `${WARNING_KEY_PREFIX}${id}`,
      form: "warning",
      title: `${warningCount(fresh.length)} about ${id}`,
      words: noticeWords(fresh),
    });
  }
}

/**
 * The correction a refusal about the body names, by the code the daemon refused
 * with. A map rather than an object: the daemon's `code` is validated as a
 * string alone, and a prototype key would index an object literal to something
 * that is not a message.
 */
const BODY_CORRECTIONS = new Map<SerializeErrorCode, string>([
  [
    "marker-collision",
    "The body starts a line with a comment marker. Indent that line, or change its first characters.",
  ],
  ["fence-unterminated", "The body opens a code fence that never closes. Close the fence."],
]);

/**
 * What a refusal that is about the body tells the reader to correct, and
 * nothing for a refusal that ties to no field of the editor. It takes the
 * error a write rejects with as readily as the refusal inside it.
 */
export function bodyCorrection(error: unknown): string | undefined {
  const cause = error instanceof WriteError ? error.cause : error;

  if (!(cause instanceof ProtocolError) || cause.failure.kind !== "serialize") {
    return undefined;
  }

  return BODY_CORRECTIONS.get(cause.failure.code);
}

/** How a serialize refusal names a comment's title as the offending field. */
const TITLE_FIELD = "title";

const TITLE_CORRECTION = "The title contains \"-->\", which closes the comment marker. Remove it.";

/**
 * What a refusal that is about a comment's title tells the reader to correct.
 * `value-contains-arrow` tests the whole marker, so the same code is raised for
 * an `author` or a `custom` key a hand-edited file holds; the field the daemon
 * named is therefore what gates the correction, not the code alone.
 */
export function titleCorrection(error: unknown): string | undefined {
  const cause = error instanceof WriteError ? error.cause : error;

  if (!(cause instanceof ProtocolError) || cause.failure.kind !== "serialize") {
    return undefined;
  }

  const { code, field } = cause.failure;

  return code === "value-contains-arrow" && field === TITLE_FIELD ? TITLE_CORRECTION : undefined;
}

/** Nothing was written. */
const WHOLE_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused the write, and the task is back where it was. Its own words are below.",
  unanswered: "No daemon answered, so nothing was written.",
  address: "The daemon did not answer through the address below. Start the daemon there if it is not running. "
    + "The board shows the task where the daemon holds it after the next read.",
  unsent: "The write did not start, and the task is back where it was.",
};

/** A write before the failed one succeeded. */
const PARTIAL_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused a write, and the move did not complete. The board shows what the daemon holds. "
    + "Its own words are below.",
  unanswered: "The daemon stopped answering, and the move did not complete. "
    + "The board shows what the daemon holds after the next read.",
  address: "The daemon did not answer through the address below, and the move did not complete. "
    + "Start the daemon there if it is not running. The board shows what the daemon holds after the next read.",
  unsent: "A write did not start, and the move did not complete. The board shows what the daemon holds.",
};

/** A page write is one write, so it has no partial form. */
const PAGE_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused the write, so nothing changed on disk. Its own words are below.",
  unanswered: "No daemon answered, so nothing was written.",
  address: "The daemon did not answer through the address below. Start the daemon there if it is not running. "
    + "The page shows the task as the daemon holds it after the next read.",
  unsent: "The write did not start, so nothing changed on disk.",
};

/**
 * The pieces of a failure notice's muted line. Each domain passes what its own
 * variables carry: the board counts the writes of a sequence that landed, the
 * task page names the row a property write changes, and a comment write names
 * neither.
 */
type FailureLineParts = {
  cause: unknown;
  /** Which screen sent the write, which picks the wording. */
  place: "board" | "task page";
  /** Board only: the writes of the sequence that succeeded before the failed one. */
  completed?: number;
  /** Task page only: the row the write changes, e.g. "Status", named in front of the line. */
  property?: string;
};

/** The muted line of a failure notice, with the correction the refusal names where there is one. */
export function failureLine({ cause, place, completed = 0, property }: FailureLineParts): string {
  if (place === "board") {
    return (completed > 0 ? PARTIAL_FAILURE_LINES : WHOLE_FAILURE_LINES)[failureKind(cause)];
  }

  const named = property === undefined ? "" : `${property}. `;
  const line = `${named}${PAGE_FAILURE_LINES[failureKind(cause)]}`;
  const correction = bodyCorrection(cause) ?? titleCorrection(cause);

  return correction === undefined ? line : `${line} ${correction}`;
}

/**
 * The daemon's own words for a refused write, as its notice prints them. It
 * takes the error a write rejects with as readily as the refusal inside it.
 */
export function refusalWords(error: unknown): string {
  return joinFailureWords(failureWords(error instanceof WriteError ? error.cause : error));
}

/** One pending write of a domain, as a screen reads it. */
type PendingVariables<T> = { variables: T; submittedAt: number };

/** The variables of the pending writes under one mutation key, in the order they were sent. */
export function usePendingVariables<T>(mutationKey: readonly unknown[]): PendingVariables<T>[] {
  // The filter holds no tag: `useMutationState` reads a changed filter only at
  // the next mutation event, so the project is picked during render.
  const pending = useMutationState({
    filters: { mutationKey: daemonKeys.projects(), status: "pending" },
    select: ({ mutationId, options, state: { variables, submittedAt } }) => ({
      mutationId,
      mutationKey: options.mutationKey,
      variables,
      submittedAt,
    }),
  });
  const key = hashKey(mutationKey);

  return pending
    // A mutation matches a key filter only when it has a key.
    .filter((mutation) => hashKey(mutation.mutationKey!) === key)
    // The id rises with each mutation created, which is the order they were sent in.
    .sort((left, right) => left.mutationId - right.mutationId)
    // A pending mutation always holds the variables it was started with.
    .map(({ variables, submittedAt }) => ({ variables: variables as T, submittedAt }));
}

/** The diagnostics of a write that the screen the reader is on does not already show. */
export function freshDiagnostics(
  written: readonly Diagnostic[],
  known: readonly Diagnostic[],
): Diagnostic[] {
  return written.filter((diagnostic) => !known.some(
    ({ code, message }) => code === diagnostic.code && message === diagnostic.message,
  ));
}
