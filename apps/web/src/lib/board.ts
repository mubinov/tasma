import type { Config, Diagnostic, StepOwner, TaskEntry, Workflow } from "@tasma/protocol";

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
function idNumber(id: string): number {
  return Number(id.slice(id.lastIndexOf("-") + 1));
}

function openOrder(a: TaskEntry, b: TaskEntry): number {
  const left = a.frontmatter.order;
  const right = b.frontmatter.order;
  const leftOrdered = typeof left === "number";
  const rightOrdered = typeof right === "number";

  if (leftOrdered !== rightOrdered) {
    return leftOrdered ? -1 : 1;
  }
  if (leftOrdered && rightOrdered && left !== right) {
    return left - right;
  }
  return idNumber(a.id) - idNumber(b.id);
}

// The times carry different offsets, so they are compared parsed, never as strings.
function finalOrder(a: TaskEntry, b: TaskEntry): number {
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

export function buildColumns(
  config: Pick<Config, "statuses" | "final_statuses">,
  entries: readonly TaskEntry[],
  labels: readonly string[],
): ColumnData[] {
  const statuses = config.statuses.map((status) => status.toLowerCase());
  const finals = new Set(config.final_statuses.map((status) => status.toLowerCase()));
  const selected = new Set(labels.map((label) => label.toLowerCase()));
  const columns = config.statuses.map((status) => ({ status, tasks: [] as TaskEntry[] }));

  for (const entry of entries) {
    const index = statuses.indexOf(entry.frontmatter.status.toLowerCase());
    columns[Math.max(index, 0)]?.tasks.push(entry);
  }

  return columns.map(({ status, tasks }) => {
    const final = finals.has(status.toLowerCase());
    const matching = selected.size === 0
      ? [...tasks]
      : tasks.filter((entry) => (entry.frontmatter.labels ?? []).some((label) => selected.has(label.toLowerCase())));

    return { status, final, matching: matching.sort(final ? finalOrder : openOrder), total: tasks.length };
  });
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

export function stepView(entry: TaskEntry, final: boolean, workflow: Workflow | null | undefined): StepView {
  const { step } = entry.frontmatter;

  if (step === undefined || final) {
    return { kind: "none" };
  }

  const declared = entry.frontmatter.workflow === undefined
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
