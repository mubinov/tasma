import type { Config, Frontmatter, Workflow } from "@tasma/protocol";
import type { PendingWrite } from "./board";

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

/**
 * The keys a property control clears. `status` is required, so a write that
 * states it as null is not a removal and the result stays a `Frontmatter`.
 */
const CLEARABLE_KEYS = ["priority", "step"] as const;

const OVERLAID_KEYS = ["status", ...CLEARABLE_KEYS] as const;

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
