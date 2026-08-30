import type { Stats } from "node:fs";
import { type Frontmatter, parseFrontmatter, TaskFormatError } from "../format/index.js";
import { isPlainMapping } from "../format/values.js";
import { entryAt } from "../store/atomic.js";
import { causeOf } from "../store/errors.js";
import type { ProjectPaths, StoreDiagnostic } from "../store/index.js";
import { type ScanDiagnostic, scanTasks, type TaskEntry, taskNumber } from "../store/paths.js";
import { openProjectDirectory } from "../store/store.js";
import { type ChunkSource, openTaskFile, readFrontmatterText } from "./frontmatter.js";
import { REASON_LIMIT, short } from "./message.js";
import { Gate, PathQueue } from "./queue.js";
import type { ExcludedFile, ExclusionCode, IndexEntry, QueryResult } from "./types.js";

/** What one file turned out to be: an entry, a file that holds none, or nothing at all. */
type Loaded = { entry: IndexEntry } | { excluded: Exclusion } | "gone";

/** An exclusion as the index builds it: the `line` reaches the listener alone. */
type Exclusion = { code: ExclusionCode; message: string; line?: number };

/**
 * Why the index may answer for no task of this project: the project directory
 * itself can no longer be read, or it holds no tasks directory. The two are one
 * fact for a caller and two states for the index, which reports a change from
 * either to the other.
 */
type Lost = { cause: "project" | "tasks"; message: string; path: string };

/**
 * What the project holds now: the tasks directory the index answers for, under
 * an identity that changes when another directory takes its name, or why the
 * index answers for no task of it.
 */
type Holding = { identity: string } | { lost: Lost };

/**
 * How one task file is opened. It is a parameter so that a test can hold a read
 * open and decide what happens to the project while it stands there.
 */
export type OpenTaskFile = (path: string) => Promise<ChunkSource | "absent" | "irregular">;

/**
 * How many task files the index reads at one time, and how many applies a scan a
 * caller waits on holds in flight.
 */
const READ_LIMIT = 8;

/**
 * Freezes a value and everything a caller can reach through it, so a result the
 * index handed out cannot change what the index holds.
 */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) for (const item of value) deepFreeze(item);
  else if (isPlainMapping(value)) for (const item of Object.values(value)) deepFreeze(item);
  else return value;
  return Object.freeze(value);
}

/**
 * The frontmatter of every task file of one project, and the files that failed
 * to become one.
 *
 * It has two writers — the calls a caller makes and the watcher — and no
 * reconciliation between them, because both reduce to one primitive: `apply`
 * reads a file and lands the map in the state that file dictates. Applying a
 * path twice reads it twice and lands in the same state, so re-application is
 * harmless and nothing has to be suppressed.
 */
export class TaskIndex {
  readonly #paths: ProjectPaths;
  readonly #onDiagnostic: ((diagnostic: StoreDiagnostic) => void) | undefined;
  readonly #entries = new Map<string, { file: TaskEntry; entry: IndexEntry }>();
  readonly #excluded = new Map<string, { file: TaskEntry; excluded: ExcludedFile }>();
  /** The directory-level findings of the last scan, which have no entry to compare against. */
  #lastScanFindings = new Map<string, string>();
  /**
   * Why the index holds no task of this project, or `undefined` while it holds
   * its own. It starts on an absent tasks directory, which is the empty project
   * the store creates one for on the first write: the state the index opens in
   * is not a loss it reports.
   */
  #lostCause: Lost["cause"] | undefined = "tasks";
  readonly #queue = new PathQueue();
  readonly #reads = new Gate(READ_LIMIT);
  readonly #open: OpenTaskFile;
  /**
   * How many files a scan a caller waits on applies at one time. It is a
   * parameter so that a test can set it under the read gate, which is what makes
   * the bound observable at all: the gate bounds the reads, so a scan that
   * applied every file of the project at once would still pass it.
   */
  readonly #readers: number;
  /** Whether the index still answers for its project: nothing it finds is reported once it does not. */
  #closed = false;

  constructor(
    paths: ProjectPaths,
    onDiagnostic?: (diagnostic: StoreDiagnostic) => void,
    open: OpenTaskFile = openTaskFile,
    readers: number = READ_LIMIT,
  ) {
    this.#paths = paths;
    this.#onDiagnostic = onDiagnostic;
    this.#open = open;
    this.#readers = readers;
  }

  query(): QueryResult {
    const entries = [...this.#entries.values()]
      .sort((a, b) => a.file.number - b.file.number)
      .map((held) => held.entry);
    const excluded = [...this.#excluded.values()]
      .map((held) => held.excluded)
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    return { entries, excluded };
  }

  /**
   * Reads one file and lands the map in the state it dictates. The work is
   * chained behind whatever else the path has in flight, so the last request is
   * the one that decides, and the whole of it — the project checks as well as
   * the read — runs under the gate. A burst of events names a different file
   * each time, so bounding the reads alone would still let one stat of the
   * project directory per file of the burst stand in flight at once.
   *
   * The project check brackets the read rather than preceding it. The open of a
   * task file guards its own name and no directory above it, and the read waits
   * on the gate before it starts, so a project directory a symbolic link
   * replaced while it waited would take it outside the tree the caller named.
   * What a read of a directory the index no longer answers for found is dropped
   * instead of recorded.
   *
   * **It answers for every fault it meets and raises none.** A fault of the
   * project checks is the project becoming unreadable, a fault of the open or
   * the parse is a file that holds no entry, and a listener that throws is
   * dropped — so a caller may await it in the same breath as the write it
   * converges without the read deciding how that write ended.
   */
  apply(file: TaskEntry): Promise<void> {
    return this.#queue.run(file.path, () =>
      this.#reads.run(async () => {
        const held = await this.#holds();
        if (held === undefined) return;
        const loaded = await this.#read(file);
        if ((await this.#holds()) !== held) return;
        this.#record(file, loaded);
      }),
    );
  }

  /**
   * Re-reads the directory and reconciles every entry against it. It is the one
   * recovery lever for a watch event the operating system dropped, and the way
   * the index is built at open.
   *
   * `awaited` states whether a caller is waiting for it, which decides how the
   * files are read: `rescan()` and the build are somebody's latency, while a
   * reconcile a watch started answers to nobody.
   */
  reconcile(awaited = true): Promise<void> {
    // Under the directory as its key, so two of them never read it at once,
    // while an apply, which is keyed by a file, still runs beside one.
    return this.#queue.run(this.#paths.tasks, () => this.#reconcile(awaited));
  }

  async #reconcile(awaited: boolean): Promise<void> {
    if ((await this.#holds()) === undefined) return;
    const scan = await scanTasks(this.#paths);
    this.#reportScan(scan.diagnostics);
    const files = new Map<string, TaskEntry>();
    for (const held of [...this.#entries.values(), ...this.#excluded.values()]) files.set(held.file.path, held.file);
    for (const file of scan.entries) files.set(file.path, file);
    // Nobody waits on a reconcile a watch started, so it takes one file at a
    // time and leaves the gate to the writes and the events that a caller does
    // wait on.
    if (!awaited) {
      for (const file of files.values()) await this.apply(file);
      return;
    }
    await this.#applyAll(files.values());
  }

  /**
   * Applies every file of a scan a caller waits on, as many at a time as the
   * index has readers. The workers share one iterator, so the number of applies
   * in flight is bounded by how many of them there are rather than by how many
   * files the project holds: a project of ten thousand tasks would otherwise
   * have ten thousand applies waiting on the gate before a read of one had even
   * returned.
   */
  async #applyAll(files: IterableIterator<TaskEntry>): Promise<void> {
    const workers = Array.from({ length: this.#readers }, async () => {
      for (const file of files) await this.apply(file);
    });
    // Every worker is waited on before a fault of one is raised, so a scan that
    // returns leaves no read of its own still running and no rejection for
    // nothing to handle.
    await Promise.allSettled(workers);
    await Promise.all(workers);
  }

  /**
   * The tasks directory the index may answer for, or `undefined` for a project
   * it holds no task of, which it drops what it held for. It is the check every
   * store call makes, re-run per read rather than at open alone: a project
   * directory replaced by a symbolic link afterwards would take every task file
   * outside the tree the caller named, and a stat of the tasks directory
   * resolves that link without ever seeing it.
   *
   * The identity it answers with names the directory itself, so two of them
   * compared across a read state whether the directory it read from is still the
   * one the name holds.
   */
  async #holds(): Promise<string | undefined> {
    const holding = await this.#holding();
    if ("identity" in holding) {
      this.#lostCause = undefined;
      return holding.identity;
    }
    this.#lose(holding.lost);
    return undefined;
  }

  /**
   * What the project holds now, read from the disk.
   *
   * Both stats stand under one catch, and the identity is taken from what the
   * second of them returned rather than from a third. Either of them can fail on
   * a project directory a concurrent change made unreadable — the very change
   * this check exists to notice — and the intent of the catch is that such a
   * project is a state the index reports and never a fault it raises.
   */
  async #holding(): Promise<Holding> {
    let entry: Stats | undefined;
    try {
      await openProjectDirectory(this.#paths);
      entry = await entryAt(this.#paths.tasks);
    } catch (error) {
      return {
        lost: {
          cause: "project",
          message: `this project can no longer be read, so the index holds no task of it: ${short(causeOf(error), REASON_LIMIT)}`,
          path: this.#paths.directory,
        },
      };
    }
    if (entry?.isDirectory() === true) return { identity: `${entry.dev}:${entry.ino}` };
    return {
      lost: {
        cause: "tasks",
        message: "the tasks directory of this project is gone, so the index holds no task of it",
        path: this.#paths.tasks,
      },
    };
  }

  /**
   * Stops the index from speaking for the project it was closed over. A watch
   * hands its work to no caller, so a timer that fired just before the close can
   * still be reading when it returns; this is the one point every finding passes
   * through, and it is where the listener stops hearing from an index the caller
   * has already torn down.
   */
  close(): void {
    this.#closed = true;
  }

  /** Hands a diagnostic to the listener, which is never allowed to fail the caller. */
  report(diagnostic: StoreDiagnostic): void {
    if (this.#closed) return;
    try {
      this.#onDiagnostic?.(diagnostic);
    } catch {
      // A listener that throws must corrupt neither the map nor the write that
      // led here.
    }
  }

  /**
   * Drops everything the index held for a project it can no longer answer for,
   * once per state it lands in: a project that stands lost for the reason it
   * already stood lost for has not just changed.
   */
  #lose(lost: Lost): void {
    if (this.#lostCause === lost.cause) return;
    this.#lostCause = lost.cause;
    this.#entries.clear();
    this.#excluded.clear();
    this.#lastScanFindings = new Map();
    this.report({ code: "tasks-directory-lost", message: lost.message, path: lost.path });
  }

  /** The frontmatter of one file, or the reason it holds no entry. */
  async #read(file: TaskEntry): Promise<Loaded> {
    let frontmatter: Frontmatter;
    try {
      const source = await this.#open(file.path);
      // A file deleted between the event and the read is a change like any
      // other, not an anomaly.
      if (source === "absent") return "gone";
      if (source === "irregular") {
        return { excluded: { code: "task-file-unreadable", message: "this name holds no regular file" } };
      }
      frontmatter = parseFrontmatter(await readFrontmatterText(source, file.path), { filename: file.path });
    } catch (error) {
      // A fault of the file, and a fault of the filesystem the open did not
      // answer for, both leave the engine unable to say what the file holds.
      const line = error instanceof TaskFormatError ? error.line : undefined;
      // The reason quotes what the file holds — a key of any length, in any
      // bytes — so it is cut the way a value the file supplied is.
      const message = `this file cannot be read: ${short(causeOf(error), REASON_LIMIT)}`;
      return { excluded: { code: "task-file-unreadable", message, line } };
    }
    const id = frontmatter.id;
    if (id === file.id) return { entry: deepFreeze({ id: file.id, path: file.path, frontmatter }) };
    if (taskNumber(this.#paths.project, `${id}.md`) === undefined) {
      return {
        excluded: {
          code: "task-file-foreign",
          message: `the id "${short(id)}" names no task of project ${this.#paths.project}, so this file holds no entry`,
        },
      };
    }
    return {
      excluded: {
        code: "task-file-misnamed",
        message: `this file carries the id "${short(id)}", which names another task of this project`,
      },
    };
  }

  /** Puts what one read found into the map, and reports a state that changed. */
  #record(file: TaskEntry, loaded: Loaded): void {
    const path = file.path;
    if (loaded === "gone") {
      this.#entries.delete(path);
      this.#excluded.delete(path);
      return;
    }
    if ("entry" in loaded) {
      this.#excluded.delete(path);
      this.#entries.set(path, { file, entry: loaded.entry });
      return;
    }
    const { code, message, line } = loaded.excluded;
    this.#entries.delete(path);
    // A file that stands broken for the reason it already stood broken for is
    // not reported again: a report states that the state has just changed.
    const known = this.#excluded.get(path)?.excluded.code === code;
    this.#excluded.set(path, { file, excluded: Object.freeze({ path, code, message }) });
    if (!known) this.report({ code, message, path, line });
  }

  /**
   * Reports a finding of the scan that names no task, once per scan that first
   * sees it.
   *
   * The path is the one the file stands under, both on the finding and as the
   * key that tells one file from another. A finding of the scan says nothing
   * beyond which directory entry it found, so a path cut to a length or stripped
   * of the characters a name may hold would name a file the caller cannot open
   * and would read as the same file as its neighbour. What a name holds is
   * bounded where a diagnostic is rendered, which is the rule every path the
   * store returns already stands under.
   */
  #reportScan(diagnostics: ScanDiagnostic[]): void {
    const seen = new Map<string, string>();
    for (const diagnostic of diagnostics) {
      seen.set(diagnostic.path, diagnostic.code);
      if (this.#lastScanFindings.get(diagnostic.path) !== diagnostic.code) this.report(diagnostic);
    }
    this.#lastScanFindings = seen;
  }
}
