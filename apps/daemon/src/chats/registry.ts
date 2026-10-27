// The live chats of the daemon: one handle for each chat, loaded on first use,
// which holds the one open log of the chat, the fold of that log, and the hold
// that a long-poll read of the log waits on.
//
// Every write and every load of a chat runs in the turns of its project tag and
// of its task in the daemon's one write queue. A rename or a delete of the
// project and a delete of the task take one of these turns too, so none of them
// runs in the middle of a chat write or a chat load, and each calls its hook
// here inside its own turn.

import {
  chatFinding,
  chatPath,
  createChat,
  listChats,
  openChatLog,
  readChat,
  TaskStoreError,
  updateChat,
} from "@tasma/engine";
import type { ChatChange, ChatInput, ChatLog, ChatRecord, TaskStoreErrorCode } from "@tasma/engine";
import { CHAT_START, DAEMON_NAME, foldChat, printable } from "@tasma/protocol";
import type { AcpObject, Chat, ChatEntry, ChatEvent, ChatFold, ChatStatus, Diagnostic } from "@tasma/protocol";
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

/** The line on the error output for a fault of a chat. */
export function faultLine(chat: { task: string; chat: number }, error: unknown): string {
  return `${DAEMON_NAME}: ${printable(`chat ${chat.chat} of ${chat.task}: ${causeOf(error)}`)}\n`;
}

/**
 * One chat as the daemon holds it. The handle stays the same object through a
 * rename of its project, and refuses with `chat-not-found` after a delete of its
 * project or its task, and once a write finds its chat gone.
 */
export type LiveChat = {
  /** The tag of the project of the chat; a rename of the project changes it. */
  readonly tag: string;
  readonly chat: Chat;
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
   * When the fold has a turn or an open request, writes a cancelled resolution
   * of the daemon for each open request, and then `interrupted`. It reads the
   * fold in its turn of the write order, so it sees every write called before it.
   */
  interrupt(): Promise<void>;
  setSession(session: string): Promise<void>;
  /** Replaces the picks of the chat. Writes in call order with `setSession`, and each keeps the field of the other. */
  setOptions(options: Record<string, string>): Promise<void>;
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

/**
 * The hooks run inside the turn of the route that calls them, after the engine
 * call, and take no turn themselves. No method that takes turns may be called
 * from inside a turn of the same keys: it would wait for a turn its caller holds.
 */
export type ChatRegistry = {
  /** Creates a chat together with its first message, so a new chat is `working` from its first `chat` event. */
  create(tag: string, task: string, input: ChatInput, message: { text: string; client: string }): Promise<LiveChat>;
  get(tag: string, task: string, chat: number): Promise<LiveChat>;
  /** The chats of a task in number order. A chat that cannot be loaded is left out and reported. */
  list(tag: string, task: string): Promise<{ chats: LiveChat[]; diagnostics: Diagnostic[] }>;
  projectRenamed(from: string, to: string): void;
  projectRemoved(tag: string): void;
  taskRemoved(tag: string, task: string): void;
  /** Releases every wait, and makes each later wait resolve at once. */
  close(): void;
};

type Context = {
  root: string | undefined;
  holdMs: number;
  writes: WriteQueue;
  publish: Publish | undefined;
  /** Takes a handle out of the registry for good. */
  forget: (live: Live) => void;
};

/** The kind of each open request of a fold, in open order. */
type Asked = Map<string, RequestKind>;

type Answers = { answered: boolean; unanswered: string[] };

type Opened = { log: ChatLog; fold: ChatFold; asked: Asked; answers: Answers };

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

function turnsOf(tag: string, task: string): string[] {
  return [tag, taskKey(tag, task)];
}

function whereOf(status: ChatStatus): string | undefined {
  return status.state === "continued-outside" ? status.where : undefined;
}

function sameStatus(one: ChatStatus, other: ChatStatus): boolean {
  return one.state === other.state && whereOf(one) === whereOf(other);
}

/** Keeps `asked` to the open requests of `fold`, the fold after `event`. */
function trackAsked(asked: Asked, fold: ChatFold, event: ChatEvent): void {
  if (event.kind === "permission" || event.kind === "question") asked.set(event.request, event.kind);
  for (const request of asked.keys()) {
    if (!fold.open.includes(request)) asked.delete(request);
  }
}

/** Opens the log of a chat and folds it in the same read. */
async function openFolded(root: string | undefined, tag: string, record: ChatRecord): Promise<Opened> {
  let fold = CHAT_START;
  const asked: Asked = new Map();
  const answers: Answers = { answered: false, unanswered: [] };
  const log = await openChatLog({ project: tag, root }, record.task, record.chat, (entry) => {
    const event = entry.event as ChatEvent;
    fold = foldChat(fold, event);
    trackAsked(asked, fold, event);
    trackAnswers(answers, event);
  });
  return { log, fold, asked, answers };
}

class Live implements LiveChat {
  removed = false;
  readonly hold: Hold;
  readonly #context: Context;
  #tag: string;
  #record: ChatRecord;
  #log: ChatLog;
  #fold: ChatFold;
  #asked: Asked;
  #answers: Answers;
  /** Set by a failed append that the engine did not refuse: its line can be on disk, which only a new open reads. */
  #stale = false;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(context: Context, tag: string, record: ChatRecord, opened: Opened) {
    this.#context = context;
    this.#tag = tag;
    this.#record = record;
    this.#log = opened.log;
    this.#fold = opened.fold;
    this.#asked = opened.asked;
    this.#answers = opened.answers;
    this.hold = createHold({ holdMs: context.holdMs });
  }

  get tag(): string {
    return this.#tag;
  }

  get key(): string {
    return chatKey(this.#tag, this.#record.task, this.#record.chat);
  }

  get chat(): Chat {
    return { ...this.#record, seq: this.#log.last, ...this.#fold.status };
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
    const before = this.#fold.status;
    const next = foldChat(this.#fold, event);
    let entry;
    try {
      entry = await this.#log.append(event);
    } catch (error) {
      // A refusal of the engine leaves its log as it was.
      if (!(error instanceof TaskStoreError)) this.#stale = true;
      throw error;
    }
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
    if (!this.#fold.turn && this.#fold.open.length === 0) return;
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
    this.#record = { ...this.#record, task: this.#log.task };
  }

  #update(change: ChatChange): Promise<void> {
    return this.#queued(async () => {
      this.#assertPresent();
      const { task, chat } = this.#record;
      this.#record = await updateChat({ project: this.#tag, root: this.#context.root }, task, chat, change);
    });
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
      const done = await this.#context.writes.runAll(turnsOf(tag, this.#record.task), async () =>
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

  /** A new open reads what a failed append left on disk; a status it finds changed is published. */
  async #reopen(): Promise<void> {
    const before = this.#fold.status;
    const last = this.#log.last;
    const opened = await openFolded(this.#context.root, this.#tag, this.#record);
    this.#log = opened.log;
    this.#fold = opened.fold;
    this.#asked = opened.asked;
    this.#answers = opened.answers;
    this.#stale = false;
    this.#announce(before);
    if (this.#log.last !== last) this.hold.notify();
  }

  #announce(before: ChatStatus): void {
    const status = this.#fold.status;
    if (sameStatus(before, status)) return;
    const { task, chat, step } = this.#record;
    this.#context.publish?.({ kind: "chat", tag: this.#tag, task, chat, step, ...status });
  }

  #assertPresent(): void {
    if (this.removed) throw new TaskStoreError("chat-not-found", "this chat is no longer here");
  }
}

export function createChatRegistry(options: {
  root?: string;
  host: ProjectHost;
  writes: WriteQueue;
  /** Receives a `chat` event at the create of a chat and at each change of its status. */
  publish?: Publish;
  holdMs?: number;
  /** Where a fault of the recovery of a chat is reported. */
  stderr?: { write(text: string): unknown };
}): ChatRegistry {
  const { root, host, writes, publish } = options;
  const holdMs = options.holdMs ?? HOLD_MS;
  const stderr = options.stderr ?? process.stderr;
  let closed = false;
  /**
   * The loaded handles, by the place each one stands for now. Only `keep` adds
   * one, always inside the turn of its tag. A load looks here first, so two
   * requests for one chat load it one time and a load that waited behind a
   * rename gives the moved handle.
   */
  const loaded = new Map<string, Live>();

  function forget(live: Live): void {
    live.removed = true;
    live.hold.close();
    if (loaded.get(live.key) === live) loaded.delete(live.key);
  }

  /** Puts a handle in the map. A handle it takes the place of stands for a chat that is gone. */
  function keep(live: Live): void {
    const replaced = loaded.get(live.key);
    if (replaced !== undefined) forget(replaced);
    if (closed) live.hold.close();
    loaded.set(live.key, live);
  }

  const context: Context = { root, holdMs, writes, publish, forget };

  async function load(tag: string, record: ChatRecord): Promise<Live> {
    const present = loaded.get(chatKey(tag, record.task, record.chat));
    if (present !== undefined) return present;
    const live = new Live(context, tag, record, await openFolded(root, tag, record));
    await recover(live);
    keep(live);
    return live;
  }

  /**
   * A chat loaded from disk has no agent process in this daemon: the runner
   * runs only the chats it created or got from here. So a turn or a request
   * that its log leaves open ended with an earlier daemon.
   */
  async function recover(live: Live): Promise<void> {
    try {
      await live.interruptInHeldTurns();
    } catch (error) {
      stderr.write(faultLine(live.chat, error));
    }
  }

  function forgetWhere(test: (live: Live) => boolean): void {
    for (const live of [...loaded.values()]) {
      if (test(live)) forget(live);
    }
  }

  return {
    async create(tag, task, input, message) {
      await host.open(tag);
      return writes.runAll(turnsOf(tag, task), async () => {
        const record = await createChat({ project: tag, root }, task, input);
        const live = new Live(context, tag, record, await openFolded(root, tag, record));
        try {
          await live.appendInHeldTurns({ kind: "user", text: message.text, client: message.client });
        } catch (error) {
          if (!await live.reopenAfterFailedAppend()) throw error;
        }
        keep(live);
        return live;
      });
    },

    async get(tag, task, chat) {
      await host.open(tag);
      // A malformed chat number gives chat-not-found also for a missing task; the engine checks the task first.
      assertChatNumber(chat);
      return loaded.get(chatKey(tag, task, chat))
        ?? writes.runAll(turnsOf(tag, task), async () =>
          loaded.get(chatKey(tag, task, chat)) ?? load(tag, await readChat({ project: tag, root }, task, chat)));
    },

    async list(tag, task) {
      await host.open(tag);
      return writes.runAll(turnsOf(tag, task), async () => {
        const listed = await listChats({ project: tag, root }, task);
        const chats: Live[] = [];
        const diagnostics = [...listed.diagnostics];
        for (const record of listed.chats) {
          try {
            const live = await load(tag, record);
            chats.push(live);
            diagnostics.push(...live.diagnostics);
          } catch (error) {
            diagnostics.push(chatFinding(error, chatPath({ project: tag, root }, record.task, record.chat)));
          }
        }
        return { chats, diagnostics };
      });
    },

    projectRenamed(from, to) {
      for (const [key, live] of [...loaded]) {
        if (live.tag !== from) continue;
        loaded.delete(key);
        live.relocate(to);
        keep(live);
        // A wait under the old tag reads again, and finds no project of that tag.
        live.hold.notify();
      }
    },

    projectRemoved(tag) {
      forgetWhere((live) => live.tag === tag);
    },

    taskRemoved(tag, task) {
      forgetWhere((live) => live.tag === tag && live.chat.task === task);
    },

    close() {
      closed = true;
      for (const live of loaded.values()) live.hold.close();
    },
  };
}
