import { parseFrontmatter } from "../format/index.js";
import { labelFault } from "../format/schema.js";
import { entryAt, readRegularFile } from "./atomic.js";
import { fail, type TaskStoreErrorCode } from "./errors.js";
import { type ProjectPaths, type TaskEntry, taskEntryOf } from "./paths.js";
import type { StoreDiagnostic } from "./types.js";

/**
 * The keys of a record a caller states. A key this layer does not know is
 * refused rather than passed over: it is a value the caller believes it stated.
 * Symbol keys are checked too, so a key of any kind is answered for.
 */
export function checkedKeys(record: object, known: ReadonlySet<string>, reason: string): (string | symbol)[] {
  const keys = Reflect.ownKeys(record);
  for (const key of keys) {
    if (typeof key !== "string" || !known.has(key)) {
      fail("field-not-writable", `"${String(key)}" ${reason}`);
    }
  }
  return keys;
}

/**
 * The labels as they are stored. An uppercase letter is converted rather than
 * refused, because `Backend` and `backend` denote one label; a space or a
 * separator would be a guess about intent. Deduplication is unconditional: two
 * statements of one label store it once either way, and one label carries one
 * report of each kind, however many times and however spelled it was stated.
 */
export function validateLabels(value: unknown, path: string, diagnostics: StoreDiagnostic[]): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail("label-invalid", "labels must hold a list of strings", path);
  }
  const stored: string[] = [];
  // Membership through a set rather than a scan of what is stored: the list
  // reaches here from a request body, whose length is the caller's to choose.
  const seen = new Set<string>();
  // Both reports are keyed by the label stored, the rule `resolveBlocked`
  // follows: one diagnostic of a repeat says all a second would. The key has to
  // be a stored value for the list to stay bounded by what the write stored — a
  // label of n letters has 2^n spellings, each of them a distinct `given`. The
  // conversion message quotes the first spelling that produced the label.
  const converted = new Set<string>();
  const reported = new Set<string>();
  for (const given of value) {
    // Locale-independent, so a Turkish locale cannot turn "I" into another letter.
    const label = given.toLowerCase();
    if (label !== given && !converted.has(label)) {
      converted.add(label);
      diagnostics.push({
        code: "label-case-converted",
        message: `the label "${given}" was stored as "${label}"`,
        path,
      });
    }
    const fault = labelFault(label);
    if (fault !== undefined) fail("label-invalid", `the label "${given}" ${fault}`, path);
    if (seen.has(label)) {
      if (!reported.has(label)) {
        reported.add(label);
        diagnostics.push({
          code: "label-duplicate-dropped",
          message: `the label "${label}" was stated more than once and is stored once`,
          path,
        });
      }
      continue;
    }
    seen.add(label);
    stored.push(label);
  }
  return stored;
}

/**
 * The blockers as they are stored: the ids of tasks of this project, each one
 * naming a file that stands. Deduplication keeps the first position, the rule
 * `validateLabels` follows.
 *
 * It touches the filesystem, because an id is refused on the ground that the
 * project holds no task under it. The form of an id is checked before any path
 * is built, which is what keeps a value such as `../../etc/passwd` from reaching
 * one. The stat is an `lstat`, so a symbolic link standing at a task's name is no
 * task — the rule the store applies to every name it wrote itself.
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
  // Membership through a set, the rule `validateLabels` follows and for the same
  // reason: the list reaches here from a request body.
  const seen = new Set<string>();
  // A report per distinct id, the rule `validateLabels` follows and for the same
  // reason: the list reaches here from a request body.
  const reported = new Set<string>();
  for (const id of value) {
    if (id === ownId) fail("blocked-by-invalid", `"${id}" is this task, and a task cannot block itself`, path);
    if (seen.has(id)) {
      if (!reported.has(id)) {
        reported.add(id);
        diagnostics.push({
          code: "blocked-by-duplicate-dropped",
          message: `the blocker "${id}" was stated more than once and is stored once`,
          path,
        });
      }
      continue;
    }
    seen.add(id);
    stored.push(id);
  }
  // One stat per blocker, run at once, over the deduplicated list: the fan-out is
  // the number of distinct ids the write named. The refusal names the first
  // refused id in list order, not the first stat to finish.
  const checks = await Promise.allSettled(stored.map((id) => standingTaskEntry(paths, id, "blocked-by-unknown", path)));
  const refused = checks.find((check) => check.status === "rejected");
  if (refused !== undefined) throw refused.reason;
  return stored;
}

/**
 * The entry of a task of this project that `id` names, refused with `code`
 * where the id has the wrong form or no regular file stands for it. The form
 * is checked before any path is built, so a value such as `../x` never reaches
 * the filesystem, and a symbolic link is not a task.
 */
async function standingTaskEntry(
  paths: ProjectPaths,
  id: string,
  code: TaskStoreErrorCode,
  path: string,
): Promise<TaskEntry> {
  const entry = taskEntryOf(paths, `${id}.md`);
  if (entry === undefined) fail(code, `"${id}" is not a task id of project ${paths.project}`, path);
  if ((await entryAt(entry.path))?.isFile() !== true) fail(code, `"${id}" names no task of project ${paths.project}`, path);
  return entry;
}

/**
 * Refuses a parent that is not the id of another task of this project with a
 * file that stands, and a parent whose chain of ancestors leads back to this
 * task. The value is stored as given.
 *
 * A create has no id yet, so no ancestor can name it and the chain is not
 * walked. The walk ends without a refusal where an ancestor cannot be read: a
 * fault in that file concerns another task.
 */
export async function validateParent(value: unknown, paths: ProjectPaths, ownId: unknown, path: string): Promise<void> {
  if (typeof value !== "string") fail("parent-invalid", "parent must be a string", path);
  if (value === ownId) fail("parent-invalid", `"${value}" is this task, and a task cannot be its own parent`, path);
  const entry = await standingTaskEntry(paths, value, "parent-unknown", path);
  if (typeof ownId !== "string") return;
  // In insertion order, so the set is also the chain the refusal names. The set
  // bounds the walk by the number of tasks, and a cycle a hand edit left higher
  // in the chain ends it.
  const chain = new Set([ownId, value]);
  let next = await parentEntryOf(paths, entry);
  while (next !== undefined) {
    if (next.id === ownId) {
      fail("parent-invalid", `setting parent "${value}" makes a cycle: ${[...chain, ownId].join(" → ")}`, path);
    }
    if (chain.has(next.id)) return;
    chain.add(next.id);
    next = await parentEntryOf(paths, next);
  }
}

/** The task an ancestor's file names as its parent, or `undefined` where the walk cannot go on. */
async function parentEntryOf(paths: ProjectPaths, ancestor: TaskEntry): Promise<TaskEntry | undefined> {
  let parent: unknown;
  try {
    const read = await readRegularFile(ancestor.path);
    if (typeof read === "string") return undefined;
    // The frontmatter alone, so a fault below it does not end the walk.
    parent = parseFrontmatter(read.text, { filename: ancestor.path }).parent;
  } catch {
    return undefined;
  }
  return typeof parent === "string" ? taskEntryOf(paths, `${parent}.md`) : undefined;
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
