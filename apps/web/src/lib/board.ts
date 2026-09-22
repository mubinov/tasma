import type { Config, Diagnostic, Frontmatter, StepOwner, TaskEntry, TaskInput, Workflow } from "@tasma/protocol";

export type ColumnData = {
  /** As configured. */
  status: string;
  final: boolean;
  /** After the label filter, in column order. */
  matching: TaskEntry[];
  /** The tasks in the column before the label filter. */
  total: number;
};

export type StepView
  = | { kind: "none" }
    | { kind: "stale"; name: string }
    | { kind: "step"; name: string; owner: StepOwner; current: number; owners: StepOwner[] };

/** The listing index guarantees every id is `PROJ-N`. */
export function idNumber(id: string): number {
  return Number(id.slice(id.lastIndexOf("-") + 1));
}

/** Tasks with an `order` first, by `order`, equal values by id number; `null` when neither has one. */
function byOrder(a: TaskEntry, b: TaskEntry): number | null {
  const left = a.frontmatter.order;
  const right = b.frontmatter.order;

  if (typeof left === "number" && typeof right === "number") {
    return left === right ? idNumber(a.id) - idNumber(b.id) : left - right;
  }
  if (typeof left === "number") {
    return -1;
  }
  if (typeof right === "number") {
    return 1;
  }
  return null;
}

function openOrder(a: TaskEntry, b: TaskEntry): number {
  return byOrder(a, b) ?? idNumber(a.id) - idNumber(b.id);
}

function finalOrder(a: TaskEntry, b: TaskEntry): number {
  return byOrder(a, b) ?? byUpdated(a, b);
}

// The times carry different offsets, so they are compared parsed, never as strings.
function byUpdated(a: TaskEntry, b: TaskEntry): number {
  const left = Date.parse(a.frontmatter.updated);
  const right = Date.parse(b.frontmatter.updated);
  const leftParsed = !Number.isNaN(left);
  const rightParsed = !Number.isNaN(right);

  if (leftParsed !== rightParsed) {
    return leftParsed ? -1 : 1;
  }
  if (leftParsed && left !== right) {
    return right - left;
  }
  return idNumber(b.id) - idNumber(a.id);
}

export function isFinalStatus(status: string, finalStatuses: readonly string[]): boolean {
  const key = status.toLowerCase();

  return finalStatuses.some((final) => final.toLowerCase() === key);
}

export function buildColumns(
  config: Pick<Config, "statuses" | "final_statuses">,
  entries: readonly TaskEntry[],
  labels: readonly string[],
): ColumnData[] {
  const statuses = config.statuses.map((status) => status.toLowerCase());
  const selected = new Set(labels.map((label) => label.toLowerCase()));
  const columns = config.statuses.map((status) => ({ status, tasks: [] as TaskEntry[] }));

  for (const entry of entries) {
    const index = statuses.indexOf(entry.frontmatter.status.toLowerCase());
    columns[Math.max(index, 0)]?.tasks.push(entry);
  }

  return columns.map(({ status, tasks }) => {
    const final = isFinalStatus(status, config.final_statuses);
    const matching = selected.size === 0
      ? [...tasks]
      : tasks.filter((entry) => (entry.frontmatter.labels ?? []).some((label) => selected.has(label.toLowerCase())));

    return { status, final, matching: matching.sort(final ? finalOrder : openOrder), total: tasks.length };
  });
}

export type TaskWrite = { id: string; change: TaskInput };

/** One write to a task that the daemon has not answered yet. */
export type PendingWrite = TaskWrite & { submittedAt: number };

/**
 * The entries as the pending writes, in the order they were sent, leave them:
 * their `status`, their `order`, and the `updated` a change of status moves, as
 * the engine moves it.
 */
export function applyPending(entries: readonly TaskEntry[], pending: readonly PendingWrite[]): readonly TaskEntry[] {
  if (pending.length === 0) {
    return entries;
  }

  const changed = new Map<string, TaskEntry>();

  for (const { id, change: { status, order }, submittedAt } of pending) {
    const entry = changed.get(id) ?? entries.find((candidate) => candidate.id === id);
    if (entry === undefined) {
      continue;
    }

    const frontmatter = { ...entry.frontmatter };
    if (typeof status === "string") {
      if (status.toLowerCase() !== frontmatter.status.toLowerCase()) {
        frontmatter.updated = new Date(submittedAt).toISOString();
      }
      frontmatter.status = status;
    }
    if (order === null) {
      delete frontmatter.order;
    } else if (typeof order === "number") {
      frontmatter.order = order;
    }

    changed.set(id, { ...entry, frontmatter });
  }

  return entries.map((entry) => changed.get(entry.id) ?? entry);
}

/** Labels that differ only in case are one choice, under the first spelling of the listing. */
export function labelChoices(entries: readonly TaskEntry[]): { label: string; count: number }[] {
  const choices = new Map<string, { label: string; count: number }>();

  for (const entry of entries) {
    const counted = new Set<string>();

    for (const label of entry.frontmatter.labels ?? []) {
      const key = label.toLowerCase();
      if (counted.has(key)) {
        continue;
      }
      counted.add(key);

      const choice = choices.get(key);
      if (choice === undefined) {
        choices.set(key, { label, count: 1 });
      } else {
        choice.count += 1;
      }
    }
  }

  return [...choices.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Labels that differ only in case are one label, under the first spelling. */
export function distinctLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();

  return labels.filter((label) => {
    const key = label.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function workflowNames(entries: readonly TaskEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.frontmatter.workflow ?? []))];
}

export function stepView(frontmatter: Frontmatter, final: boolean, workflow: Workflow | null | undefined): StepView {
  const { step } = frontmatter;

  if (step === undefined || final) {
    return { kind: "none" };
  }

  const declared = frontmatter.workflow === undefined
    ? undefined
    : workflow?.steps.find((candidate) => candidate.name === step);

  if (!workflow || declared === undefined) {
    return { kind: "stale", name: step };
  }

  return {
    kind: "step",
    name: step,
    owner: declared.owner,
    current: workflow.steps.indexOf(declared),
    owners: workflow.steps.map((candidate) => candidate.owner),
  };
}

export type CardClick = Pick<MouseEvent, "target" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & {
  currentTarget: Element;
};

/**
 * Whether a click navigates this tab rather than asking the browser for a new
 * tab or window. It is the rule a router link applies to itself, which the
 * router does not export.
 */
export function opensHere(click: Pick<CardClick, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): boolean {
  return click.button === 0 && !click.metaKey && !click.ctrlKey && !click.shiftKey && !click.altKey;
}

/**
 * Whether a click on a card opens the task: not for a click on a control of its
 * own, one that ends a text selection, one from a portal rendered outside the
 * card, or one that asks the browser for something else.
 */
export function opensTask(click: CardClick): boolean {
  const { target, currentTarget } = click;

  if (!(target instanceof Element) || !currentTarget.contains(target) || target.closest("a, button") !== null) {
    return false;
  }
  if (!opensHere(click)) {
    return false;
  }

  return (window.getSelection()?.toString() ?? "") === "";
}

export function isTopPriority(priority: string | undefined, priorities: readonly string[]): boolean {
  const top = priorities[0];

  return top !== undefined && priority?.toLowerCase() === top.toLowerCase();
}

function sameWarning(a: Diagnostic, b: Diagnostic): boolean {
  return a.code === b.code && a.message === b.message && a.path === b.path && a.line === b.line;
}

/** Equal warnings inside one read all stay; only a repeat across the two reads is dropped. */
export function boardWarnings(project: readonly Diagnostic[], listing: readonly Diagnostic[]): Diagnostic[] {
  return [...project, ...listing.filter((warning) => !project.some((known) => sameWarning(known, warning)))];
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export function joinList(values: readonly string[]): string | undefined {
  return values.length === 0 ? undefined : values.join(",");
}

/**
 * The tasks of the column a move puts a card in, read the two ways a placement
 * needs them: with the tasks the label filter hides and without them, both
 * without the moved card, together with the card itself.
 *
 * @param columns The board after the label filter.
 * @param index The target column's position in the board's row.
 */
export function moveTarget(
  config: Pick<Config, "statuses" | "final_statuses">,
  entries: readonly TaskEntry[],
  columns: readonly ColumnData[],
  index: number,
  id: string,
): { unfiltered: TaskEntry[]; visible: TaskEntry[]; card: TaskEntry } {
  const others = (entry: TaskEntry): boolean => entry.id !== id;

  return {
    unfiltered: buildColumns(config, entries, [])[index]!.matching.filter(others),
    visible: columns[index]!.matching.filter(others),
    card: entries.find((entry) => entry.id === id)!,
  };
}

export type CreatedTarget = { kind: "card" } | { kind: "column"; column: number; hidden: boolean };

/**
 * Where focus goes after a create: the new card while the board shows it, else
 * the heading of the column that holds it. The listing decides the column, as
 * the daemon can correct the case of a status. A task the listing does not hold
 * goes to the column of the status the receipt names, else to the first column.
 */
export function createdTarget(
  config: Pick<Config, "statuses" | "final_statuses">,
  entries: readonly TaskEntry[],
  labels: readonly string[],
  id: string,
  status: string,
): CreatedTarget {
  if (cardPlace(buildColumns(config, entries, labels), id) !== null) {
    return { kind: "card" };
  }

  const place = cardPlace(buildColumns(config, entries, []), id);
  if (place !== null) {
    return { kind: "column", column: place.column, hidden: true };
  }

  const key = status.toLowerCase();

  return {
    kind: "column",
    column: Math.max(config.statuses.findIndex((candidate) => candidate.toLowerCase() === key), 0),
    hidden: false,
  };
}

/** Where a card stands on the board: its column, and its place in that column's visible list. */
export function cardPlace(
  columns: readonly ColumnData[],
  id: string,
): { entry: TaskEntry; column: number; index: number; final: boolean } | null {
  for (const [column, { matching, final }] of columns.entries()) {
    const index = matching.findIndex((entry) => entry.id === id);

    if (index >= 0) {
      return { entry: matching[index]!, column, index, final };
    }
  }

  return null;
}
