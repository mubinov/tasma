import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../format/values.js";
import { appendLine, type FileNode, nodeOf, openRegularEntry, sameNode } from "./atomic.js";
import { assertChatDirectory, chatDirectory, chatPath, LOG_FILE, openTaskChats, readRecord } from "./chat.js";
import { fail } from "./errors.js";
import { openProjectChats, projectChatPath, projectInputFault } from "./project-chat.js";
import { now } from "./store.js";
import type { ProjectOptions, StoreDiagnostic } from "./types.js";

/** What one entry records. The engine does not read it. */
type ChatEvent = Readonly<Record<string, unknown>>;

/** One event of a chat. */
export type ChatLogEntry = { seq: number; at: string; event: ChatEvent };

/**
 * The append-only event log of one chat. One process holds one `ChatLog` for
 * each chat: two of one chat would issue one `seq` two times.
 */
export type ChatLog = {
  readonly task: string;
  readonly chat: number;
  /** The `seq` of the last valid entry, 0 for an empty log. */
  readonly last: number;
  /** The findings of the read at open. */
  readonly diagnostics: StoreDiagnostic[];
  /** Calls on one log write in call order. */
  append(event: ChatEvent): Promise<ChatLogEntry>;
  /**
   * The entries with a `seq` above `after`, in order, up to `maxBytes` of lines
   * (1 MiB by default) and never fewer than one where one exists.
   */
  read(after: number, options?: { maxBytes?: number }): Promise<ChatLogEntry[]>;
  /** Points the log at the same chat in a renamed project. */
  relocate(project: string): void;
};

/** The event log of one chat of a project that belongs to no task. */
export type ProjectChatLog = Omit<ChatLog, "task">;

const CHUNK = 64 * 1024;

const DEFAULT_MAX_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

const NOT_ONE_FILE = "the event log of this chat is not a regular file with one name";

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The entry one line holds, or `undefined` for a line that holds none. `after` is the `seq` before it. */
function entryOf(bytes: Uint8Array, after: number): ChatLogEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { seq, at, event } = value;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= after) return undefined;
  if (typeof at !== "string" || !isRecord(event)) return undefined;
  return { seq, at, event };
}

/**
 * Where the valid entries of a log stand. The entries themselves are not kept:
 * a read takes their bytes again.
 */
type Ranges = { seqs: number[]; starts: number[]; ends: number[] };

type Scanned = Ranges & { diagnostics: StoreDiagnostic[]; unterminated: boolean };

/**
 * Reads the whole log once and splits it at each newline byte, decoding each
 * line on its own: a character a torn line cuts then moves no offset of the
 * lines after it. It reads with `handle.read` rather than a stream, which Bun
 * reads differently.
 */
async function scanLog(handle: FileHandle, path: string, onEntry?: (entry: ChatLogEntry) => void): Promise<Scanned> {
  const scanned: Scanned = { seqs: [], starts: [], ends: [], diagnostics: [], unterminated: false };
  const buffer = Buffer.alloc(CHUNK);
  let parts: Uint8Array[] = [];
  let start = 0;
  let offset = 0;
  let line = 0;
  const take = (terminated: boolean): void => {
    line += 1;
    const bytes = Buffer.concat(parts);
    parts = [];
    const entry = entryOf(bytes, scanned.seqs.at(-1) ?? 0);
    if (entry === undefined) {
      const message = terminated
        ? "this line holds no entry of the event log, so it was passed over"
        : "this line has no end and holds no entry, so an append did not finish";
      scanned.diagnostics.push({ code: "chat-file-unreadable", message, path, line });
      return;
    }
    scanned.seqs.push(entry.seq);
    scanned.starts.push(start);
    scanned.ends.push(start + bytes.length);
    onEntry?.(entry);
  };
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, CHUNK, offset);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    let from = 0;
    for (let at = chunk.indexOf(NEWLINE); at !== -1; at = chunk.indexOf(NEWLINE, from)) {
      parts.push(chunk.subarray(from, at));
      take(true);
      start = offset + at + 1;
      from = at + 1;
    }
    // A copy, because the next read reuses the buffer.
    if (from < bytesRead) parts.push(Buffer.from(chunk.subarray(from)));
    offset += bytesRead;
  }
  if (offset > start) {
    take(false);
    scanned.unterminated = true;
  }
  return scanned;
}

/** The bytes of a file from `start` to `end`, fewer where the file is shorter. */
async function readRange(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(end - start);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** The index of the first `seq` above `after`, or the length where there is none. */
function firstAfter(seqs: readonly number[], after: number): number {
  let low = 0;
  let high = seqs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (seqs[middle]! > after) high = middle;
    else low = middle + 1;
  }
  return low;
}

type LogFile = { path: string; node: FileNode };

class EventLog implements ProjectChatLog {
  readonly chat: number;
  readonly diagnostics: StoreDiagnostic[];
  readonly #pathIn: (project: string) => string;
  readonly #node: FileNode;
  readonly #ranges: Ranges;
  #path: string;
  #unterminated: boolean;
  #broken = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(chat: number, pathIn: (project: string) => string, file: LogFile, scanned: Scanned) {
    this.chat = chat;
    this.diagnostics = scanned.diagnostics;
    this.#pathIn = pathIn;
    this.#node = file.node;
    this.#ranges = { seqs: scanned.seqs, starts: scanned.starts, ends: scanned.ends };
    this.#path = file.path;
    this.#unterminated = scanned.unterminated;
  }

  get last(): number {
    return this.#ranges.seqs.at(-1) ?? 0;
  }

  append(event: ChatEvent): Promise<ChatLogEntry> {
    const run = this.#queue.then(() => this.#append(event));
    // A failed append decides nothing about the one behind it, which runs its own checks.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #append(event: ChatEvent): Promise<ChatLogEntry> {
    if (this.#broken) fail("chat-unreadable", "a write of this log failed; open it again", this.#path);
    const line = JSON.stringify({ seq: this.last + 1, at: now(), event });
    // The entry as a later read gives it, which is what was written.
    const entry = JSON.parse(line) as ChatLogEntry;
    if (!isRecord(entry.event)) fail("field-required", "an event must be written as a JSON object");
    let written;
    try {
      written = await appendLine(this.#path, `${this.#unterminated ? "\n" : ""}${line}\n`, this.#node);
    } catch (error) {
      // The file can hold a part of the line, or all of it unflushed, and only
      // a new open reads what is there.
      this.#broken = true;
      throw error;
    }
    if (written === "absent" || written === "replaced") fail("chat-not-found", "this chat is no longer here", this.#path);
    if (written === "irregular") fail("chat-unreadable", NOT_ONE_FILE, this.#path);
    const length = Buffer.byteLength(line);
    const start = written.end - 1 - length;
    this.#ranges.seqs.push(entry.seq);
    this.#ranges.starts.push(start);
    this.#ranges.ends.push(start + length);
    this.#unterminated = false;
    return entry;
  }

  async read(after: number, options: { maxBytes?: number } = {}): Promise<ChatLogEntry[]> {
    const { seqs, starts, ends } = this.#ranges;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const firstIndex = firstAfter(seqs, after);
    if (firstIndex === seqs.length) return [];
    let lastIndex = firstIndex;
    let total = ends[firstIndex]! - starts[firstIndex]!;
    while (lastIndex + 1 < seqs.length) {
      const size = ends[lastIndex + 1]! - starts[lastIndex + 1]!;
      if (total + size > maxBytes) break;
      total += size;
      lastIndex += 1;
    }
    const handle = await this.#openLog();
    try {
      const entries: ChatLogEntry[] = [];
      let runFirst = firstIndex;
      while (runFirst <= lastIndex) {
        // Adjacent lines are read together, and the bytes of a line passed over are never read.
        let runLast = runFirst;
        while (runLast < lastIndex && starts[runLast + 1] === ends[runLast]! + 1) runLast += 1;
        await this.#readRun(handle, runFirst, runLast, entries);
        runFirst = runLast + 1;
      }
      return entries;
    } finally {
      await handle.close();
    }
  }

  /** Adds to `entries` the kept entries from `firstIndex` to `lastIndex`, which stand on adjacent lines. */
  async #readRun(handle: FileHandle, firstIndex: number, lastIndex: number, entries: ChatLogEntry[]): Promise<void> {
    const { seqs, starts, ends } = this.#ranges;
    const base = starts[firstIndex]!;
    const bytes = await readRange(handle, base, ends[lastIndex]!);
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const seq = seqs[index]!;
      const entry = entryOf(bytes.subarray(starts[index]! - base, ends[index]! - base), seq - 1);
      if (entry?.seq !== seq) fail("chat-unreadable", "the event log changed under this chat; open it again", this.#path);
      entries.push(entry);
    }
  }

  /** A handle on the file this log opened, which the caller closes. */
  async #openLog(): Promise<FileHandle> {
    const opened = await openRegularEntry(this.#path);
    if (opened === "absent") fail("chat-not-found", "this chat is no longer here", this.#path);
    if (opened === "irregular") fail("chat-unreadable", "the event log of this chat is not a regular file", this.#path);
    if (!sameNode(nodeOf(opened.entry), this.#node)) {
      await opened.handle.close();
      fail("chat-not-found", "this chat is no longer here", this.#path);
    }
    return opened.handle;
  }

  relocate(project: string): void {
    this.#path = this.#pathIn(project);
  }
}

class TaskEventLog extends EventLog implements ChatLog {
  readonly #digits: string;
  #task: string;

  constructor(root: string, task: string, chat: number, file: LogFile, scanned: Scanned) {
    const digits = task.slice(task.indexOf("-") + 1);
    const pathIn = (project: string): string => join(chatPath({ project, root }, `${project}-${digits}`, chat), LOG_FILE);
    super(chat, pathIn, file, scanned);
    this.#digits = digits;
    this.#task = task;
  }

  get task(): string {
    return this.#task;
  }

  override relocate(project: string): void {
    super.relocate(project);
    this.#task = `${project}-${this.#digits}`;
  }
}

/** The log of the chat in `directory`, open for `use`. `size` is the size of the log at the open. */
async function withLog<T>(
  directory: string,
  use: (handle: FileHandle, file: LogFile, size: number) => Promise<T>,
): Promise<T> {
  const path = join(directory, LOG_FILE);
  const opened = await openRegularEntry(path);
  if (opened === "absent") fail("chat-unreadable", "this chat has a record but no event log", path);
  if (opened === "irregular") fail("chat-unreadable", NOT_ONE_FILE, path);
  try {
    // `appendLine` refuses a file with a second name, so no open takes one as the log of this chat.
    if (opened.entry.nlink !== 1) fail("chat-unreadable", NOT_ONE_FILE, path);
    return await use(opened.handle, { path, node: nodeOf(opened.entry) }, opened.entry.size);
  } finally {
    await opened.handle.close();
  }
}

/** Opens and reads the log of the chat in `directory`, as `openChatLog` states. */
function loadLog<T>(
  directory: string,
  onEntry: ((entry: ChatLogEntry) => void) | undefined,
  build: (file: LogFile, scanned: Scanned) => T,
): Promise<T> {
  return withLog(directory, async (handle, file) => build(file, await scanLog(handle, file.path, onEntry)));
}

/**
 * The entry of the last line of the first `size` bytes that holds one. It reads
 * backward in blocks and stops at that line.
 */
async function lastEntry(handle: FileHandle, path: string, size: number): Promise<ChatLogEntry | undefined> {
  // The end of a line whose start is in a block not read yet.
  let parts: Uint8Array[] = [];
  for (let end = size; end > 0;) {
    const start = Math.max(0, end - CHUNK);
    const block = await readRange(handle, start, end);
    if (block.length < end - start) fail("chat-unreadable", "the event log changed under this chat; open it again", path);
    let to = block.length;
    for (;;) {
      const at = to === 0 ? -1 : block.lastIndexOf(NEWLINE, to - 1);
      if (at === -1) break;
      const entry = entryOf(Buffer.concat([block.subarray(at + 1, to), ...parts]), 0);
      if (entry !== undefined) return entry;
      parts = [];
      to = at;
    }
    parts.unshift(block.subarray(0, to));
    end = start;
  }
  return entryOf(Buffer.concat(parts), 0);
}

/**
 * Opens the event log of one chat and reads it once, calling `onEntry` for each
 * valid entry in order. An invalid line is passed over and reported; no byte of
 * the log is ever deleted.
 */
export async function openChatLog(
  options: ProjectOptions,
  task: string,
  chat: number,
  onEntry?: (entry: ChatLogEntry) => void,
): Promise<ChatLog> {
  const { paths, taskChats } = await openTaskChats(options, task);
  const directory = chatDirectory(taskChats, chat);
  await readRecord(directory);
  return loadLog(directory, onEntry, (file, scanned) => new TaskEventLog(paths.root, task, chat, file, scanned));
}

/** The same, for one chat of a project that belongs to no task. */
export async function openProjectChatLog(
  options: ProjectOptions,
  chat: number,
  onEntry?: (entry: ChatLogEntry) => void,
): Promise<ProjectChatLog> {
  const { paths, projectChats } = await openProjectChats(options);
  const directory = chatDirectory(projectChats, chat);
  await readRecord(directory, projectInputFault);
  const pathIn = (project: string): string => join(projectChatPath({ project, root: paths.root }, chat), LOG_FILE);
  return loadLog(directory, onEntry, (file, scanned) => new EventLog(chat, pathIn, file, scanned));
}

/**
 * The last valid entry of the log of one project chat, or `undefined` for a log
 * with none. It makes the checks of `openProjectChatLog` but does not read the
 * record, and passes over a line that holds no entry without a finding.
 */
export async function readLastProjectChatEntry(
  options: ProjectOptions,
  chat: number,
): Promise<ChatLogEntry | undefined> {
  const { projectChats } = await openProjectChats(options);
  const directory = chatDirectory(projectChats, chat);
  await assertChatDirectory(directory);
  return withLog(directory, (handle, file, size) => lastEntry(handle, file.path, size));
}
