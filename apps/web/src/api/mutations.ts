import { hashKey, mutationOptions, useMutationState, type QueryClient } from "@tanstack/react-query";
import { ProtocolError, TransportError, type Client, type Diagnostic, type TaskInput } from "@tasma/protocol";
import { boardWarnings, type PendingWrite } from "../lib/board";
import { failureWords, joinFailureWords } from "../lib/failure-words";
import { warningCount } from "../lib/warning-count";
import { noticeWords, useNoticeStore, type Notice } from "../store/notices";
import { daemonKeys, projectQuery, tasksQuery } from "./queries";

export type TaskWrite = { id: string; change: TaskInput };

export type TaskWrites = {
  /** Sent in this order. The first failure stops the rest. */
  writes: readonly [TaskWrite, ...TaskWrite[]];
  /** The title of the failure notice, e.g. "PROJ-1 was not moved". */
  title: string;
};

export function taskWriteKey(tag: string) {
  return [...daemonKeys.tasks(tag), "write"] as const;
}

const FAILURE_KEY_PREFIX = "task-write-failure:";

const WARNING_KEY_PREFIX = "task-write-warnings:";

/** The task a write notice is about. */
function lastId(writes: TaskWrites["writes"]): string {
  return writes.at(-1)!.id;
}

function failureLine(error: unknown): string {
  if (error instanceof ProtocolError) {
    return "The daemon refused the write, and the task is back where it was. Its own words are below.";
  }
  if (error instanceof TransportError && error.status === undefined) {
    return "No daemon answered, so nothing was written.";
  }
  if (error instanceof TransportError) {
    return "The daemon did not answer through the address below. Start the daemon there if it is not running. "
      + "The board shows the task where the daemon holds it after the next read.";
  }
  return "The write did not start, and the task is back where it was.";
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
  return mutationOptions({
    mutationKey: taskWriteKey(tag),
    mutationFn: async ({ writes }: TaskWrites): Promise<Diagnostic[]> => {
      const diagnostics: Diagnostic[] = [];

      for (const { id, change } of writes) {
        const written = await client.updateTask(tag, id, change);
        diagnostics.push(...written.diagnostics);
      }

      return diagnostics;
    },
    // A write whose answer is lost may have been carried out.
    retry: 0,
    scope: { id: `task-write:${tag}` },
    onSuccess: (diagnostics, { writes }) => {
      const known = boardWarnings(
        queryClient.getQueryData(projectQuery(client, tag).queryKey)?.diagnostics ?? [],
        queryClient.getQueryData(tasksQuery(client, tag).queryKey)?.diagnostics ?? [],
      );
      const fresh = diagnostics.filter(
        (diagnostic) => !known.some(({ code, message }) => code === diagnostic.code && message === diagnostic.message),
      );

      if (fresh.length > 0) {
        const id = lastId(writes);
        openWriteNotice({
          key: `${WARNING_KEY_PREFIX}${id}`,
          form: "warning",
          title: `${warningCount(fresh.length)} about ${id}`,
          words: noticeWords(fresh),
        });
      }
      for (const { key } of useNoticeStore.getState().notices) {
        if (key.startsWith(FAILURE_KEY_PREFIX)) {
          useNoticeStore.getState().closeNotice(key);
        }
      }

      // Returned, so the write stays pending until the listing shows it.
      return queryClient.invalidateQueries({ queryKey: daemonKeys.tasks(tag) });
    },
    onError: (error, { writes, title }) => {
      openWriteNotice({
        key: `${FAILURE_KEY_PREFIX}${lastId(writes)}`,
        form: "failure",
        title,
        line: failureLine(error),
        words: [joinFailureWords(failureWords(error))],
      });

      // Not returned, so the card goes back at once. A write whose answer could
      // not be read may still have been carried out.
      void queryClient.invalidateQueries({ queryKey: daemonKeys.tasks(tag) });
    },
  });
}

/** The writes of the pending and queued task writes of a project, in the order they were sent. */
export function usePendingTaskWrites(tag: string): PendingWrite[] {
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

  return pending
    // A mutation matches a key filter only when it has a key.
    .filter(({ mutationKey }) => hashKey(mutationKey!) === key)
    // A pending mutation always holds the variables it was started with.
    .flatMap(({ variables, submittedAt }) =>
      (variables as TaskWrites).writes.map(({ id, change }) => ({ id, change, submittedAt })),
    );
}
