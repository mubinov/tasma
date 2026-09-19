import { hashKey, mutationOptions, useMutationState, type QueryClient } from "@tanstack/react-query";
import { ProtocolError, TransportError, type Client, type Diagnostic, type SerializeErrorCode } from "@tasma/protocol";
import { boardWarnings, type PendingWrite, type TaskWrite } from "../lib/board";
import { failureWords, joinFailureWords } from "../lib/failure-words";
import { warningCount } from "../lib/warning-count";
import { noticeWords, useNoticeStore, type Notice } from "../store/notices";
import { daemonKeys, projectQuery, taskQuery, tasksQuery } from "./queries";

/** What one write of a sequence came back with. */
type Written = {
  id: string;
  diagnostics: Diagnostic[];
};

export type TaskWrites = {
  /** The task the failure notice is about. The writes need not include it. */
  id: string;
  /** Sent in this order. The first failure stops the rest. */
  writes: readonly TaskWrite[];
  /** The title of the failure notice, e.g. "PROJ-1 was not moved". */
  title: string;
  /** Which screen sent the writes, which picks the muted line of the failure notice. */
  place: "board" | "task page";
};

export function taskWriteKey(tag: string) {
  return [...daemonKeys.tasks(tag), "write"] as const;
}

const FAILURE_KEY_PREFIX = "task-write-failure:";

const WARNING_KEY_PREFIX = "task-write-warnings:";

/** A write of `TaskWrites` failed. `completed` is the count of the writes before it that succeeded. */
export class TaskWriteError extends Error {
  readonly completed: number;

  constructor(cause: unknown, completed: number) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TaskWriteError";
    this.completed = completed;
  }
}

/**
 * The board writes that were queued behind a failed board write. Each was
 * computed from a board that showed the failed write, so none of them is sent.
 * A page write is computed from the text in its own editor, so it is neither
 * dropped by a failed board write nor drops one.
 */
const dropped = new WeakSet<TaskWrites>();

type FailureKind = "refused" | "unanswered" | "address" | "unsent";

function failureKind(cause: unknown): FailureKind {
  if (cause instanceof ProtocolError) {
    return "refused";
  }
  if (cause instanceof TransportError) {
    return cause.status === undefined ? "unanswered" : "address";
  }
  return "unsent";
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
  const cause = error instanceof TaskWriteError ? error.cause : error;

  if (!(cause instanceof ProtocolError) || cause.failure.kind !== "serialize") {
    return undefined;
  }

  return BODY_CORRECTIONS.get(cause.failure.code);
}

function failureLine({ cause, completed }: TaskWriteError, place: TaskWrites["place"]): string {
  if (place === "board") {
    return (completed > 0 ? PARTIAL_FAILURE_LINES : WHOLE_FAILURE_LINES)[failureKind(cause)];
  }

  const line = PAGE_FAILURE_LINES[failureKind(cause)];
  const correction = bodyCorrection(cause);

  return correction === undefined ? line : `${line} ${correction}`;
}

/** Closed first, so the notice of an earlier write, dismissed or not, does not hold this one back. */
function openWriteNotice(notice: Notice): void {
  useNoticeStore.getState().closeNotice(notice.key);
  useNoticeStore.getState().showNotice(notice);
}

/**
 * Every write to the tasks of one project, in one queue per project. The board
 * shows a write from the variables of the pending mutation, so the query cache
 * holds only what the daemon said.
 */
export function taskWriteOptions(queryClient: QueryClient, client: Client, tag: string) {
  return mutationOptions<Written[], TaskWriteError, TaskWrites>({
    mutationKey: taskWriteKey(tag),
    mutationFn: async (variables) => {
      if (dropped.has(variables)) {
        throw new TaskWriteError(new Error("an earlier write of the queue failed"), 0);
      }

      const results: Written[] = [];

      for (const [completed, { id, change }] of variables.writes.entries()) {
        try {
          const written = await client.updateTask(tag, id, change);
          results.push({ id, diagnostics: written.diagnostics });
        } catch (cause) {
          throw new TaskWriteError(cause, completed);
        }
      }

      return results;
    },
    // A write whose answer is lost may have been carried out.
    retry: 0,
    scope: { id: `task-write:${tag}` },
    onSuccess: (results) => {
      const board = boardWarnings(
        queryClient.getQueryData(projectQuery(client, tag).queryKey)?.diagnostics ?? [],
        queryClient.getQueryData(tasksQuery(client, tag).queryKey)?.diagnostics ?? [],
      );

      // A notice per written task: a sequence writes the cards a move passes
      // too, and the daemon's words are about the task of their own write.
      for (const { id, diagnostics } of results) {
        // A write reports what the daemon found in the file before it, so the
        // task page would repeat every warning its own read already shows.
        const known = [
          ...board,
          ...(queryClient.getQueryData(taskQuery(client, tag, id).queryKey)?.diagnostics ?? []),
        ];
        const fresh = diagnostics.filter((diagnostic) => !known.some(
          ({ code, message }) => code === diagnostic.code && message === diagnostic.message,
        ));

        if (fresh.length > 0) {
          openWriteNotice({
            key: `${WARNING_KEY_PREFIX}${id}`,
            form: "warning",
            title: `${warningCount(fresh.length)} about ${id}`,
            words: noticeWords(fresh),
          });
        }
      }
      for (const { key } of useNoticeStore.getState().notices) {
        if (key.startsWith(FAILURE_KEY_PREFIX)) {
          useNoticeStore.getState().closeNotice(key);
        }
      }

      // Returned, so the write stays pending until the listing shows it.
      return queryClient.invalidateQueries({ queryKey: daemonKeys.tasks(tag) });
    },
    onError: (error, variables) => {
      // The failed mutation is still pending here, and every other pending
      // write of the project is queued behind it.
      if (variables.place === "board") {
        for (const { state } of queryClient.getMutationCache().findAll({ mutationKey: taskWriteKey(tag), status: "pending" })) {
          const queued = state.variables as TaskWrites;
          if (queued !== variables && queued.place === "board") {
            dropped.add(queued);
          }
        }
      }
      // A dropped write opens no notice, so the notice of the failure that dropped it stays.
      if (dropped.has(variables)) {
        return;
      }

      const { id, title, place } = variables;
      openWriteNotice({
        key: `${FAILURE_KEY_PREFIX}${id}`,
        form: "failure",
        title,
        line: failureLine(error, place),
        words: [joinFailureWords(failureWords(error.cause))],
      });

      // Not returned, so the card goes back at once. A write whose answer could
      // not be read may still have been carried out.
      void queryClient.invalidateQueries({ queryKey: daemonKeys.tasks(tag) });
    },
  });
}

/** The pending and queued task writes of a project. */
export type PendingTaskWrites = {
  /** Every write they carry, in the order they were sent. */
  writes: PendingWrite[];
  /** The tasks they move, which is fewer than the tasks they write: a move renumbers its neighbours. */
  movedIds: Set<string>;
};

export function usePendingTaskWrites(tag: string): PendingTaskWrites {
  // The filter holds no tag: `useMutationState` reads a changed filter only at
  // the next mutation event, so the project is picked during render.
  const pending = useMutationState({
    filters: { mutationKey: daemonKeys.projects(), status: "pending" },
    select: ({ options: { mutationKey }, state: { variables, submittedAt } }) => ({
      mutationKey,
      variables,
      submittedAt,
    }),
  });
  const key = hashKey(taskWriteKey(tag));
  const mine = pending
    // A mutation matches a key filter only when it has a key.
    .filter(({ mutationKey }) => hashKey(mutationKey!) === key)
    // A pending mutation always holds the variables it was started with.
    .map(({ variables, submittedAt }) => ({ variables: variables as TaskWrites, submittedAt }));

  return {
    writes: mine.flatMap(({ variables, submittedAt }) =>
      variables.writes.map(({ id, change }) => ({ id, change, submittedAt })),
    ),
    movedIds: new Set(mine.map(({ variables }) => variables.id)),
  };
}
