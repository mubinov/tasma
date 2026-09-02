import { causeOf, fail } from "../store/errors.js";
import type {
  CommentChange,
  ConfigResult,
  ListResult,
  Project,
  ProjectPaths,
  ReadResult,
  TaskChange,
  WriteResult,
} from "../store/index.js";
import { taskEntryOf } from "../store/paths.js";
import { openProjectDirectory } from "../store/store.js";
import type { InstructionsResult } from "../workflow/index.js";
import { TaskIndex } from "./cache.js";
import { REASON_LIMIT, short } from "./message.js";
import type { IndexedProject, IndexOptions, QueryResult } from "./types.js";
import { Watches, type Watching, type WatchHandlers } from "./watch.js";

/**
 * A project that keeps the frontmatter of its tasks in memory.
 *
 * It implements `Project` by delegation, so the store never learns that an index
 * exists and the two layers stay separable. A write goes to the store and the
 * file it named is read back before the call returns, which is what makes a
 * query that follows a write see it.
 */
class IndexedProjectStore implements IndexedProject {
  readonly #project: Project;
  readonly #cache: TaskIndex;
  readonly #watches: Watching;
  /** The work a watch started that no caller awaits, which `close()` does. */
  readonly #pending = new Set<Promise<void>>();
  #closed = false;

  constructor(project: Project, cache: TaskIndex, watching: (handlers: WatchHandlers) => Watching) {
    this.#project = project;
    this.#cache = cache;
    this.#watches = watching({
      onTask: (file) => {
        if (!this.#closed) this.#detached(this.#cache.apply(file), file.path);
      },
      onTasksDirectory: () => this.#detached(this.#reconcile(false), this.paths.tasks),
      onFailure: (diagnostic) => this.#cache.report(diagnostic),
    });
  }

  get paths(): ProjectPaths {
    return this.#project.paths;
  }

  query(): QueryResult {
    this.#live();
    return this.#cache.query();
  }

  followsDisk(): boolean {
    this.#live();
    return this.#cache.followsDisk();
  }

  async rescan(): Promise<void> {
    this.#live();
    await this.#reconcile(true);
  }

  /**
   * Releases the watches and waits for the work they already started. A read
   * still running holds a task file open and can still reach the listener, so a
   * close that returned before it would return a promise the caller cannot rely
   * on. Every other call throws afterwards: the map is no longer maintained, and
   * a stale answer that looks live is worse than an error. The project it wraps
   * is untouched and stays usable.
   *
   * The index is closed last, once nothing is left to wait for. Work a watch
   * started that this cannot wait for — a debounce that fired and is reading a
   * name of its own — is left with no way to reach the listener rather than
   * chased, so no finding of it arrives behind the caller's back.
   */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#watches.close();
    await Promise.all(this.#pending);
    this.#cache.close();
  }

  async readTask(id: string): Promise<ReadResult> {
    this.#live();
    return this.#project.readTask(id);
  }

  async config(): Promise<ConfigResult> {
    this.#live();
    return this.#project.config();
  }

  async listTaskIds(): Promise<ListResult> {
    this.#live();
    return this.#project.listTaskIds();
  }

  async stepInstructions(workflow: string, step: string): Promise<InstructionsResult> {
    this.#live();
    return this.#project.stepInstructions(workflow, step);
  }

  async createTask(input: TaskChange): Promise<WriteResult> {
    this.#live();
    // The one write whose file a failure leaves unnamed: the id is issued by the
    // call. A file written before a counter write failed is converged by the
    // watcher instead.
    const result = await this.#project.createTask(input);
    await this.#applied(result.id);
    return result;
  }

  updateTask(id: string, change: TaskChange): Promise<WriteResult> {
    return this.#write(id, () => this.#project.updateTask(id, change));
  }

  deleteTask(id: string): Promise<WriteResult> {
    return this.#write(id, () => this.#project.deleteTask(id));
  }

  addComment(id: string, input: CommentChange): Promise<WriteResult> {
    return this.#write(id, () => this.#project.addComment(id, input));
  }

  updateComment(id: string, commentId: number, change: CommentChange): Promise<WriteResult> {
    return this.#write(id, () => this.#project.updateComment(id, commentId, change));
  }

  deleteComment(id: string, commentId: number): Promise<WriteResult> {
    return this.#write(id, () => this.#project.deleteComment(id, commentId));
  }

  /**
   * Runs one write and reads its file back whichever way the call ended. Most
   * failures leave the disk untouched, but not all — a `deleteTask` of a file a
   * hand edit already removed throws while the entry still stands — and the read
   * converges either way, because it is the disk that decides.
   *
   * The read stands in a `finally` and still never decides how the write ended:
   * `apply` answers for every fault it meets and raises none, so what the store
   * returned, and the code it refused with, reach the caller unchanged.
   */
  async #write(id: string, call: () => Promise<WriteResult>): Promise<WriteResult> {
    this.#live();
    try {
      return await call();
    } finally {
      await this.#applied(id);
    }
  }

  /** Reads back the file of one task, for an id that names one. */
  async #applied(id: string): Promise<void> {
    const file = taskEntryOf(this.paths, `${id}.md`);
    if (file !== undefined) await this.#cache.apply(file);
  }

  /**
   * Runs work a watch started and nobody awaits. A watch callback has no caller
   * to hand a fault to, and a rejection nothing handles ends the host process,
   * so the fault becomes the diagnostic that says the index is no longer live.
   */
  #detached(work: Promise<void>, path: string): void {
    const done = work.catch((error: unknown) => {
      this.#cache.report({
        code: "index-watch-failed",
        message: `the index could not take up a change of this name, so it is no longer live: ${short(causeOf(error), REASON_LIMIT)}`,
        path,
      });
    });
    this.#pending.add(done);
    void done.finally(() => this.#pending.delete(done));
  }

  /**
   * Takes every watch that is down, and then reads the directory. `awaited`
   * carries whether a caller is waiting for the result, which is what decides
   * how many files the scan reads at a time.
   */
  async #reconcile(awaited: boolean): Promise<void> {
    if (this.#closed) return;
    await this.#watches.ensure();
    await this.#cache.reconcile(awaited);
  }

  #live(): void {
    if (this.#closed) fail("index-closed", "this index is closed and no longer answers for its project");
  }
}

/**
 * The index over a project, taking the watching it will do. The watches are
 * released again when the first scan fails, so a caller left with a rejection is
 * left with nothing open.
 */
export async function openIndexed(
  project: Project,
  options: IndexOptions,
  watching: (handlers: WatchHandlers) => Watching,
): Promise<IndexedProject> {
  // The same check every store call makes, so a project nobody registered is
  // refused here rather than at the first query.
  await openProjectDirectory(project.paths);
  const indexed = new IndexedProjectStore(project, new TaskIndex(project.paths, options.onDiagnostic), watching);
  try {
    await indexed.rescan();
  } catch (error) {
    await indexed.close();
    throw error;
  }
  return indexed;
}

/**
 * Opens an index over a project and starts watching it.
 *
 * It takes a `Project` rather than the options one is built from, so that
 * exactly one place names a project and expands a root:
 * `await openIndexedProject(openProject({ project, root }))`. It is
 * asynchronous where `openProject` is not, and the asymmetry is the signal:
 * `openProject` touches no disk, while this reads the directory and takes a
 * watch handle that `close()` must release.
 */
export function openIndexedProject(project: Project, options: IndexOptions = {}): Promise<IndexedProject> {
  return openIndexed(project, options, (handlers) => new Watches(project.paths, handlers));
}
