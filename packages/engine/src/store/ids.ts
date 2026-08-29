import { Document, parseDocument } from "yaml";
import { parseTask, type Task } from "../format/index.js";
import { isPlainMapping } from "../format/values.js";
import { readRegularFile, replaceFile } from "./atomic.js";
import { fail } from "./errors.js";
import { type ProjectPaths, scanTasks, taskNumber } from "./paths.js";
import type { StoreDiagnostic } from "./types.js";

/** The keys this engine writes into `state.yml`. Every other key is kept unchanged. */
const STATE_KEYS = new Set(["next_task_id"]);

/**
 * `state.yml` as a document rather than as values, so a key a later engine
 * version added survives a write by this one. `discarded` marks a file that
 * exists and carries no counter this engine can use.
 */
export type State = { doc: Document; next: number | undefined; discarded: boolean };

function freshState(discarded: boolean): State {
  return { doc: new Document({}), next: undefined, discarded };
}

/**
 * An id this engine can write. `-5` and `1e21` name `<PROJ>--5` and
 * `<PROJ>-1e+21`, neither of which is a task name; `2^53` no longer moves when
 * one is added to it, so a counter holding it would issue one id forever.
 */
function usable(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Reads the task counter. A `state.yml` this engine cannot use is rebuilt rather
 * than refused, unlike an unreadable `config.yml`: state is engine bookkeeping
 * and is recoverable from the task files, while configuration is human intent. A
 * name that holds no regular file counts as one it cannot use, since this layer
 * replaces the file by rename and would destroy a symbolic link there.
 */
async function readState(paths: ProjectPaths, diagnostics: StoreDiagnostic[]): Promise<State> {
  const read = await readRegularFile(paths.state);
  if (read === "absent") return freshState(false);
  if (read === "irregular") return freshState(true);
  const text = read.text;
  let values: Record<string, unknown>;
  let doc: Document;
  try {
    doc = parseDocument(text);
    if (doc.errors.length > 0) return freshState(true);
    // The value the document resolves to, not its node type: `!!set` is a
    // mapping node whose value is a `Set`, which takes no key from a write.
    const content: unknown = doc.toJS();
    if (!isPlainMapping(content)) return freshState(true);
    values = content;
  } catch {
    return freshState(true);
  }
  for (const key of Object.keys(values)) {
    if (STATE_KEYS.has(key)) continue;
    diagnostics.push({
      code: "state-key-unknown",
      message: `"${key}" is not a key this engine writes; it is kept as it is`,
      path: paths.state,
    });
  }
  const next = values.next_task_id;
  // The document is kept either way, so a key another version wrote survives the
  // write that repairs the counter.
  return usable(next) ? { doc, next, discarded: false } : { doc, next: undefined, discarded: true };
}

/** Writes the counter back, keeping every other key the file carries. */
export async function writeState(paths: ProjectPaths, state: State, next: number): Promise<void> {
  state.doc.set("next_task_id", next);
  await replaceFile(paths.state, state.doc.toString());
}

/**
 * The task number the frontmatter of one file claims, or `undefined` when it
 * claims none of this project. The scan classified the name from the directory
 * record and this read opens it a moment later, so a name that holds something
 * else by then counts toward the file-name floor alone.
 */
export async function frontmatterNumber(
  paths: ProjectPaths,
  path: string,
  diagnostics: StoreDiagnostic[],
): Promise<number | undefined> {
  const unreadable = (line?: number): undefined => {
    diagnostics.push({
      code: "task-file-unreadable",
      message: "this file cannot be read, so the id it carries does not count toward the task counter",
      path,
      line,
    });
    return undefined;
  };
  const read = await readRegularFile(path);
  if (typeof read === "string") return unreadable();
  let task: Task;
  try {
    task = parseTask(read.text, { filename: path }).task;
  } catch (error) {
    return unreadable((error as { line?: number }).line);
  }
  const id = task.frontmatter.id;
  const number = taskNumber(paths.project, `${id}.md`);
  if (number === undefined) {
    diagnostics.push({
      code: "task-file-foreign",
      message: `the id "${id}" names no task of project ${paths.project}, so it does not count toward the task counter`,
      path,
    });
  }
  return number;
}

/**
 * The next free task number, read from the files on disk. The floor comes from
 * two sources, and both are needed: the frontmatter `id` states which task a
 * file is, but the exclusive create that consumes the counter collides on a
 * **name**, and a hand-renamed file, an unparseable file and a create that died
 * mid-write each leave a name an id-only rebuild cannot see.
 *
 * A rebuild that finds no task file is not reported — that is a new project, not
 * an anomaly — while `discarded` is an anomaly either way.
 */
export async function rebuildNextTaskId(
  paths: ProjectPaths,
  diagnostics: StoreDiagnostic[],
  discarded = false,
): Promise<number> {
  const scan = await scanTasks(paths);
  diagnostics.push(...scan.diagnostics);
  let floor = 0;
  for (const entry of scan.entries) {
    floor = Math.max(floor, entry.number);
    const claimed = await frontmatterNumber(paths, entry.path, diagnostics);
    if (claimed !== undefined) floor = Math.max(floor, claimed);
  }
  const next = floor + 1;
  // A project holding the last number the name rule can carry has no free name.
  if (!usable(next)) {
    fail("task-exists", "every task number this engine can name is taken", paths.tasks);
  }
  if (discarded || scan.entries.length > 0) {
    diagnostics.push({
      code: "next-task-id-rebuilt",
      message: `the task counter was rebuilt from the files on disk and is now ${next}`,
      path: paths.state,
    });
  }
  return next;
}

/** The number the next task takes, and the state document its counter is written back into. */
export async function issueTaskId(
  paths: ProjectPaths,
  diagnostics: StoreDiagnostic[],
): Promise<{ number: number; state: State }> {
  const state = await readState(paths, diagnostics);
  if (state.next !== undefined) return { number: state.next, state };
  return { number: await rebuildNextTaskId(paths, diagnostics, state.discarded), state };
}

/**
 * The id the next comment of one task takes. The floor of 1 covers a hand
 * written `next_comment_id: 0`, which the format permits but which is not a
 * usable first id. The repair runs only on a write that issues an id, so a write
 * to another field leaves a stale counter alone and the reader keeps reporting
 * it. The guarantee is exact: no id the file still carries is reused.
 */
export function issueCommentId(task: Task, path: string, diagnostics: StoreDiagnostic[]): number {
  const stated = task.frontmatter.next_comment_id;
  const counter = usable(stated) ? stated : 0;
  const highest = task.comments.reduce((max, comment) => (usable(comment.id) ? Math.max(max, comment.id) : max), 0);
  const id = Math.max(counter, highest + 1, 1);
  if (!usable(id)) fail("comment-exists", "every comment id this engine can write is taken", path);
  if (id !== stated) {
    diagnostics.push({
      code: "next-comment-id-repaired",
      message: `next_comment_id was ${stated}; the comment took id ${id} and the counter is now ${id + 1}`,
      path,
    });
  }
  return id;
}
