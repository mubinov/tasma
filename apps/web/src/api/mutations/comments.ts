import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { Client, CommentInput, Diagnostic } from "@tasma/protocol";
import { useNoticeStore } from "../../store/notices";
import { daemonKeys, projectQuery, taskQuery, tasksQuery } from "../queries";
import {
  COMMENT_FAILURE_KEY_PREFIX,
  failureLine,
  freshDiagnostics,
  openWarnings,
  openWriteNotice,
  refusalWords,
  taskWriteScope,
  usePendingVariables,
  WriteError,
} from "./notices";

/**
 * One write of one comment. The three kinds are one factory because they share
 * a queue, a key, a notice and an invalidation; `noticeTitle` rather than
 * `title` because a comment's own title already sits inside `input` and
 * `change`.
 */
export type CommentWrite = { id: string; noticeTitle: string } & (
  | { kind: "add"; input: CommentInput }
  | { kind: "update"; commentId: number; change: CommentInput }
  | { kind: "delete"; commentId: number }
);

/** What a comment write came back with. */
type CommentWritten = {
  id: string;
  /** Issued by an add, repeated by an edit or a delete. */
  commentId: number | undefined;
  diagnostics: Diagnostic[];
};

/**
 * Its own key, not `taskWriteKey`: `usePendingTaskWrites` narrows by that key's
 * exact hash and would otherwise read a comment save as a card write and draw
 * the board wrong.
 */
export function commentWriteKey(tag: string) {
  return [...daemonKeys.tasks(tag), "comment-write"] as const;
}

/** What the notice of a refused comment write is titled, one wording per kind of write. */
export function commentFailureTitle(taskId: string, commentId: number | "new", verb: string): string {
  return commentId === "new"
    ? `The new comment on ${taskId} was not ${verb}`
    : `Comment #${String(commentId)} of ${taskId} was not ${verb}`;
}

/** The notice of a refused write, one key per comment and `#new` for the add form. */
export function commentFailureKey({ id, ...write }: CommentWrite): string {
  const comment = write.kind === "add" ? "new" : String(write.commentId);

  return `${COMMENT_FAILURE_KEY_PREFIX}${id}#${comment}`;
}

/**
 * Every write of one task's comments, in the queue of the project's task
 * writes. The card shows a pending write from the mutation variables, so the
 * query cache holds only what the daemon said.
 */
export function commentWriteOptions(queryClient: QueryClient, client: Client, tag: string) {
  return mutationOptions<CommentWritten, WriteError, CommentWrite>({
    mutationKey: commentWriteKey(tag),
    mutationFn: async (variables) => {
      const { id } = variables;
      try {
        const { data, diagnostics } = await (variables.kind === "add"
          ? client.addComment(tag, id, variables.input)
          : variables.kind === "update"
            ? client.updateComment(tag, id, variables.commentId, variables.change)
            : client.deleteComment(tag, id, variables.commentId));

        return { id: data.id, commentId: data.commentId, diagnostics };
      } catch (cause) {
        throw new WriteError(cause);
      }
    },
    // A write whose answer is lost may have been carried out.
    retry: 0,
    scope: taskWriteScope(tag),
    onSuccess: ({ id, diagnostics }, variables) => {
      // A write reports what the daemon found in the file before it, so the
      // page would repeat every warning its own read already shows.
      const known = [
        ...(queryClient.getQueryData(projectQuery(client, tag).queryKey)?.diagnostics ?? []),
        ...(queryClient.getQueryData(tasksQuery(client, tag).queryKey)?.diagnostics ?? []),
        ...(queryClient.getQueryData(taskQuery(client, tag, id).queryKey)?.diagnostics ?? []),
      ];

      openWarnings(id, freshDiagnostics(diagnostics, known));
      // Only this comment's own notice: a save of another comment, or of the
      // task text, says nothing about a refusal still standing here.
      useNoticeStore.getState().closeNotice(commentFailureKey(variables));

      // Returned, so the write stays pending until the page holds the comment.
      return queryClient.invalidateQueries({ queryKey: daemonKeys.tasks(tag) });
    },
    onError: (error, variables) => {
      openWriteNotice({
        key: commentFailureKey(variables),
        form: "failure",
        title: variables.noticeTitle,
        line: failureLine({ cause: error.cause, place: "task page" }),
        words: [refusalWords(error)],
      });

      // Not returned, so the card goes back at once. A write whose answer could
      // not be read may still have been carried out.
      void queryClient.invalidateQueries({ queryKey: daemonKeys.tasks(tag) });
    },
  });
}

/**
 * Whether "Collapsed by default" is checked: the pending writes of this comment
 * laid over the file value, in send order and the last one winning.
 *
 * `collapsed: null` is a removal, so it reads as not collapsed — written as
 * `pending?.collapsed ?? file` the check would stay on for the whole of a write
 * that turns the flag off. Only the `collapsed` key is read, so a save of the
 * same comment's text in flight cannot move it.
 */
export function usePendingCollapsed(tag: string, id: string, commentId: number, onDisk: boolean): boolean {
  const flags = usePendingVariables<CommentWrite>(commentWriteKey(tag)).flatMap(({ variables }) =>
    variables.id === id
    && variables.kind === "update"
    && variables.commentId === commentId
    && "collapsed" in variables.change
      ? [variables.change.collapsed === true]
      : []);

  return flags.at(-1) ?? onDisk;
}
