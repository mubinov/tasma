import type { TaskInput } from "@tasma/protocol";

/** The fields of the create dialog, as they show them. */
export type TaskDraft = {
  title: string;
  status: string;
  /** `null` for none. */
  priority: string | null;
  labels: readonly string[];
  body: string;
};

/** What a create sends. It always names the status the draft shows. */
export type CreateInput = TaskInput & { title: string; status: string };

export function firstDraft(status: string): TaskDraft {
  return { title: "", status, priority: null, labels: [], body: "" };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Whether the draft differs from the draft the dialog opened with, so a cancel would lose it. */
export function hasContent(first: TaskDraft, draft: TaskDraft): boolean {
  return draft.title !== first.title
    || draft.status !== first.status
    || draft.priority !== first.priority
    || !sameList(draft.labels, first.labels)
    || draft.body !== first.body;
}

/**
 * The daemon applies the project's first workflow and places the card by its
 * column's rules, so a create names neither a workflow nor an order.
 */
export function createInput(draft: TaskDraft): CreateInput {
  return {
    title: draft.title,
    status: draft.status,
    ...(draft.priority === null ? {} : { priority: draft.priority }),
    ...(draft.labels.length === 0 ? {} : { labels: [...draft.labels] }),
    ...(draft.body === "" ? {} : { body: draft.body }),
  };
}
