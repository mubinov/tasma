import { labelFault } from "../format/schema.js";
import { entryAt } from "./atomic.js";
import { fail } from "./errors.js";
import { type ProjectPaths, taskEntryOf } from "./paths.js";
import type { StoreDiagnostic } from "./types.js";

/**
 * The labels as they are stored. An uppercase letter is converted rather than
 * refused, because `Backend` and `backend` denote one label; a space or a
 * separator would be a guess about intent. Deduplication is unconditional: two
 * statements of one label store it once either way.
 */
export function validateLabels(value: unknown, path: string, diagnostics: StoreDiagnostic[]): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail("label-invalid", "labels must hold a list of strings", path);
  }
  const stored: string[] = [];
  for (const given of value) {
    // Locale-independent, so a Turkish locale cannot turn "I" into another letter.
    const label = given.toLowerCase();
    if (label !== given) {
      diagnostics.push({
        code: "label-case-converted",
        message: `the label "${given}" was stored as "${label}"`,
        path,
      });
    }
    const fault = labelFault(label);
    if (fault !== undefined) fail("label-invalid", `the label "${given}" ${fault}`, path);
    if (stored.includes(label)) {
      diagnostics.push({
        code: "label-duplicate-dropped",
        message: `the label "${label}" was stated more than once and is stored once`,
        path,
      });
      continue;
    }
    stored.push(label);
  }
  return stored;
}

/**
 * The blockers as they are stored: the ids of tasks of this project, each one
 * naming a file that stands. Deduplication keeps the first position, the rule
 * `validateLabels` follows.
 *
 * It is the one validator of this file that touches the filesystem, because an
 * id is refused on the ground that the project holds no task under it. The form
 * of an id is checked before any path is built, which is what keeps a value such
 * as `../../etc/passwd` from reaching one. The stat is an `lstat`, so a symbolic
 * link standing at a task's name is no task — the rule the store applies to
 * every name it wrote itself.
 *
 * `ownId` is absent on a create, which has no id until the file is written. Such
 * a call naming the id it is about to receive is refused by the existence check
 * instead, because no task stands under it yet.
 */
export async function validateBlockedBy(
  value: unknown,
  paths: ProjectPaths,
  ownId: unknown,
  path: string,
  diagnostics: StoreDiagnostic[],
): Promise<string[]> {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail("blocked-by-invalid", "blocked_by must hold a list of strings", path);
  }
  const stored: string[] = [];
  for (const id of value) {
    if (id === ownId) fail("blocked-by-invalid", `"${id}" is this task, and a task cannot block itself`, path);
    if (stored.includes(id)) {
      diagnostics.push({
        code: "blocked-by-duplicate-dropped",
        message: `the blocker "${id}" was stated more than once and is stored once`,
        path,
      });
      continue;
    }
    stored.push(id);
  }
  const entries = stored.map((id) => {
    const entry = taskEntryOf(paths, `${id}.md`);
    if (entry === undefined) fail("blocked-by-unknown", `"${id}" is not a task id of project ${paths.project}`, path);
    return entry;
  });
  // A task names a handful of blockers, not thousands, so the stats run at once.
  const stats = await Promise.all(entries.map(async (entry) => ({ entry, stat: await entryAt(entry.path) })));
  for (const { entry, stat } of stats) {
    if (stat?.isFile() === true) continue;
    fail("blocked-by-unknown", `"${entry.id}" names no task of project ${paths.project}`, path);
  }
  return stored;
}

/**
 * The declared member a value names. The test is membership rather than a
 * character rule, because these are display strings the user declares. A single
 * case-insensitive match is corrected and reported; lowercasing instead would be
 * wrong, because a declared list may legitimately carry `High`.
 */
export function validateMember(
  value: unknown,
  declared: string[],
  field: "status" | "priority",
  path: string,
  diagnostics: StoreDiagnostic[],
): string {
  const unknown = field === "status" ? "status-unknown" : "priority-unknown";
  if (typeof value !== "string") fail(unknown, `${field} must be a string, one of ${declared.join(", ")}`, path);
  if (declared.includes(value)) return value;
  const matches = declared.filter((member) => member.toLowerCase() === value.toLowerCase());
  if (matches.length > 1) {
    fail(unknown, `${field} "${value}" matches ${matches.join(" and ")}, which gives no basis to pick one`, path);
  }
  const match = matches[0];
  if (match === undefined) fail(unknown, `${field} "${value}" is not one of ${declared.join(", ")}`, path);
  diagnostics.push({
    code: field === "status" ? "status-case-corrected" : "priority-case-corrected",
    message: `${field} "${value}" was stored as the declared "${match}"`,
    path,
  });
  return match;
}
