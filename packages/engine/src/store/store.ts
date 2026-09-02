import type { Stats } from "node:fs";
// A public name of the format layer comes from the barrel the package
// publishes; a name it does not export comes from the file that holds it.
import {
  type Diagnostic,
  type Frontmatter,
  hasSource,
  parseTask,
  serializeTask,
  type Task,
  type TaskComment,
} from "../format/index.js";
import { COMMENT, FRONTMATTER } from "../format/schema.js";
import { deepEqual } from "../format/values.js";
import type { InstructionsResult } from "../workflow/index.js";
import { createExclusive, entryAt, makeDirectory, readRegularFile, removeFile, replaceFile } from "./atomic.js";
import { resolveConfig, resolveWorkflowsPath } from "./config.js";
import { errnoOf, fail } from "./errors.js";
import { issueCommentId, issueTaskId, rebuildNextTaskId, writeState } from "./ids.js";
import { type ProjectPaths, projectPaths, scanTasks, taskPath } from "./paths.js";
import type {
  CommentChange,
  ConfigResult,
  ListResult,
  ProjectOptions,
  ReadResult,
  StoreDiagnostic,
  TaskChange,
  WriteResult,
} from "./types.js";
import { validateBlockedBy, validateLabels, validateMember } from "./validate.js";
import {
  openConfiguredWorkflows,
  openWorkflowsForRead,
  readStepInstructions,
  reportWorkflowInto,
  validateWorkflowInto,
  type WriteContext,
} from "./workflow.js";

/**
 * The frontmatter fields the store writes itself. A change that states one is
 * refused rather than ignored: `id` and `next_comment_id` would let a caller
 * manufacture a duplicate id.
 */
const TASK_OWNED = ["id", "created", "updated", "next_comment_id"];

/** The same for one comment. */
const COMMENT_OWNED = ["id", "created", "updated"];

/**
 * The fields a change may state: what the format defines, less what the store
 * owns. A key of any other name is refused rather than dropped, because the
 * writer would never write it into the file.
 */
const TASK_WRITABLE = new Set(Object.keys(FRONTMATTER).filter((key) => !TASK_OWNED.includes(key)));
const COMMENT_WRITABLE = new Set(Object.keys(COMMENT).filter((key) => !COMMENT_OWNED.includes(key)));

/**
 * The fields the format requires and the caller writes. A change that clears one
 * is refused here rather than in the writer, which would name a field the caller
 * has no API for.
 */
const TASK_REQUIRED = [...TASK_WRITABLE].filter((key) => FRONTMATTER[key as keyof typeof FRONTMATTER].required);
const COMMENT_REQUIRED = [...COMMENT_WRITABLE].filter((key) => COMMENT[key as keyof typeof COMMENT].required);

/** Whether a field one write states moves `updated`. `order` is the one that does not. */
function movesUpdated(key: string): boolean {
  return key !== "order";
}

/** The fields a write states, as they were stored after validation. */
type Written = Pick<WriteResult, "status" | "priority" | "labels" | "blocked_by">;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * One instant as the format requires it: seconds, no fraction, and an offset in
 * minutes east of UTC rather than `Z`, which would discard when the author was
 * working.
 */
export function timestamp(at: Date, offset: number): string {
  const local = new Date(at.getTime() + offset * 60_000);
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  const size = Math.abs(offset);
  return `${date}T${time}${offset < 0 ? "-" : "+"}${pad(Math.floor(size / 60))}:${pad(size % 60)}`;
}

function now(): string {
  const at = new Date();
  return timestamp(at, -at.getTimezoneOffset());
}

/**
 * Rejects a change key this layer cannot write, naming it and the reason. The
 * keys include the symbol keys, which the spread that splits `body` from the
 * fields carries with them: the snapshot the format layer stores under one
 * decides what a rewrite reproduces byte for byte.
 */
function checkWritable(change: object, owned: string[], writable: Set<string>, label: string): void {
  for (const key of Reflect.ownKeys(change)) {
    if (key === "body") continue;
    const named = typeof key === "string";
    if (named && writable.has(key)) continue;
    const reason
      = named && owned.includes(key)
        ? "is written by the store, not by a change"
        : 'names no field of this format; data of another component belongs under "custom"';
    fail("field-not-writable", `${label} "${String(key)}" ${reason}`);
  }
}

/** Rejects a write that leaves a field the format requires with no value. */
function checkRequired(values: Record<string, unknown>, required: string[], label: string, path: string): void {
  for (const key of required) {
    if (values[key] === undefined) fail("field-required", `${label} needs a "${key}"`, path);
  }
}

/** The diagnostics of the reader, on the one channel a caller reads. */
function forward(diagnostics: Diagnostic[], path: string): StoreDiagnostic[] {
  return diagnostics.map(({ code, message, line }) => ({ code, message, path, line }));
}

/**
 * Validates `status`, `priority`, `labels` and `blocked_by` wherever the write
 * states one, and writes the value each resolves to back into `frontmatter`.
 * Only the key set of the change is validated, so a task holding a status
 * configuration has since dropped, or a blocker the project has since deleted,
 * can still have its title edited.
 *
 * It is asynchronous because resolving a workflow reads a file and resolving a
 * blocker stats one, while the other checks of the loop are pure.
 */
async function validateFieldsInto(check: WriteContext): Promise<Written> {
  const { config, frontmatter, keys, path, paths, diagnostics } = check;
  const written: Written = {};
  for (const key of keys) {
    const value = frontmatter[key];
    // A key the change cleared holds no value to check.
    if (value === undefined) continue;
    if (key === "status") {
      written.status = validateMember(value, config.statuses, "status", path, diagnostics);
      frontmatter.status = written.status;
    } else if (key === "priority") {
      written.priority = validateMember(value, config.priorities, "priority", path, diagnostics);
      frontmatter.priority = written.priority;
    } else if (key === "labels") {
      written.labels = validateLabels(value, path, diagnostics);
      frontmatter.labels = written.labels;
    } else if (key === "blocked_by") {
      written.blocked_by = await validateBlockedBy(value, paths, frontmatter.id, path, diagnostics);
      frontmatter.blocked_by = written.blocked_by;
    }
  }
  await validateWorkflowInto(check);
  return written;
}

/**
 * Rejects a task whose parsed source the store's own copying stripped, which is
 * a defect of this layer rather than of the file. Each comment carries a
 * snapshot of its own, so a check of the frontmatter alone would pass while
 * every marker was regenerated in silence.
 */
export function assertSnapshots(task: Task, generated: readonly TaskComment[], path: string): void {
  if (!hasSource(task)) fail("snapshot-lost", "the frontmatter lost the source it was read from", path);
  for (const comment of task.comments) {
    if (generated.includes(comment) || hasSource(comment)) continue;
    fail("snapshot-lost", `comment ${comment.id} lost the source it was read from`, path);
  }
}

/**
 * Writes a new task file under the next free id, and then the counter. `EEXIST`
 * means the counter was lower than the highest name in the directory. Recovery
 * is bounded — rebuild, retry once, and report on a second collision, where the
 * directory is changing underneath the write.
 */
export async function createTaskFile(
  paths: ProjectPaths,
  diagnostics: StoreDiagnostic[],
  build: (id: string) => string,
): Promise<{ id: string; number: number }> {
  const issued = await issueTaskId(paths, diagnostics);
  const state = issued.state;
  let number = issued.number;
  for (let attempt = 0; ; attempt += 1) {
    const id = `${paths.project}-${number}`;
    const path = taskPath(paths, id);
    try {
      await createExclusive(path, build(id));
    } catch (error) {
      if (errnoOf(error) !== "EEXIST") throw error;
      if (attempt > 0) fail("task-exists", "a file already exists under this name", path, error);
      const rebuilt = await rebuildNextTaskId(paths, diagnostics);
      // The second half is redundant on purpose: it is a local invariant that
      // does not depend on the scan having seen every entry.
      number = Math.max(rebuilt, number + 1);
      diagnostics.push({
        code: "next-task-id-advanced",
        message: `the task counter was lower than this file and is now ${number}`,
        path,
      });
      continue;
    }
    // The task file is written before the counter. A crash between the two
    // leaves a counter the guard catches and the rebuild repairs; the reverse
    // order would lose an id permanently and in silence.
    await writeState(paths, state, number + 1);
    return { id, number };
  }
}

/**
 * The tasks directory as this layer requires it, or absent. A symbolic link is
 * refused rather than resolved: it would take every task file of the project
 * outside the tree the caller named, which the guard on a task file — the last
 * component of its path alone — cannot see.
 */
function checkTasksDirectory(paths: ProjectPaths, entry: Stats | undefined): void {
  if (entry === undefined) return;
  if (entry.isSymbolicLink()) {
    fail("project-invalid", "the tasks directory of this project is a symbolic link", paths.tasks);
  }
  if (!entry.isDirectory()) {
    fail("project-invalid", "the tasks directory of this project is not a directory", paths.tasks);
  }
}

/**
 * Every operation checks both directories first, so a project nobody registered
 * is never reported as a missing task or an empty directory. Whoever registers
 * the project creates its directory; `tasks/` is engine storage, created on
 * demand before a write and read as empty when absent.
 *
 * It stands on its own so that the index runs the same check at open, rather
 * than reaching a project that does not exist on its first query.
 */
export async function openProjectDirectory(paths: ProjectPaths): Promise<void> {
  const directory = await entryAt(paths.directory);
  if (directory?.isSymbolicLink() === true) {
    fail("project-invalid", "the directory of this project is a symbolic link", paths.directory);
  }
  if (directory?.isDirectory() !== true) {
    fail("project-not-found", "there is no directory for this project", paths.directory);
  }
  checkTasksDirectory(paths, await entryAt(paths.tasks));
}

export type Project = {
  /** Every path of the project, for a caller that watches the directory itself. */
  readonly paths: ProjectPaths;
  readTask(id: string): Promise<ReadResult>;
  createTask(input: TaskChange): Promise<WriteResult>;
  updateTask(id: string, change: TaskChange): Promise<WriteResult>;
  deleteTask(id: string): Promise<WriteResult>;
  addComment(id: string, input: CommentChange): Promise<WriteResult>;
  updateComment(id: string, commentId: number, change: CommentChange): Promise<WriteResult>;
  deleteComment(id: string, commentId: number): Promise<WriteResult>;
  config(): Promise<ConfigResult>;
  listTaskIds(): Promise<ListResult>;
  /**
   * Every document that applies to one step of one workflow, in the order the
   * format states: the instructions of the workflow, then the instructions of
   * the project, then the step's own file. Broad to narrow.
   *
   * It exists so that the order is guaranteed by the engine rather than
   * re-implemented by each client, and it sits on the project because the
   * project is what declares which workflows may be named and what its own
   * instructions are.
   */
  stepInstructions(workflow: string, step: string): Promise<InstructionsResult>;
};

/** One task as it was read, with the path it came from. */
type Opened = { path: string; task: Task; diagnostics: StoreDiagnostic[] };

class ProjectStore implements Project {
  readonly paths: ProjectPaths;

  constructor(paths: ProjectPaths) {
    this.paths = paths;
  }

  /** Creates `tasks/` before the first write, and re-checks what the name holds. */
  async #makeTasksDirectory(): Promise<void> {
    await makeDirectory(this.paths.tasks);
    checkTasksDirectory(this.paths, await entryAt(this.paths.tasks));
  }

  /**
   * The text of one task file. A name that holds anything but a regular file is
   * no file of this task, the same way the scan passes over it.
   */
  async #text(path: string, id: string): Promise<string> {
    const read = await readRegularFile(path);
    // `task-not-found` is scoped to the path of a task file; a missing name
    // anywhere else in this layer means something else.
    if (typeof read === "string") fail("task-not-found", `there is no task ${id}`, path);
    return read.text;
  }

  async #open(id: string): Promise<Opened> {
    const path = taskPath(this.paths, id);
    const text = await this.#text(path, id);
    const { task, diagnostics } = parseTask(text, { filename: path });
    const carried = task.frontmatter.id;
    if (carried !== id) {
      // The id field states which task a file is, so writing this one back would
      // put the change in the wrong file.
      fail("id-mismatch", `this file carries the id "${carried}", so it is not task ${id}`, path);
    }
    return { path, task, diagnostics: forward(diagnostics, path) };
  }

  /** The tail every rewrite shares: assert every snapshot, then serialize and rename. */
  async #rewrite(path: string, next: Task, generated: readonly TaskComment[] = []): Promise<void> {
    assertSnapshots(next, generated, path);
    await replaceFile(path, serializeTask(next, { filename: path }));
  }

  async readTask(id: string): Promise<ReadResult> {
    await openProjectDirectory(this.paths);
    const { path, task, diagnostics } = await this.#open(id);
    const resolve = () => resolveWorkflowsPath(this.paths);
    const openHandle = () => openWorkflowsForRead(this.paths.root, resolve, diagnostics);
    await reportWorkflowInto(openHandle, task.frontmatter, path, diagnostics);
    return { task, diagnostics };
  }

  async stepInstructions(workflow: string, step: string): Promise<InstructionsResult> {
    await openProjectDirectory(this.paths);
    const diagnostics: StoreDiagnostic[] = [];
    const config = await resolveConfig(this.paths, diagnostics);
    const workflows = openConfiguredWorkflows(this.paths.root, config);
    const documents = await readStepInstructions(workflows, config, workflow, step, diagnostics);
    return { documents, diagnostics };
  }

  async config(): Promise<ConfigResult> {
    await openProjectDirectory(this.paths);
    const diagnostics: StoreDiagnostic[] = [];
    return { config: await resolveConfig(this.paths, diagnostics), diagnostics };
  }

  async listTaskIds(): Promise<ListResult> {
    await openProjectDirectory(this.paths);
    const scan = await scanTasks(this.paths);
    return { ids: scan.entries.map((entry) => entry.id), diagnostics: scan.diagnostics };
  }

  async createTask(input: TaskChange): Promise<WriteResult> {
    await openProjectDirectory(this.paths);
    checkWritable(input, TASK_OWNED, TASK_WRITABLE, "frontmatter key");
    const diagnostics: StoreDiagnostic[] = [];
    const config = await resolveConfig(this.paths, diagnostics);
    const { body, ...fields } = input;
    const stamp = now();
    const frontmatter: Record<string, unknown> = {
      ...fields,
      status: fields.status ?? config.default_status,
      created: stamp,
      updated: stamp,
      next_comment_id: 1,
    };
    checkRequired(frontmatter, TASK_REQUIRED, "a new task", this.paths.tasks);
    // A create writes `status` whether the caller stated it or the default did.
    const keys = new Set([...Object.keys(fields), "status"]);
    // Nothing is stored yet, so a `step` with no `workflow` in the same call
    // finds no effective workflow and is refused. A migration writes both.
    const written = await validateFieldsInto({
      workflows: openConfiguredWorkflows(this.paths.root, config),
      config,
      frontmatter,
      keys,
      path: this.paths.tasks,
      paths: this.paths,
      diagnostics,
    });

    await this.#makeTasksDirectory();
    const created = await createTaskFile(this.paths, diagnostics, (id) => {
      // A create builds every region from typed fields, so it has no snapshot to
      // preserve and is never a no-op.
      const task: Task = { frontmatter: { ...frontmatter, id } as Frontmatter, body: body ?? "", comments: [] };
      return serializeTask(task, { filename: taskPath(this.paths, id) });
    });
    return { id: created.id, ...written, diagnostics };
  }

  async updateTask(id: string, change: TaskChange): Promise<WriteResult> {
    await openProjectDirectory(this.paths);
    checkWritable(change, TASK_OWNED, TASK_WRITABLE, "frontmatter key");
    const diagnostics: StoreDiagnostic[] = [];
    const config = await resolveConfig(this.paths, diagnostics);
    const opened = await this.#open(id);
    const path = opened.path;
    diagnostics.push(...opened.diagnostics);

    const { body: given, ...fields } = change;
    // The change is applied by spread, never through a deep copy: the source the
    // writer reproduces byte for byte is stored under a symbol key.
    const frontmatter: Record<string, unknown> = { ...opened.task.frontmatter, ...fields };
    checkRequired(frontmatter, TASK_REQUIRED, "a task", path);
    const written = await validateFieldsInto({
      workflows: openConfiguredWorkflows(this.paths.root, config),
      config,
      frontmatter,
      keys: new Set(Object.keys(fields)),
      path,
      paths: this.paths,
      diagnostics,
    });
    // A key present with the value `undefined` clears the field, and a body
    // cleared is an empty body; a key the change does not state is left alone.
    const body = Object.hasOwn(change, "body") ? (given ?? "") : opened.task.body;

    // The comparison runs after the conversion and before `updated` moves.
    // Comparing first would read `Customer-Request` as a change to a file that
    // already stores `customer-request`; moving `updated` first would leave no
    // write a no-op.
    const stored = opened.task.frontmatter as unknown as Record<string, unknown>;
    const changed = Object.keys(fields).filter((key) => !deepEqual(stored[key], frontmatter[key]));
    const bodyChanged = body !== opened.task.body;
    // A write that changes nothing is not an edit, but a conversion the caller
    // stated is still reported.
    if (changed.length === 0 && !bodyChanged) return { id, ...written, diagnostics };
    if (bodyChanged || changed.some(movesUpdated)) frontmatter.updated = now();

    const next: Task = { ...opened.task, frontmatter: frontmatter as Frontmatter, body };
    await this.#rewrite(path, next);
    return { id, ...written, diagnostics };
  }

  /**
   * Removes the file of one task. It is the one operation that does not open the
   * file first, so a file too corrupt to parse can still be deleted; the
   * `id-mismatch` guard therefore does not run here.
   */
  async deleteTask(id: string): Promise<WriteResult> {
    await openProjectDirectory(this.paths);
    const path = taskPath(this.paths, id);
    try {
      await removeFile(path);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") fail("task-not-found", `there is no task ${id}`, path);
      throw error;
    }
    return { id, diagnostics: [] };
  }

  async addComment(id: string, input: CommentChange): Promise<WriteResult> {
    await openProjectDirectory(this.paths);
    checkWritable(input, COMMENT_OWNED, COMMENT_WRITABLE, "marker key");
    const { path, task, diagnostics } = await this.#open(id);
    const { body, ...fields } = input;
    checkRequired(fields, COMMENT_REQUIRED, "a new comment", path);
    const commentId = issueCommentId(task, path, diagnostics);
    const stamp = now();
    // Built from typed fields, so this one region legitimately carries no source.
    const comment = { ...fields, id: commentId, created: stamp, body: body ?? "" } as TaskComment;
    const next: Task = {
      ...task,
      frontmatter: { ...task.frontmatter, next_comment_id: commentId + 1, updated: stamp },
      comments: [...task.comments, comment],
    };
    await this.#rewrite(path, next, [comment]);
    return { id, commentId, diagnostics };
  }

  async updateComment(id: string, commentId: number, change: CommentChange): Promise<WriteResult> {
    await openProjectDirectory(this.paths);
    checkWritable(change, COMMENT_OWNED, COMMENT_WRITABLE, "marker key");
    const { path, task, diagnostics } = await this.#open(id);
    const current = task.comments.find((comment) => comment.id === commentId);
    if (current === undefined) fail("comment-not-found", `this file carries no comment ${commentId}`, path);

    const { body: given, ...fields } = change;
    const stored = current as unknown as Record<string, unknown>;
    const merged = { ...current, ...fields } as unknown as Record<string, unknown>;
    checkRequired(merged, COMMENT_REQUIRED, "a comment", path);
    const body = Object.hasOwn(change, "body") ? (given ?? "") : current.body;
    const changed = Object.keys(fields).some((key) => !deepEqual(stored[key], merged[key]));
    if (!changed && body === current.body) return { id, commentId, diagnostics };

    const stamp = now();
    const edited = { ...merged, updated: stamp, body } as unknown as TaskComment;
    const next: Task = {
      ...task,
      frontmatter: { ...task.frontmatter, updated: stamp },
      comments: task.comments.map((comment) => (comment.id === commentId ? edited : comment)),
    };
    await this.#rewrite(path, next);
    return { id, commentId, diagnostics };
  }

  async deleteComment(id: string, commentId: number): Promise<WriteResult> {
    await openProjectDirectory(this.paths);
    const { path, task, diagnostics } = await this.#open(id);
    if (!task.comments.some((comment) => comment.id === commentId)) {
      fail("comment-not-found", `this file carries no comment ${commentId}`, path);
    }
    // The counter does not move: removing a comment does not free its id.
    const next: Task = {
      ...task,
      frontmatter: { ...task.frontmatter, updated: now() },
      comments: task.comments.filter((comment) => comment.id !== commentId),
    };
    await this.#rewrite(path, next);
    return { id, commentId, diagnostics };
  }
}

/**
 * A handle on one project. Configuration, the counter and the task files are all
 * per project, so the project is the entry point rather than an argument. The
 * call performs no I/O: it expands the root and checks the form of the tag, and
 * every path below that point is explicit, which is what lets a test — and later
 * a daemon — run against another tree with no environment override.
 */
export function openProject(options: ProjectOptions): Project {
  return new ProjectStore(projectPaths(options));
}
