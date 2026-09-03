// What each task route was asked for in its query, and which entries a listing
// answers with. Every route reads its query here — the listing its filter, the
// read of one task its options, and the comment map and the six writes alike the
// assertion that they carry no query at all — so one set of rules covers all
// nine of them.
//
// A route declares the query keys it takes, and a key it does not declare is
// refused rather than passed over: a mistyped `?stauts=To+Do` that silently
// returned the whole listing is a bad failure for an agent, and the usual
// argument for ignoring one — an older daemon meeting a newer client — does not
// apply to a daemon and a client that ship from one repository at one version.

import type { IndexEntry } from "@tasma/engine";
import type { TaskFilter, TaskReadOptions } from "@tasma/protocol";
import { DaemonError } from "../http/failure.js";

/**
 * The keys each route declares, written as a table over the contract type the
 * route answers. The table is what keeps the two ends in step: a key added to
 * `TaskFilter` that the client would then send fails the typecheck here until
 * this route declares it, rather than reaching a daemon that refuses it.
 */
const LISTING_KEYS = Object.keys({
  status: true,
  priority: true,
  label: true,
  parent: true,
  step: true,
  blocked: true,
} satisfies Record<keyof TaskFilter, true>);

const READ_KEYS = Object.keys({ comments: true } satisfies Record<keyof TaskReadOptions, true>);

/**
 * Refuses every key the route does not declare. The key is named, because the
 * refusal is only useful to a caller that mistyped one.
 */
function assertDeclared(query: URLSearchParams, declared: readonly string[]): void {
  for (const key of query.keys()) {
    if (declared.includes(key)) continue;
    throw new DaemonError("malformed-request", `this route declares no query key "${key}"`);
  }
}

/**
 * The one value of a key, refusing a repeat.
 *
 * `URLSearchParams.get` returns the first value, so a caller that sent two would
 * silently have one dropped. `label` is the one repeatable key, by its own
 * docblock, and it is read through `list` instead.
 */
function single(query: URLSearchParams, key: string): string | undefined {
  const values = query.getAll(key);
  if (values.length > 1) {
    throw new DaemonError("malformed-request", `the query states "${key}" more than once, and it takes one value`);
  }
  return values[0];
}

/**
 * A text value, where an empty one reads as no filter at all — the rule an
 * absent key already stands under. The client never sends one, because
 * `buildPath` skips an `undefined`, so this covers a hand-written URL alone.
 */
function text(query: URLSearchParams, key: string): string | undefined {
  const value = single(query, key);
  return value === "" ? undefined : value;
}

/** A repeatable value, dropped altogether when nothing but empty values were sent. */
function list(query: URLSearchParams, key: string): string[] | undefined {
  const values = query.getAll(key).filter((value) => value !== "");
  return values.length === 0 ? undefined : values;
}

/** A value written as exactly `true` or `false`, and refused in any other spelling. */
function flag(query: URLSearchParams, key: string): boolean | undefined {
  const value = text(query, key);
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") {
    throw new DaemonError("malformed-request", `the query key "${key}" takes exactly "true" or "false"`);
  }
  return value === "true";
}

/** Refuses any query at all, for the routes that declare no key. */
export function assertNoQuery(query: URLSearchParams): void {
  assertDeclared(query, []);
}

export function readTaskFilter(query: URLSearchParams): TaskFilter {
  assertDeclared(query, LISTING_KEYS);
  return {
    status: text(query, "status"),
    priority: text(query, "priority"),
    label: list(query, "label"),
    parent: text(query, "parent"),
    step: text(query, "step"),
    blocked: flag(query, "blocked"),
  };
}

export function readTaskOptions(query: URLSearchParams): TaskReadOptions {
  assertDeclared(query, READ_KEYS);
  return { comments: flag(query, "comments") };
}

/**
 * Whether a stored value equals what the filter asked for, without regard to
 * case. `status` and `priority` compare this way because the store corrects the
 * case of both on write, so a stored value is always one of the configured
 * spellings.
 */
function sameText(stored: string | undefined, wanted: string): boolean {
  return stored?.toLowerCase() === wanted.toLowerCase();
}

function matches(entry: IndexEntry, filter: TaskFilter, blocked: ReadonlySet<string>): boolean {
  const { status, priority, parent, step, labels } = entry.frontmatter;
  if (filter.status !== undefined && !sameText(status, filter.status)) return false;
  if (filter.priority !== undefined && !sameText(priority, filter.priority)) return false;
  if (filter.parent !== undefined && parent !== filter.parent) return false;
  if (filter.step !== undefined && step !== filter.step) return false;
  if (filter.blocked !== undefined && blocked.has(entry.id) !== filter.blocked) return false;
  if (filter.label !== undefined) {
    const carried = new Set(labels ?? []);
    // Conjunctive: an entry matches only if it carries every label listed, each
    // lowercased first, the rule the store applies when it stores one.
    if (!filter.label.every((label) => carried.has(label.toLowerCase()))) return false;
  }
  return true;
}

/**
 * The entries a filter keeps, in the order the listing gave them.
 *
 * `blocked` is the set `resolveBlocked` returned over the **complete** listing,
 * and it is read only where the filter states `blocked`. Resolving over a
 * filtered listing would make each out-of-subset blocker read as unresolvable,
 * which is why the filter is applied here rather than before that call.
 */
export function selectEntries(
  entries: readonly IndexEntry[],
  filter: TaskFilter,
  blocked: ReadonlySet<string>,
): IndexEntry[] {
  return entries.filter((entry) => matches(entry, filter, blocked));
}
