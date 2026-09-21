import type { Config, Frontmatter, TaskEntry, Workflow } from "@tasma/protocol";
import { distinctLabels, idNumber, labelChoices, type PendingWrite } from "./board";

/** One item of a property menu. */
export type PropertyChoice = { value: string; label: string };

/**
 * How a stored value finds its item. A step is declared in a workflow file and
 * the daemon reads it as written, so a name differing in case is a stale step
 * rather than the same step; a status and a priority are matched without case
 * and the daemon corrects their spelling.
 */
export type PropertyMatch = "exact" | "without case";

/** What one editable row offers, and what a pick of it sends. */
export type PropertyRow = {
  choices: PropertyChoice[];
  /** How the stored value finds its item, which differs per row. */
  match: PropertyMatch;
  /** A write of this row is in flight. */
  busy: boolean;
  /** `null` clears the field. */
  onPick: (value: string | null) => void;
};

/** What one picker row offers: a pick sends the whole next value. */
export type PickerRow<Value> = {
  /** A write of this row is in flight. */
  busy: boolean;
  onPick: (value: Value) => void;
};

/**
 * One item of a task picker: a task of the listing, an id no task stands for,
 * this task's own id, or the row that clears the field.
 */
export type TaskItem
  = | { kind: "task"; id: string; status: string; title: string }
    | { kind: "missing"; id: string }
    | { kind: "self"; id: string }
    | { kind: "none" };

export const NO_TASK: TaskItem = { kind: "none" };

/** One item of the labels picker: a label, with its count once the listing counts it, or the row that adds one. */
export type LabelItem = { kind: "label"; label: string; count?: number } | { kind: "add"; label: string };

/** The item a chosen id stands for. */
export function chosenTaskItem(entries: readonly TaskEntry[], id: string, chosen: string): TaskItem {
  if (chosen === id) {
    return { kind: "self", id };
  }

  const entry = entries.find((candidate) => candidate.id === chosen);

  return entry === undefined
    ? { kind: "missing", id: chosen }
    : { kind: "task", id: chosen, status: entry.frontmatter.status, title: entry.frontmatter.title };
}

export function taskItemIds(items: readonly TaskItem[]): string[] {
  return items.flatMap((item) => (item.kind === "none" ? [] : [item.id]));
}

/** An id the daemon refuses in `blocked_by`: one that names no task, and this task's own. */
export function isUnsendableTask(item: TaskItem): boolean {
  return item.kind === "missing" || item.kind === "self";
}

/**
 * What a task picker offers: every task of the project but this one, tasks in
 * a final status included, the newest id first. Before them, once each, stand
 * the chosen ids that are no other task of the listing.
 */
export function taskItems(entries: readonly TaskEntry[], id: string, chosen: readonly string[]): TaskItem[] {
  const unsendable = [...new Set(chosen)]
    .map((chosenId) => chosenTaskItem(entries, id, chosenId))
    .filter(isUnsendableTask);
  const tasks: TaskItem[] = entries
    .filter((entry) => entry.id !== id)
    .sort((a, b) => idNumber(b.id) - idNumber(a.id))
    .map(({ id: taskId, frontmatter: { status, title } }) => ({ kind: "task", id: taskId, status, title }));

  return [...unsendable, ...tasks];
}

export function taskMatches(item: TaskItem, query: string): boolean {
  const key = query.toLowerCase();

  switch (item.kind) {
    case "none":
      return query === "";
    case "missing":
    case "self":
      return item.id.toLowerCase().includes(key);
    case "task":
      return item.id.toLowerCase().includes(key) || item.title.toLowerCase().includes(key);
  }
}

export function sameTaskItem(item: TaskItem, value: TaskItem): boolean {
  if (item.kind === "none" || value.kind === "none") {
    return item.kind === value.kind;
  }

  return item.id === value.id;
}

export function labelItems(entries: readonly TaskEntry[]): LabelItem[] {
  return labelChoices(entries).map(({ label, count }) => ({ kind: "label", label, count }));
}

/** The labels of the task, once each, with no count. */
export function carriedLabelItems(labels: readonly string[]): LabelItem[] {
  return distinctLabels(labels).map((label) => ({ kind: "label", label }));
}

export function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function labelMatches(item: LabelItem, query: string): boolean {
  return item.label.toLowerCase().includes(query.toLowerCase());
}

/** The Add row is equal to no label, so it is never checked and a pick of it adds. */
export function sameLabelItem(item: LabelItem, value: LabelItem): boolean {
  return item.kind === "label" && value.kind === "label" && sameLabel(item.label, value.label);
}

/**
 * The keys a property control clears. `status` is required, so a write that
 * states it as null is not a removal and the result stays a `Frontmatter`.
 */
const CLEARABLE_KEYS = ["priority", "step", "parent"] as const;

const LIST_KEYS = ["labels", "blocked_by"] as const;

const OVERLAID_KEYS = ["status", ...CLEARABLE_KEYS, ...LIST_KEYS] as const;

/**
 * The frontmatter the sidebar renders while writes are in flight: the pending
 * writes of this task laid over it in send order, the last one winning, `null`
 * removing the key.
 *
 * It applies the keys the property controls write and no others. Every pending
 * write of the project reaches it, the Save of the text editor included, and
 * that one states `title` and `body`.
 *
 * The same object comes back when no pending write states one of those keys:
 * it is the input to the whole sidebar subtree, and a fresh object each render
 * would miss every memoization below it.
 */
export function applyPendingFrontmatter(
  frontmatter: Frontmatter,
  writes: readonly PendingWrite[],
): Frontmatter {
  const mine = writes.filter(
    ({ id, change }) => id === frontmatter.id && OVERLAID_KEYS.some((key) => key in change),
  );

  if (mine.length === 0) {
    return frontmatter;
  }

  const overlaid = { ...frontmatter };

  for (const { change } of mine) {
    if (typeof change.status === "string") {
      overlaid.status = change.status;
    }
    for (const key of CLEARABLE_KEYS) {
      const value = change[key];
      if (typeof value === "string") {
        overlaid[key] = value;
      } else if (value === null) {
        delete overlaid[key];
      }
    }
    for (const key of LIST_KEYS) {
      const value = change[key];
      if (Array.isArray(value)) {
        overlaid[key] = value.filter((item) => typeof item === "string");
      } else if (value === null) {
        delete overlaid[key];
      }
    }
  }

  return overlaid;
}

function nameChoices(names: readonly string[]): PropertyChoice[] {
  return names.map((name) => ({ value: name, label: name }));
}

export function statusChoices(config: Pick<Config, "statuses">): PropertyChoice[] {
  return nameChoices(config.statuses);
}

export function priorityChoices(config: Pick<Config, "priorities">): PropertyChoice[] {
  return nameChoices(config.priorities);
}

/** The steps the page knows: none while the workflow read is in flight or refused. */
export function stepChoices(workflow: Workflow | null | undefined): PropertyChoice[] {
  return nameChoices(workflow?.steps.map((step) => step.name) ?? []);
}

/**
 * What the menu's radio group carries: the configured spelling of a stored
 * value, the empty string for an absent one, so "None" is checked, and `null`
 * for a value the choices do not hold, so nothing is. The empty string there
 * would report a state the file does not hold.
 */
export function groupValue(
  value: string | undefined,
  choices: readonly { value: string }[],
  match: PropertyMatch,
): string | null {
  if (value === undefined) {
    return "";
  }

  const fold = (text: string): string => (match === "exact" ? text : text.toLowerCase());
  const key = fold(value);

  return choices.find((choice) => fold(choice.value) === key)?.value ?? null;
}
