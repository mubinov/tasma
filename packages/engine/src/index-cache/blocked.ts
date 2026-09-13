/**
 * A free function rather than a method on the index because it takes the entries
 * a caller already holds, so a route calls it once against the query result it
 * just took, with no second pass over the index and no configuration read inside
 * it. The flag is set on the entries a listing returns and never stored in the
 * index: the index keeps an entry current by re-reading that one file, and a
 * stored flag would have to be invalidated on a different task's file whenever a
 * status moved.
 */

import type { StoreDiagnostic } from "../store/index.js";
import { short } from "./message.js";
import type { IndexEntry } from "./types.js";

/** An entry of a listing, with whether a blocker still blocks its task. */
export type ListedEntry = IndexEntry & { blocked: boolean };

export type BlockedResult = {
  /** One per entry of the listing, in its order. */
  entries: ListedEntry[];
  /** One per blocker id that named no entry of the listing. */
  unresolved: StoreDiagnostic[];
};

/**
 * The entries of a listing, each flagged with whether a blocker still blocks it.
 *
 * A task is blocked while at least one id of its `blocked_by` either names an
 * entry whose status is not one of `finalStatuses`, or names no entry at all. An
 * id that names no entry also produces one `blocked-by-unresolved` diagnostic
 * carrying the blocked task's own path, so a caller can open the file that holds
 * the bad id. A task with no `blocked_by`, or an empty one, is never blocked.
 *
 * Each returned entry is a new object that shares the frozen `frontmatter` of
 * its input entry.
 *
 * **`entries` must be the project's complete listing.** An id that names no
 * entry is read as a blocker that still blocks, so a caller that filtered first
 * would report every task whose blocker fell outside the subset as blocked, with
 * a diagnostic for each. A caller filters after this call, never before it.
 *
 * The status comparison is case-insensitive, although the configuration
 * membership check is exact, for the reason the `status` filter states: the
 * store corrects a written status, and a hand-edited `status: done` is not one.
 *
 * Only a task's own `blocked_by` is read, which loses nothing — a blocker of a
 * blocker is either final, and so blocks nothing, or open, and so blocks already
 * — and makes a cycle harmless, with no walk to terminate.
 *
 * A blocker the index excluded resolves to no entry, so it keeps blocking: a
 * task is reported ready only when every blocker was resolved and found final.
 */
export function resolveBlocked(entries: readonly IndexEntry[], finalStatuses: readonly string[]): BlockedResult {
  const final = new Set(finalStatuses.map((status) => status.toLowerCase()));
  const statusOf = new Map(entries.map((entry) => [entry.id, entry.frontmatter.status]));
  const listed: ListedEntry[] = [];
  const unresolved: StoreDiagnostic[] = [];
  for (const entry of entries) {
    let blocked = false;
    // A reader accepts any list of strings, so one file may state an id more
    // than once; the report is per id, as one diagnostic of a repeat says all a
    // second would.
    const reported = new Set<string>();
    for (const blocker of entry.frontmatter.blocked_by ?? []) {
      const status = statusOf.get(blocker);
      if (status === undefined) {
        if (!reported.has(blocker)) {
          reported.add(blocker);
          unresolved.push({
            code: "blocked-by-unresolved",
            // What the listing holds no task for, rather than what the project
            // holds none: a file the index excluded is absent here either way.
            message: `this task states the blocker "${short(blocker)}", which the listing holds no task for`,
            path: entry.path,
          });
        }
      } else if (final.has(status.toLowerCase())) continue;
      blocked = true;
    }
    listed.push({ ...entry, blocked });
  }
  return { entries: listed, unresolved };
}
