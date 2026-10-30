import { hashKey, mutationOptions, type QueryClient } from "@tanstack/react-query";
import { ProtocolError, type Client, type Diagnostic } from "@tasma/protocol";
import { boardWarnings, tagOf, type PendingWrite, type TaskWrite } from "../../lib/board";
import type { CreateInput } from "../../lib/task-draft";
import { useNoticeStore } from "../../store/notices";
import { daemonKeys, projectQuery, taskQuery, tasksQuery } from "../queries";
import {
  failureKind,
  FAILURE_KEY_PREFIX,
  freshDiagnostics,
  openWarnings,
  openWriteNotice,
  refusalWords,
  TASK_WRITE_SCOPE,
  usePendingVariables,
  WriteError,
  type FailureKind,
  type WriteFailure,
} from "./notices";

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
  failure: WriteFailure<TaskWriteError>;
};

/** Under the prefix `usePendingVariables` reads. A tag is uppercase, so no project key is the same. */
export function taskWriteKey() {
  return [...daemonKeys.projects(), "task-write"] as const;
}

/** A write of `TaskWrites` failed. `completed` is the count of the writes before it that succeeded. */
export class TaskWriteError extends WriteError {
  readonly completed: number;

  constructor(cause: unknown, completed: number) {
    super(cause);
    this.name = "TaskWriteError";
    this.completed = completed;
  }
}

/**
 * The placements that were queued, in any project, behind a failed write of the
 * board's arrangement. Any of them may have been computed from an arrangement
 * that showed the failed write, so none of them is sent. The editor's Save
 * states no `order`: it stands on the text in its own editor, and is neither
 * dropped nor drops one.
 */
const dropped = new WeakSet<TaskWrites>();

/**
 * Whether the writes place a card. Every such write carries an `order` read
 * from the neighbours the board showed, whichever screen sent it — the page's
 * status pick lands the task at the top of its new column the same way.
 */
function placesCards({ writes }: TaskWrites): boolean {
  return writes.some(({ change }) => typeof change.order === "number");
}

/**
 * Drops every pending write of all projects that places a card, but `failed`.
 * Called while the failed mutation is still pending, so the others are all
 * queued behind it.
 */
function dropQueuedPlacements(queryClient: QueryClient, failed?: TaskWrites): void {
  for (const { state } of queryClient.getMutationCache().findAll({ mutationKey: taskWriteKey(), status: "pending" })) {
    const queued = state.variables as TaskWrites;
    if (queued !== failed && placesCards(queued)) {
      dropped.add(queued);
    }
  }
}

/**
 * The projects of the writes, and of the task the notice is about, so a
 * sequence with no write still reads its project again.
 */
function touchedTags({ id, writes }: TaskWrites): string[] {
  return [...new Set([...writes.map((write) => tagOf(write.id)), tagOf(id)])];
}

function invalidateListings(queryClient: QueryClient, tags: readonly string[]): Promise<void[]> {
  return Promise.all(tags.map((tag) => queryClient.invalidateQueries({ queryKey: daemonKeys.tasks(tag) })));
}

function closeFailureNotices(): void {
  for (const { key } of useNoticeStore.getState().notices) {
    if (key.startsWith(FAILURE_KEY_PREFIX)) {
      useNoticeStore.getState().closeNotice(key);
    }
  }
}

/**
 * Every write to the tasks of all projects, each to the project of its task, in
 * one queue. The board shows a write from the variables of the pending
 * mutation, so the query cache holds only what the daemon said.
 */
export function taskWriteOptions(queryClient: QueryClient, client: Client) {
  return mutationOptions<Written[], TaskWriteError, TaskWrites>({
    mutationKey: taskWriteKey(),
    mutationFn: async (variables) => {
      if (dropped.has(variables)) {
        throw new TaskWriteError(new Error("an earlier write of the queue failed"), 0);
      }

      const results: Written[] = [];

      for (const [completed, { id, change }] of variables.writes.entries()) {
        try {
          const written = await client.updateTask(tagOf(id), id, change);
          results.push({ id, diagnostics: written.diagnostics });
        } catch (cause) {
          throw new TaskWriteError(cause, completed);
        }
      }

      return results;
    },
    // A write whose answer is lost may have been carried out.
    retry: 0,
    scope: TASK_WRITE_SCOPE,
    onSuccess: (results, variables) => {
      // A notice per written task: a sequence writes the cards a move passes
      // too, and the daemon's words are about the task of their own write.
      for (const { id, diagnostics } of results) {
        const tag = tagOf(id);
        // A write reports what the daemon found in the file before it, so the
        // board and the task page would repeat every warning their reads already show.
        const known = [
          ...boardWarnings(
            queryClient.getQueryData(projectQuery(client, tag).queryKey)?.diagnostics ?? [],
            queryClient.getQueryData(tasksQuery(client, tag).queryKey)?.diagnostics ?? [],
          ),
          ...(queryClient.getQueryData(taskQuery(client, tag, id).queryKey)?.diagnostics ?? []),
        ];

        openWarnings(id, freshDiagnostics(diagnostics, known));
      }
      // A mutation carrying no write reached the daemon with nothing, so a
      // refusal an earlier write opened still stands.
      if (results.length > 0) {
        closeFailureNotices();
      }

      // Returned, so the write stays pending until every listing it touched shows it.
      return invalidateListings(queryClient, touchedTags(variables));
    },
    onError: (error, variables) => {
      if (placesCards(variables)) {
        dropQueuedPlacements(queryClient, variables);
      }
      // A dropped write opens no notice, so the notice of the failure that dropped it stays.
      if (dropped.has(variables)) {
        return;
      }

      const { id, failure } = variables;
      openWriteNotice({
        key: `${FAILURE_KEY_PREFIX}${id}`,
        form: "failure",
        title: failure.title,
        line: failure.line(error),
        words: [refusalWords(error)],
      });

      // Not returned, so the card goes back at once. A write whose answer could
      // not be read may still have been carried out.
      void invalidateListings(queryClient, touchedTags(variables));
    },
  });
}

/** The receipt of a create. */
export type Created = { id: string; status: string; diagnostics: Diagnostic[] };

export type CreateTask = { tag: string; input: CreateInput };

/** One key for the creates of all projects. A tag is uppercase, so no project key is the same. */
function taskCreateKey() {
  return [...daemonKeys.projects(), "task-create"] as const;
}

/** A create is one write, and nothing was created on any path. */
const CREATE_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused the write, so no task was created. Its own words are below.",
  unanswered: "No daemon answered, so no task was created.",
  address: "The daemon did not answer through the address below. Start the daemon there if it is not running.",
  unsent: "The create did not start, so no task was created.",
};

/**
 * What the create dialog shows for a failed create. It takes the error a create
 * rejects with as readily as its cause.
 */
export function createRefusal(error: unknown): { line: string; words: string } {
  const cause = error instanceof WriteError ? error.cause : error;

  return { line: CREATE_FAILURE_LINES[failureKind(cause)], words: refusalWords(cause) };
}

/**
 * The create of a task, sent to the project of its variables, in the one queue
 * of the writes of all projects. It opens no notice: the dialog shows a
 * refusal, and the board opens the warnings once the dialog has closed, where
 * no scrim covers them.
 */
export function taskCreateOptions(queryClient: QueryClient, client: Client) {
  return mutationOptions<Created, WriteError, CreateTask>({
    mutationKey: taskCreateKey(),
    mutationFn: async ({ tag, input }) => {
      try {
        const { data, diagnostics } = await client.createTask(tag, input);

        return { id: data.id, status: data.status ?? input.status, diagnostics };
      } catch (cause) {
        throw new WriteError(cause);
      }
    },
    retry: 0,
    scope: TASK_WRITE_SCOPE,
    onSuccess: (_created, { tag }) => {
      closeFailureNotices();

      // Returned, so the create stays pending until the listing holds the task.
      return queryClient.invalidateQueries({ queryKey: daemonKeys.tasks(tag) });
    },
    onError: (_error, { tag }) => {
      void queryClient.invalidateQueries({ queryKey: daemonKeys.tasks(tag) });
    },
  });
}

/** Opens the warning notice of a create, for the diagnostics the board does not already show. */
export function openCreateWarnings(created: Created, known: readonly Diagnostic[]): void {
  openWarnings(created.id, freshDiagnostics(created.diagnostics, known));
}

export type DeleteTask = { id: string };

/** Under the prefix `usePendingVariables` reads. A tag is uppercase, so no project key is the same. */
function taskDeleteKey() {
  return [...daemonKeys.projects(), "task-delete"] as const;
}

/** A delete is one request, so it has no partial form. */
const DELETE_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused the delete, so the task is still there. Its own words are below.",
  unanswered: "No daemon answered, so nothing was deleted.",
  address: "The daemon did not answer through the address below. Start the daemon there if it is not running. "
    + "The task is shown again after the next read.",
  unsent: "The delete did not start, so the task is still there.",
};

/** The task is gone already, removed by another client while the board was stale. */
function isNotFound(cause: unknown): boolean {
  return cause instanceof ProtocolError && cause.failure.kind === "store" && cause.failure.code === "task-not-found";
}

/**
 * The delete of a task, sent to the project of the task, in the one queue of
 * the writes of all projects. The board hides the card from the pending
 * variables.
 */
export function taskDeleteOptions(queryClient: QueryClient, client: Client) {
  return mutationOptions<Written, WriteError, DeleteTask>({
    mutationKey: taskDeleteKey(),
    mutationFn: async ({ id }) => {
      try {
        const { diagnostics } = await client.deleteTask(tagOf(id), id);

        return { id, diagnostics };
      } catch (cause) {
        if (isNotFound(cause)) {
          return { id, diagnostics: [] };
        }
        throw new WriteError(cause);
      }
    },
    // A delete whose answer is lost may have been carried out.
    retry: 0,
    scope: TASK_WRITE_SCOPE,
    onSuccess: ({ id, diagnostics }) => {
      const tag = tagOf(id);
      // No task page of the deleted task is left to show its own warnings.
      const known = boardWarnings(
        queryClient.getQueryData(projectQuery(client, tag).queryKey)?.diagnostics ?? [],
        queryClient.getQueryData(tasksQuery(client, tag).queryKey)?.diagnostics ?? [],
      );
      const deleted = daemonKeys.task(tag, id);
      const deletedHash = hashKey(deleted);

      openWarnings(id, freshDiagnostics(diagnostics, known));
      // A mounted page can still observe the task until its route change lands,
      // and a removed entry under it would suspend and read a task that is gone.
      // An entry left in place is served by the static read of Back.
      queryClient.removeQueries({ queryKey: deleted, type: "inactive" });
      // Only this task's notice: a refused move of another task still stands.
      useNoticeStore.getState().closeNotice(`${FAILURE_KEY_PREFIX}${id}`);
      useNoticeStore.getState().announce(`${id} was deleted.`);

      // Every other task of its project, because the delete clears its id from
      // the tasks of its own project that name it. Returned, so the delete
      // stays pending until the listing drops the card.
      return queryClient.invalidateQueries({
        queryKey: daemonKeys.tasks(tag),
        predicate: ({ queryHash }) => queryHash !== deletedHash,
      });
    },
    onError: (error, { id }) => {
      // The board placed them in a column that did not show the card.
      dropQueuedPlacements(queryClient);
      openWriteNotice({
        key: `${FAILURE_KEY_PREFIX}${id}`,
        form: "failure",
        title: `${id} was not deleted`,
        line: DELETE_FAILURE_LINES[failureKind(error.cause)],
        words: [refusalWords(error)],
      });

      // Not returned, so the card comes back at once.
      void queryClient.invalidateQueries({ queryKey: daemonKeys.tasks(tagOf(id)) });
    },
  });
}

/** The ids of the tasks of the projects of `tags` with a delete pending or queued. */
export function usePendingTaskDeletes(tags: readonly string[]): Set<string> {
  return new Set(
    usePendingVariables<DeleteTask>(taskDeleteKey())
      .map(({ variables }) => variables.id)
      .filter((id) => tags.includes(tagOf(id))),
  );
}

/** The pending and queued task writes of the projects of `tags`. */
export type PendingTaskWrites = {
  /** Every write they carry to a task of those projects, in the order they were sent. */
  writes: PendingWrite[];
  /** The tasks they move, which is fewer than the tasks they write: a move renumbers its neighbours. */
  movedIds: Set<string>;
};

export function usePendingTaskWrites(tags: readonly string[]): PendingTaskWrites {
  const pending = usePendingVariables<TaskWrites>(taskWriteKey());
  const isAsked = (id: string) => tags.includes(tagOf(id));

  return {
    writes: pending.flatMap(({ variables, submittedAt }) =>
      variables.writes.filter(({ id }) => isAsked(id)).map(({ id, change }) => ({ id, change, submittedAt })),
    ),
    movedIds: new Set(pending.map(({ variables }) => variables.id).filter(isAsked)),
  };
}
