import { type FSWatcher, watch } from "node:fs";
import { entryAt } from "../store/atomic.js";
import { causeOf } from "../store/errors.js";
import type { ProjectPaths, StoreDiagnostic } from "../store/index.js";
import { type TaskEntry, taskEntryOf } from "../store/paths.js";
import { REASON_LIMIT, short } from "./message.js";

/**
 * How long events for one path are collected before it is read. One editor save
 * often produces several of them; the queue behind the index makes correctness
 * independent of this, so it is a cost control and nothing more.
 */
const DEBOUNCE_MS = 20;

/** What the index does with what a watch reports. */
export type WatchHandlers = {
  /** A task file of this project changed, whatever the change was. */
  onTask: (file: TaskEntry) => void;
  /** The tasks directory itself came, went, or was replaced by another one. */
  onTasksDirectory: () => void;
  /** A watch failed, so the index is no longer live. */
  onFailure: (diagnostic: StoreDiagnostic) => void;
};

/** The watching an index does, as the index depends on it. */
export type Watching = {
  ensure: () => Promise<void>;
  close: () => Promise<void>;
};

/**
 * How a watch on one directory is taken. It is a parameter so that a test can
 * drive an event, and a failure of a watch, without waiting for one.
 */
export type WatchOpen = (path: string, listener: (event: string, name: string | null) => void) => FSWatcher;

/**
 * Which directory one name holds, as a single value to compare, or `undefined`
 * for a name that holds none. It is a parameter so that a test can hold a read
 * of a name open and decide what the name holds by the time it answers.
 */
export type ReadIdentity = (path: string) => Promise<string | undefined>;

async function identityAt(path: string): Promise<string | undefined> {
  const entry = await entryAt(path);
  return entry?.isDirectory() === true ? `${entry.dev}:${entry.ino}` : undefined;
}

/** The two directories one index watches. */
type Slot = "project" | "tasks";

/**
 * Two flat watches, never one recursive watch. The watch that matters is on
 * `tasks/`; the one on the project directory exists to learn when `tasks/`
 * appears or disappears. Nothing else stands below the project directory, so
 * recursion would add nothing, while a flat watch is supported everywhere
 * without a platform caveat.
 *
 * A watch that fails is reported and not retried in a loop: the index stops
 * being live at that point, and the diagnostic is the caller's signal to
 * `rescan()`, which takes the watch again.
 */
export class Watches implements Watching {
  readonly #paths: ProjectPaths;
  readonly #handlers: WatchHandlers;
  readonly #open: WatchOpen;
  readonly #identity: ReadIdentity;
  readonly #watchers = new Map<Slot, FSWatcher>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  /** Which directory the watcher of each slot was taken on, or `undefined` for a name that held none. */
  readonly #identities = new Map<Slot, string | undefined>();
  /** The `ensure()` in flight, which the next one runs behind. */
  #ensuring: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    paths: ProjectPaths,
    handlers: WatchHandlers,
    open: WatchOpen = watch,
    identity: ReadIdentity = identityAt,
  ) {
    this.#paths = paths;
    this.#handlers = handlers;
    this.#open = open;
    this.#identity = identity;
  }

  /**
   * Establishes whichever watch is not up. Each watch is live before the name
   * one level under it is read, so a tasks directory that appears while the
   * project directory is read, and a file that appears while the tasks directory
   * is read, arrive as events instead of being missed.
   *
   * Either watcher is dropped first when it stands on another directory than its
   * name holds now. A watcher on a directory that was unlinked raises no error;
   * it goes quiet, so one left in place leaves the index blind with nothing to
   * say so.
   *
   * Every read of a name is followed by a check that the index is still open: a
   * close has already released every watch it could see, so a watch taken after
   * it would never be released.
   *
   * One call runs at a time. Two that overlap read the names independently and
   * carry no order between them, so the one that read the older state could be
   * the one to act last: it would drop the watcher the other had just taken and,
   * for a name that held no directory when it read, take none in its place —
   * leaving the index answering from a map nothing updates, with nothing said.
   * A call is chained behind the one in flight rather than joined to it, because
   * a call the project watch raised has to read the names again; only the newest
   * read then decides which watcher stands.
   */
  ensure(): Promise<void> {
    const run = this.#ensuring.then(() => this.#take());
    // A call that failed decides nothing about the one behind it, which reads
    // the names for itself.
    this.#ensuring = run.catch(() => undefined);
    return run;
  }

  async #take(): Promise<void> {
    if (this.#closed) return;
    const project = await this.#identity(this.#paths.directory);
    if (this.#closed) return;
    this.#standsOn("project", project);
    // The project watch is taken whatever its name holds, so a project directory
    // that went away is reported as the failed watch it is.
    this.#establish("project", this.#paths.directory, () => this.#onProjectEvent());
    const tasks = await this.#identity(this.#paths.tasks);
    if (this.#closed) return;
    this.#standsOn("tasks", tasks);
    // The tasks directory is gone, and with it whatever a watch on it was worth.
    if (tasks === undefined) return;
    this.#establish("tasks", this.#paths.tasks, (name) => this.#onTaskName(name));
  }

  /** Records which directory a slot's watcher stands on, dropping one that no longer stands on it. */
  #standsOn(slot: Slot, identity: string | undefined): void {
    if (this.#identities.get(slot) !== identity) this.#drop(slot);
    this.#identities.set(slot, identity);
  }

  /**
   * Releases every watch and every timer that has not fired. A timer that
   * already fired is reading a name of its own and has no caller to be waited
   * on; what it finds reaches the index, which reports nothing once it is
   * closed.
   *
   * Nothing here is waited on. The promise is what `Watching` declares, so that
   * an implementation with work to finish can be awaited.
   */
  close(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const slot of [...this.#watchers.keys()]) this.#drop(slot);
    return Promise.resolve();
  }

  #establish(slot: Slot, path: string, onEvent: (name: string | null) => void): void {
    if (this.#watchers.has(slot)) return;
    try {
      const watcher = this.#open(path, (_event, name) => onEvent(name));
      watcher.on("error", (error) => this.#failed(slot, path, error));
      this.#watchers.set(slot, watcher);
    } catch (error) {
      this.#failed(slot, path, error);
    }
  }

  /** Drops the watcher before it reports, so the next `ensure()` takes the watch again. */
  #failed(slot: Slot, path: string, error: unknown): void {
    this.#drop(slot);
    this.#handlers.onFailure({
      code: "index-watch-failed",
      message: `this directory is no longer watched, so the index is no longer live: ${short(causeOf(error), REASON_LIMIT)}`,
      path,
    });
  }

  #drop(slot: Slot): void {
    this.#watchers.get(slot)?.close();
    this.#watchers.delete(slot);
  }

  /**
   * Every event of the project directory is read for what the tasks name holds,
   * whatever name it carried and whether it carried one at all.
   *
   * No name identifies the change this watch exists to catch. A change under
   * `tasks/` arrives as `tasks`; a project directory that is removed or renamed
   * as a whole arrives under that directory's own name, because nothing inside
   * it moved, and it takes the tasks directory with it; a platform that reports
   * no name says only that something changed. Reading the name is what
   * distinguishes the three, and the read needs no name to run.
   *
   * What that costs is bounded by the read itself: a `tasks/` that is still
   * there answers with the identity it was recorded under, so an event of a file
   * written beside it costs one `lstat` and returns. While the name holds no
   * directory every event reports, which is a reconcile that stops at the same
   * check and scans nothing — and the debounce is one timer for all of them.
   */
  #onProjectEvent(): void {
    this.#debounce(this.#paths.tasks, () => {
      // The read has no caller to fail: a fault of it is a watch that no longer
      // answers for the directory, which is what the index has to be told.
      this.#tasksMoved().catch((error: unknown) => this.#failed("tasks", this.#paths.tasks, error));
    });
  }

  /**
   * What the index has to hear is the directory it watches coming, going or
   * being replaced by another one, which is a change of the directory the name
   * holds. Presence alone would miss the replacement: a removal and a creation
   * that fall inside one debounce leave a directory under the name both before
   * and after.
   *
   * A name that holds no directory is the mirror of that case and is always
   * reported, so an event that turns out to have changed nothing under the name
   * reports too. Equal identity means the opposite of nothing having happened
   * there: a creation and a removal inside one debounce leave the same absence
   * the name was recorded under. The absence is also what the write path builds
   * the index under without this reading the name again — `createTask` makes the
   * tasks directory the index then holds entries from — so it can never be read
   * as a state the index is already settled in.
   */
  async #tasksMoved(): Promise<void> {
    const identity = await this.#identity(this.#paths.tasks);
    if (identity !== undefined && identity === this.#identities.get("tasks")) return;
    // The watch stands on the directory that was replaced, which reports nothing
    // further; `ensure()` takes one on the directory that is there now.
    this.#standsOn("tasks", identity);
    this.#handlers.onTasksDirectory();
  }

  /**
   * The name rule of the scan is the rule the watcher filters by. A stray
   * markdown file and a leftover temp file are findings of a scan, not of an
   * event: they change no entry, and reporting them per event would fire over
   * and over while an editor writes.
   *
   * This is the one watch a name is needed for, because the name is the file to
   * read. A platform that reports none says nothing about which file moved.
   */
  #onTaskName(name: string | null): void {
    if (name === null) return;
    const file = taskEntryOf(this.#paths, name);
    if (file === undefined) return;
    this.#debounce(file.path, () => this.#handlers.onTask(file));
  }

  #debounce(key: string, run: () => void): void {
    clearTimeout(this.#timers.get(key));
    this.#timers.set(
      key,
      setTimeout(() => {
        this.#timers.delete(key);
        run();
      }, DEBOUNCE_MS),
    );
  }
}
