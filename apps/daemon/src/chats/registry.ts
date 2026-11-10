// The live chats of the daemon: one handle for each chat, loaded on first use,
// which holds the one open log of the chat, the fold of that log, and the hold
// that a long-poll read of the log waits on. A chat is a chat of a task, or a
// chat of a project with no task and no step.
//
// Every write and every load of a chat of a task runs in the turns of its
// project tag and of its task in the daemon's one write queue. Every write and
// every load of a chat of a project runs in the turn of its tag alone. A rename
// or a delete of the project and a delete of the task take one of these turns
// too, so none of them runs in the middle of a chat write or a chat load, and
// each calls its hook here inside its own turn.

import {
  chatFinding,
  chatPath,
  createChat,
  createProjectChat as createProjectChatRecord,
  listChats,
  openChatLog,
  openProjectChatLog,
  readChat,
  readProjectChat,
  TaskStoreError,
  updateChat,
  updateProjectChat,
} from "@tasma/engine";
import type {
  ChatChange,
  ChatInput,
  ChatLog,
  ChatLogEntry,
  ChatRecord,
  ProjectChatInput,
  ProjectChatLog,
  ProjectChatRecord,
  ProjectOptions,
  TaskStoreErrorCode,
} from "@tasma/engine";
import { CHAT_START, chatBusy, DAEMON_NAME, foldChat, printable } from "@tasma/protocol";
import type {
  AcpObject,
  Chat,
  ChatEntry,
  ChatEvent,
  ChatFold,
  ChatStatus,
  Diagnostic,
  FeedEvent,
  ProjectChat,
} from "@tasma/protocol";
import type { Publish } from "../events/feed.js";
import { createHold, HOLD_MS } from "../events/hold.js";
import type { Hold } from "../events/hold.js";
import { causeOf } from "../http/failure.js";
import type { ProjectHost } from "../projects/host.js";
import { taskKey } from "../tasks/serialize.js";
import type { WriteQueue } from "../tasks/serialize.js";

export type RequestKind = "permission" | "question";

/** The outcome of a permission request and the answer to a question that nobody gives. */
export const CANCELLED = {
  permission: { outcome: "cancelled" },
  question: { action: "cancel" },
} as const satisfies Record<RequestKind, AcpObject>;

/** A resolution with no `client` is one of the daemon. */
export function resolution(kind: RequestKind, request: string, result: AcpObject, client?: string): ChatEvent {
  const by = client === undefined ? {} : { client };
  return kind === "permission"
    ? { kind: "permission-resolved", request, outcome: result, ...by }
    : { kind: "question-resolved", request, answer: result, ...by };
}

function faultText(name: string, error: unknown): string {
  return `${DAEMON_NAME}: ${printable(`${name}: ${causeOf(error)}`)}\n`;
}

/** The line on the error output for a fault of a chat of a task. */
export function faultLine(chat: { task: string; chat: number }, error: unknown): string {
  return faultText(`chat ${chat.chat} of ${chat.task}`, error);
}

/**
 * One chat as the daemon holds it. The handle stays the same object through a
 * rename of its project, and refuses with `chat-not-found` after a delete of its
 * project or its task, and once a write finds its chat gone.
 */
export type LiveChat<C extends Chat | ProjectChat = Chat> = {
  /** The tag of the project of the chat; a rename of the project changes it. */
  readonly tag: string;
  readonly chat: C;
  readonly fold: ChatFold;
  /** What the open of the log found; an append adds nothing to it. */
  readonly diagnostics: Diagnostic[];
  /** Whether the log holds an answer of the agent. */
  readonly answered: boolean;
  /**
   * The texts of the `user` events after the last answer of the agent, in log
   * order. Once the chat has an answer, a cancelled turn end clears them too.
   */
  readonly unanswered: readonly string[];
  /** Calls on one handle write in call order. */
  append(event: ChatEvent): Promise<ChatEntry>;
  /**
   * When the fold has a turn, a job, an own turn or an open request, writes a
   * cancelled resolution of the daemon for each open request, and then
   * `interrupted`. It reads the fold in its turn of the write order, so it sees
   * every write called before it.
   */
  interrupt(): Promise<void>;
  setSession(session: string): Promise<void>;
  /** Replaces the picks of the chat. Writes in call order with `setSession`, and each keeps the field of the other. */
  setOptions(options: Record<string, string>): Promise<void>;
  /**
   * Moves `seen` forward to `seq`, at most to the last `seq` of the log, and
   * publishes the feed event of the chat when it moves. Writes in call order
   * with the other writes of the chat.
   */
  setSeen(seq: number): Promise<void>;
  /** Resolves when every write called on the handle before it has ended, whether it failed or not. */
  written(): Promise<void>;
  /** Takes no turn, so a read never waits for a write. */
  read(after: number, maxBytes?: number): Promise<ChatEntry[]>;
  /**
   * Resolves after the next entry, at a rename of the project, or at the end of
   * the hold; at once for a chat that is gone and after the registry closes.
   */
  wait(): Promise<void>;
};

/** The handle of a chat of either kind. `isProjectChat` narrows it in both branches. */
export type AnyLiveChat = LiveChat | LiveChat<ProjectChat>;

/** Whether the handle is of a project chat. */
export function isProjectChat(live: LiveChat<Chat | ProjectChat>): live is LiveChat<ProjectChat> {
  return !("task" in live.chat);
}

/** `chat N of TASK` for a task chat, `chat N of project TAG` for a project chat, with the current tag. */
export function chatName(live: LiveChat<Chat | ProjectChat>): string {
  const { chat } = live;
  return "task" in chat ? `chat ${chat.chat} of ${chat.task}` : `chat ${chat.chat} of project ${live.tag}`;
}

/** The line on the error output for a fault of the chat of the handle, with the name of `chatName`. */
export function chatFault(live: LiveChat<Chat | ProjectChat>, error: unknown): string {
  return faultText(chatName(live), error);
}

type Message = { text: string; client: string };

/**
 * The hooks run inside the turn of the route that calls them, after the engine
 * call, and take no turn themselves. No method that takes turns may be called
 * from inside a turn of the same keys: it would wait for a turn its caller holds.
 */
export type ChatRegistry = {
  /** Creates a chat together with its first message, so a new chat is `working` from its first `chat` event. */
  create(tag: string, task: string, input: ChatInput, message: Message): Promise<LiveChat>;
  get(tag: string, task: string, chat: number): Promise<LiveChat>;
  /** The chats of a task in number order. A chat that cannot be loaded is left out and reported. */
  list(tag: string, task: string): Promise<{ chats: LiveChat[]; diagnostics: Diagnostic[] }>;
  /** Creates a project chat with its first message, so the chat is `working` from its first `project-chat` event. */
  createProjectChat(tag: string, input: ProjectChatInput, message: Message): Promise<LiveChat<ProjectChat>>;
  getProjectChat(tag: string, chat: number): Promise<LiveChat<ProjectChat>>;
  /** The handle of a project chat that is already in memory. It takes no turn and does not read the disk. */
  loadedProjectChat(tag: string, chat: number): LiveChat<ProjectChat> | undefined;
  projectRenamed(from: string, to: string): void;
  projectRemoved(tag: string): void;
  taskRemoved(tag: string, task: string): void;
  /** Releases every wait, and makes each later wait resolve at once. */
  close(): void;
};

/** The types of one kind of chat: its record on disk, its chat as a handle gives it, and its log. */
type ChatKind = { record: ChatRecord | ProjectChatRecord; chat: Chat | ProjectChat; log: ChatLog | ProjectChatLog };

type TaskKind = { record: ChatRecord; chat: Chat; log: ChatLog };

type ProjectKind = { record: ProjectChatRecord; chat: ProjectChat; log: ProjectChatLog };

/** The parts of a handle that depend on the kind of its chat. */
type Place<K extends ChatKind> = {
  open(options: ProjectOptions, record: K["record"], onEntry: (entry: ChatLogEntry) => void): Promise<K["log"]>;
  write(options: ProjectOptions, record: K["record"], change: ChatChange): Promise<K["record"]>;
  view(record: K["record"], seq: number, stateSeq: number, status: ChatStatus): K["chat"];
  /** The key of the handle in the map of the loaded handles of its kind. */
  key(tag: string, record: K["record"]): string;
  turns(tag: string, record: K["record"]): string[];
  event(tag: string, record: K["record"], status: ChatStatus): FeedEvent;
  /** The record after `log` moved to a new tag. */
  relocated(record: K["record"], log: K["log"]): K["record"];
};

type Context<K extends ChatKind> = {
  root: string | undefined;
  holdMs: number;
  writes: WriteQueue;
  publish: Publish | undefined;
  place: Place<K>;
  /** Takes a handle out of the registry for good. */
  forget: (live: Live<K>) => void;
};

/**
 * The loaded handles of one kind, by the place each one stands for now. Only
 * `keep` adds one, always inside the turn of its tag. A load looks here first,
 * so two requests for one chat load it one time and a load that waited behind
 * a rename gives the moved handle.
 */
type Loaded<K extends ChatKind> = { context: Context<K>; handles: Map<string, Live<K>> };

/** The kind of each open request of a fold, in open order. */
type Asked = Map<string, RequestKind>;

type Answers = { answered: boolean; unanswered: string[] };

type Opened<L> = { log: L; fold: ChatFold; stateSeq: number; asked: Asked; answers: Answers };

/** The kinds of update that an agent sends only while it works on a prompt. */
const WORK_UPDATES: ReadonlySet<unknown> = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * An agent sends some updates when a session opens, before any prompt, and a
 * cancel before the first prompt writes a `cancelled` turn end, so neither is
 * an answer. The engine checks only that an event is an object.
 */
function isAnswer(event: ChatEvent): boolean {
  switch (event.kind) {
    case "turn-end":
      return event.stopReason !== "cancelled";
    case "permission":
    case "question":
      return true;
    case "update": {
      const update: unknown = event.update;
      return isRecord(update) && WORK_UPDATES.has(update.sessionUpdate);
    }
    default:
      return false;
  }
}

function trackAnswers(answers: Answers, event: ChatEvent): void {
  if (event.kind === "user") {
    const text: unknown = event.text;
    if (typeof text === "string") answers.unanswered.push(text);
  } else if (isAnswer(event)) {
    answers.answered = true;
    answers.unanswered = [];
  } else if (event.kind === "turn-end" && answers.answered) {
    // A cancel takes the texts of its turn back. A chat with no answer keeps
    // them: only such a chat gets a new session, which needs every text.
    answers.unanswered = [];
  }
}

/** The refusals that mean, inside the turns of a chat, that the chat is gone: no rename or delete runs then. */
const GONE: ReadonlySet<TaskStoreErrorCode> = new Set(["chat-not-found", "task-not-found", "project-not-found"]);

export function assertChatNumber(chat: number): void {
  if (!Number.isSafeInteger(chat) || chat < 1) throw new TaskStoreError("chat-not-found", "this is not a chat number");
}

function chatKey(tag: string, task: string, chat: number): string {
  return `${tag}\u0000${task}\u0000${chat}`;
}

function projectChatKey(tag: string, chat: number): string {
  return `${tag}\u0000${chat}`;
}

function turnsOf(tag: string, task: string): string[] {
  return [tag, taskKey(tag, task)];
}

const TASK_PLACE: Place<TaskKind> = {
  open: (options, record, onEntry) => openChatLog(options, record.task, record.chat, onEntry),
  write: (options, record, change) => updateChat(options, record.task, record.chat, change),
  view: (record, seq, stateSeq, status) => ({ ...record, seq, stateSeq, ...status }),
  key: (tag, record) => chatKey(tag, record.task, record.chat),
  turns: (tag, record) => turnsOf(tag, record.task),
  event: (tag, { task, chat, step }, status) => ({ kind: "chat", tag, task, chat, step, ...status }),
  relocated: (record, log) => ({ ...record, task: log.task }),
};

const PROJECT_PLACE: Place<ProjectKind> = {
  open: (options, record, onEntry) => openProjectChatLog(options, record.chat, onEntry),
  write: (options, record, change) => updateProjectChat(options, record.chat, change),
  view: (record, seq, stateSeq, status) => ({ ...record, seq, stateSeq, ...status }),
  key: (tag, record) => projectChatKey(tag, record.chat),
  turns: (tag) => [tag],
  event: (tag, { chat }, status) => ({ kind: "project-chat", tag, chat, ...status }),
  // The record of a project chat holds no tag.
  relocated: (record) => record,
};

function whereOf(status: ChatStatus): string | undefined {
  return status.state === "continued-outside" ? status.where : undefined;
}

function sameStatus(one: ChatStatus, other: ChatStatus): boolean {
  return one.state === other.state && whereOf(one) === whereOf(other);
}

/** Whether the entry of `event`, which folds `before` into `after`, moves the `stateSeq` of its chat. */
function movesStateSeq(before: ChatFold, after: ChatFold, event: ChatEvent): boolean {
  return event.kind === "permission" || event.kind === "question" || !sameStatus(before.status, after.status);
}

/** Keeps `asked` to the open requests of `fold`, the fold after `event`. */
function trackAsked(asked: Asked, fold: ChatFold, event: ChatEvent): void {
  if (event.kind === "permission" || event.kind === "question") asked.set(event.request, event.kind);
  for (const request of asked.keys()) {
    if (!fold.open.includes(request)) asked.delete(request);
  }
}

/** Opens the log of a chat and folds it in the same read. */
async function openFolded<K extends ChatKind>(
  context: Context<K>,
  tag: string,
  record: K["record"],
): Promise<Opened<K["log"]>> {
  let fold = CHAT_START;
  let stateSeq = 0;
  const asked: Asked = new Map();
  const answers: Answers = { answered: false, unanswered: [] };
  const log = await context.place.open({ project: tag, root: context.root }, record, (entry) => {
    const event = entry.event as ChatEvent;
    const next = foldChat(fold, event);
    if (movesStateSeq(fold, next, event)) stateSeq = entry.seq;
    fold = next;
    trackAsked(asked, fold, event);
    trackAnswers(answers, event);
  });
  return { log, fold, stateSeq, asked, answers };
}

class Live<K extends ChatKind> implements LiveChat<K["chat"]> {
  removed = false;
  readonly hold: Hold;
  readonly #context: Context<K>;
  #tag: string;
  #record: K["record"];
  #log: K["log"];
  #fold: ChatFold;
  #stateSeq: number;
  #asked: Asked;
  #answers: Answers;
  /** Set by a failed append that the engine did not refuse: its line can be on disk, which only a new open reads. */
  #stale = false;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(context: Context<K>, tag: string, record: K["record"], opened: Opened<K["log"]>) {
    this.#context = context;
    this.#tag = tag;
    this.#record = record;
    this.#log = opened.log;
    this.#fold = opened.fold;
    this.#stateSeq = opened.stateSeq;
    this.#asked = opened.asked;
    this.#answers = opened.answers;
    this.hold = createHold({ holdMs: context.holdMs });
  }

  get tag(): string {
    return this.#tag;
  }

  get key(): string {
    return this.#context.place.key(this.#tag, this.#record);
  }

  get chat(): K["chat"] {
    return this.#context.place.view(this.#record, this.#log.last, this.#stateSeq, this.#fold.status);
  }

  get fold(): ChatFold {
    return this.#fold;
  }

  get diagnostics(): Diagnostic[] {
    return this.#log.diagnostics;
  }

  get answered(): boolean {
    return this.#answers.answered;
  }

  get unanswered(): readonly string[] {
    return this.#answers.unanswered;
  }

  append(event: ChatEvent): Promise<ChatEntry> {
    return this.#queued(() => this.appendInHeldTurns(event));
  }

  interrupt(): Promise<void> {
    return this.#queued(() => this.interruptInHeldTurns());
  }

  setSession(session: string): Promise<void> {
    return this.#update({ session });
  }

  setOptions(options: Record<string, string>): Promise<void> {
    return this.#update({ options });
  }

  setSeen(seq: number): Promise<void> {
    return this.#queued(async () => {
      this.#assertPresent();
      // The clamp needs the true last seq, which only a new open of a stale log reads.
      if (this.#stale) await this.#reopen();
      const seen = Math.min(seq, this.#log.last);
      if (seen <= (this.#record.seen ?? 0)) return;
      await this.#writeRecord({ seen });
      this.#publish();
    });
  }

  async written(): Promise<void> {
    await this.#writes;
  }

  async read(after: number, maxBytes?: number): Promise<ChatEntry[]> {
    this.#assertPresent();
    return (await this.#log.read(after, { maxBytes })) as ChatEntry[];
  }

  wait(): Promise<void> {
    return this.hold.wait();
  }

  /**
   * Writes one event; the caller holds the turns of the handle. The line is on
   * disk before the fold changes, so a failed write changes nothing.
   */
  async appendInHeldTurns(event: ChatEvent): Promise<ChatEntry> {
    this.#assertPresent();
    if (this.#stale) await this.#reopen();
    // A log that lost lines, by a hand edit or a crash, gives its next entries the seq of entries the user saw.
    if ((this.#record.seen ?? 0) > this.#log.last) await this.#writeRecord({ seen: this.#log.last });
    const before = this.#stateSeq;
    const next = foldChat(this.#fold, event);
    let entry;
    try {
      entry = await this.#log.append(event);
    } catch (error) {
      // A refusal of the engine leaves its log as it was.
      if (!(error instanceof TaskStoreError)) this.#stale = true;
      throw error;
    }
    if (movesStateSeq(this.#fold, next, event)) this.#stateSeq = entry.seq;
    this.#fold = next;
    trackAsked(this.#asked, next, event);
    trackAnswers(this.#answers, event);
    this.#announce(before);
    this.hold.notify();
    return entry as ChatEntry;
  }

  /** As `interrupt`; the caller holds the turns of the handle. */
  async interruptInHeldTurns(): Promise<void> {
    if (this.#stale) await this.#reopen();
    if (!chatBusy(this.#fold)) return;
    for (const [request, kind] of [...this.#asked]) {
      await this.appendInHeldTurns(resolution(kind, request, CANCELLED[kind]));
    }
    await this.appendInHeldTurns({ kind: "interrupted" });
  }

  /**
   * After a failed first append, in the same turns: opens the log again, which
   * publishes the status it finds, and gives whether the line reached the log.
   */
  async reopenAfterFailedAppend(): Promise<boolean> {
    if (!this.#stale) return false;
    try {
      await this.#reopen();
    } catch {
      return false;
    }
    return this.#log.last > 0;
  }

  /** Points the handle at the same chat under a new tag of its project. */
  relocate(tag: string): void {
    this.#log.relocate(tag);
    this.#tag = tag;
    this.#record = this.#context.place.relocated(this.#record, this.#log);
  }

  #update(change: ChatChange): Promise<void> {
    return this.#queued(async () => {
      this.#assertPresent();
      await this.#writeRecord(change);
    });
  }

  async #writeRecord(change: ChatChange): Promise<void> {
    const { place, root } = this.#context;
    this.#record = await place.write({ project: this.#tag, root }, this.#record, change);
  }

  /**
   * Chained, so a write asks for its turns only after the write before it ended.
   * The queue alone does not keep call order once a rename makes a waiting write
   * ask for its turns again.
   */
  #queued<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(() => this.#inTurns(work));
    this.#writes = run.catch(() => undefined);
    return run;
  }

  /**
   * Runs `work` in the turns of the place the handle stands for. A wait behind
   * a rename ends with the turns of the old tag, so the turns are then taken
   * again for the new one.
   */
  async #inTurns<T>(work: () => Promise<T>): Promise<T> {
    for (;;) {
      const tag = this.#tag;
      const done = await this.#context.writes.runAll(this.#context.place.turns(tag, this.#record), async () =>
        tag === this.#tag ? { value: await this.#forgetIfGone(work) } : undefined);
      if (done !== undefined) return done.value;
    }
  }

  async #forgetIfGone<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TaskStoreError && GONE.has(error.code)) this.#context.forget(this);
      throw error;
    }
  }

  /**
   * A new open reads what a failed append left on disk, and publishes the feed
   * event of the chat when it finds `stateSeq` changed.
   */
  async #reopen(): Promise<void> {
    const before = this.#stateSeq;
    const last = this.#log.last;
    const opened = await openFolded(this.#context, this.#tag, this.#record);
    this.#log = opened.log;
    this.#fold = opened.fold;
    this.#stateSeq = opened.stateSeq;
    this.#asked = opened.asked;
    this.#answers = opened.answers;
    this.#stale = false;
    this.#announce(before);
    if (this.#log.last !== last) this.hold.notify();
  }

  /**
   * Publishes the feed event of the chat when `stateSeq` is not `before`. A log
   * can become shorter, so a lower one counts.
   */
  #announce(before: number): void {
    if (this.#stateSeq !== before) this.#publish();
  }

  #publish(): void {
    this.#context.publish?.(this.#context.place.event(this.#tag, this.#record, this.#fold.status));
  }

  #assertPresent(): void {
    if (this.removed) throw new TaskStoreError("chat-not-found", "this chat is no longer here");
  }
}

export function createChatRegistry(options: {
  root?: string;
  host: ProjectHost;
  writes: WriteQueue;
  /**
   * Receives the `chat` event of a task chat or the `project-chat` event of a
   * project chat at its create, at each change of its status, at each new
   * permission request or question, and when its `seen` moves forward.
   */
  publish?: Publish;
  holdMs?: number;
  /** Where a fault of the recovery of a chat is reported. */
  stderr?: { write(text: string): unknown };
}): ChatRegistry {
  const { root, host, writes, publish } = options;
  const holdMs = options.holdMs ?? HOLD_MS;
  const stderr = options.stderr ?? process.stderr;
  let closed = false;

  function loadedOf<K extends ChatKind>(place: Place<K>): Loaded<K> {
    const handles = new Map<string, Live<K>>();
    const forget = (live: Live<K>): void => {
      live.removed = true;
      live.hold.close();
      if (handles.get(live.key) === live) handles.delete(live.key);
    };
    return { context: { root, holdMs, writes, publish, place, forget }, handles };
  }

  const tasks = loadedOf(TASK_PLACE);
  const projects = loadedOf(PROJECT_PLACE);

  /** Puts a handle in its map. A handle it takes the place of stands for a chat that is gone. */
  function keep<K extends ChatKind>({ context, handles }: Loaded<K>, live: Live<K>): void {
    const replaced = handles.get(live.key);
    if (replaced !== undefined) context.forget(replaced);
    if (closed) live.hold.close();
    handles.set(live.key, live);
  }

  async function load<K extends ChatKind>(loaded: Loaded<K>, tag: string, record: K["record"]): Promise<Live<K>> {
    const { context, handles } = loaded;
    const present = handles.get(context.place.key(tag, record));
    if (present !== undefined) return present;
    const live = new Live(context, tag, record, await openFolded(context, tag, record));
    await recover(live);
    keep(loaded, live);
    return live;
  }

  /** The handle of a chat just created, with its first message; the caller holds the turns of the chat. */
  async function created<K extends ChatKind>(
    loaded: Loaded<K>,
    tag: string,
    record: K["record"],
    message: Message,
  ): Promise<Live<K>> {
    const live = new Live(loaded.context, tag, record, await openFolded(loaded.context, tag, record));
    try {
      await live.appendInHeldTurns({ kind: "user", text: message.text, client: message.client });
    } catch (error) {
      if (!await live.reopenAfterFailedAppend()) throw error;
    }
    keep(loaded, live);
    return live;
  }

  /**
   * A chat loaded from disk has no agent process in this daemon: the runner
   * runs only the chats it created or got from here. So a turn, a job or a
   * request that its log leaves open ended with an earlier daemon.
   */
  async function recover<K extends ChatKind>(live: Live<K>): Promise<void> {
    try {
      await live.interruptInHeldTurns();
    } catch (error) {
      stderr.write(chatFault(live, error));
    }
  }

  function relocateAll<K extends ChatKind>(loaded: Loaded<K>, from: string, to: string): void {
    for (const [key, live] of [...loaded.handles]) {
      if (live.tag !== from) continue;
      loaded.handles.delete(key);
      live.relocate(to);
      keep(loaded, live);
      // A wait under the old tag reads again, and finds no project of that tag.
      live.hold.notify();
    }
  }

  function forgetWhere<K extends ChatKind>({ context, handles }: Loaded<K>, test: (live: Live<K>) => boolean): void {
    for (const live of [...handles.values()]) {
      if (test(live)) context.forget(live);
    }
  }

  return {
    async create(tag, task, input, message) {
      await host.open(tag);
      return writes.runAll(turnsOf(tag, task), async () =>
        created(tasks, tag, await createChat({ project: tag, root }, task, input), message));
    },

    async get(tag, task, chat) {
      await host.open(tag);
      // A malformed chat number gives chat-not-found also for a missing task; the engine checks the task first.
      assertChatNumber(chat);
      const key = chatKey(tag, task, chat);
      return tasks.handles.get(key)
        ?? writes.runAll(turnsOf(tag, task), async () =>
          tasks.handles.get(key) ?? load(tasks, tag, await readChat({ project: tag, root }, task, chat)));
    },

    async list(tag, task) {
      await host.open(tag);
      return writes.runAll(turnsOf(tag, task), async () => {
        const listed = await listChats({ project: tag, root }, task);
        const chats: LiveChat[] = [];
        const diagnostics = [...listed.diagnostics];
        for (const record of listed.chats) {
          try {
            const live = await load(tasks, tag, record);
            chats.push(live);
            diagnostics.push(...live.diagnostics);
          } catch (error) {
            diagnostics.push(chatFinding(error, chatPath({ project: tag, root }, record.task, record.chat)));
          }
        }
        return { chats, diagnostics };
      });
    },

    async createProjectChat(tag, input, message) {
      await host.open(tag);
      return writes.runAll([tag], async () =>
        created(projects, tag, await createProjectChatRecord({ project: tag, root }, input), message));
    },

    async getProjectChat(tag, chat) {
      await host.open(tag);
      assertChatNumber(chat);
      const key = projectChatKey(tag, chat);
      return projects.handles.get(key)
        ?? writes.runAll([tag], async () =>
          projects.handles.get(key) ?? load(projects, tag, await readProjectChat({ project: tag, root }, chat)));
    },

    loadedProjectChat(tag, chat) {
      return projects.handles.get(projectChatKey(tag, chat));
    },

    projectRenamed(from, to) {
      relocateAll(tasks, from, to);
      relocateAll(projects, from, to);
    },

    projectRemoved(tag) {
      forgetWhere(tasks, (live) => live.tag === tag);
      forgetWhere(projects, (live) => live.tag === tag);
    },

    taskRemoved(tag, task) {
      forgetWhere(tasks, (live) => live.tag === tag && live.chat.task === task);
    },

    close() {
      closed = true;
      for (const live of [...tasks.handles.values(), ...projects.handles.values()]) live.hold.close();
    },
  };
}
