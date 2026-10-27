// The agents of the chats. One chat has at most one agent process, which the
// daemon owns: the runner starts it with the first message of the chat, writes
// every event of the agent into the chat log, ends the process when the chat
// is idle, and starts it again on the same session with the next message. The
// commands of the clients on a chat run here too: a message, a cancel, an
// answer and a pick of a config option. A session that opens gets the values
// of the chat before its first prompt.

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { RequestError } from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest, SessionConfigOption } from "@agentclientprotocol/sdk";
import { readProjectDeclaration, TaskStoreError } from "@tasma/engine";
import type { AgentDefaultsStore, TaskStoreErrorCode } from "@tasma/engine";
import type {
  AcpObject,
  ChatAgent,
  ChatCancelInput,
  ChatEvent,
  ChatMessageInput,
  ChatOptionChange,
  Diagnostic,
  PermissionAnswer,
  QuestionAnswer,
} from "@tasma/protocol";
import { AgentClosed, connectAgent, SessionNotFound, spawnAgent } from "../agents/acp.js";
import type { AgentConnection, AgentEnd, AgentHandlers, AgentProcess, AgentSession } from "../agents/acp.js";
import type { AgentAdapter, AgentEnv, AgentLaunch } from "../agents/adapter.js";
import { readShellEnv } from "../agents/shell-env.js";
import type { ShellEnv } from "../agents/shell-env.js";
import { causeOf, DaemonError } from "../http/failure.js";
import { AGENT_STEP_IDLE_MS, idleTimer } from "./idle.js";
import type { IdleLimit, IdleTimer } from "./idle.js";
import { applyPlan, foldOptions, isHidden, offering, optionFiles, optionsEvent, wanted } from "./options.js";
import { CANCELLED, faultLine, resolution } from "./registry.js";
import type { ChatRegistry, LiveChat, RequestKind } from "./registry.js";

const AUTH_REQUIRED = RequestError.authRequired().code;

/** The refusals of a chat write that mean the chat is gone: a delete of its project or of its task. */
const GONE: ReadonlySet<TaskStoreErrorCode> = new Set(["chat-not-found", "task-not-found", "project-not-found"]);

const KIND_NAME = { permission: "permission request", question: "question" } as const;

const END_GRACE_MS = 10_000;

export class ChatStartRefusal extends Error {
  readonly code: "agent-not-supported" | "project-has-no-folder";

  constructor(code: ChatStartRefusal["code"], message: string) {
    super(message);
    this.name = "ChatStartRefusal";
    this.code = code;
  }
}

export type OpenRequest = {
  kind: RequestKind;
  /** The params of the request, as the SDK gives them. */
  params: AcpObject;
  /** Sends the response to the agent. Only the runner calls it, once, after it takes the request out of `open`. */
  answer(result: AcpObject): void;
};

export type RunningChat = {
  live: LiveChat;
  /** Set at the spawn. A restart has none while it waits for the last process of the chat and while it launches. */
  process: AgentProcess | undefined;
  /** Set once the agent has opened the session. */
  session: AgentSession | undefined;
  /** The requests of the agent that wait for an answer, keyed by the `request` of their log event, in open order. */
  open: Map<string, OpenRequest>;
  /** The config options of the session as its answers and the notifications of the agent leave them. */
  options: SessionConfigOption[];
};

/**
 * Each command resolves when its events are in the log. A refusal is a
 * `DaemonError`. A fault of the log rejects the command after the run halts.
 */
export type ChatRunner = {
  /**
   * Creates the chat with its first message, so it is `working`, and starts
   * its agent in the background. A `ChatStartRefusal` comes before the chat is
   * created. A start waits for a read of the login shell, before the create,
   * when the agent binary is neither on the `PATH` of the daemon nor in the
   * shell environment of an earlier start.
   */
  start(input: {
    tag: string;
    task: string;
    step: string;
    agent: ChatAgent;
    text: string;
    client: string;
  }): Promise<LiveChat>;
  running(live: LiveChat): RunningChat | undefined;
  /**
   * Writes the `user` event and starts a turn with the text, and with the
   * earlier texts of the chat that the agent has still to get. A chat with no
   * agent process gets its agent started again in the background, on the
   * stored session, after the last process of the chat has ended. Refused with
   * `turn-running` while a turn runs or the chat ends for a restart, and with
   * `chat-not-running` once `stopStarts()` was called.
   */
  message(live: LiveChat, input: ChatMessageInput): Promise<void>;
  /**
   * Cancels the turn that runs and resolves its open requests in the name of
   * `client`. Does nothing when no turn runs.
   */
  cancel(live: LiveChat, input: ChatCancelInput): Promise<void>;
  answerPermission(live: LiveChat, request: string, answer: PermissionAnswer): Promise<void>;
  answerQuestion(live: LiveChat, request: string, answer: QuestionAnswer): Promise<void>;
  /**
   * Sets one config option on the agent of the chat. An accepted value is
   * saved in the chat and, unless `AGENT_OPTION_RULES` lists it as unsaved, as
   * the default of the agent. The picks of one chat run one after the other. A
   * chat whose session is not open yet gets the value as the session opens. A
   * chat with no agent process gets its agent started again with no prompt.
   * Resolves with a diagnostic for each file that a write missed. Refused with
   * `option-refused` when the agent does not offer or does not take the value,
   * and with `turn-running` while the chat ends for a restart.
   */
  setOption(live: LiveChat, change: ChatOptionChange): Promise<Diagnostic[]>;
  /**
   * Ends the agent of the chat with no event, and resolves when every process
   * of the chat has ended. Refused with `turn-running` while a turn runs or a
   * request of the agent is open.
   */
  stop(live: LiveChat): Promise<void>;
  /**
   * Cancels the turn that runs, as `cancel` does, waits up to `endGraceMs` for
   * the turn to end, and then ends the agent of the chat. A turn that does not
   * end in time is interrupted, as `close()` interrupts each chat. A turn whose
   * session is not open yet is interrupted at once, with no cancel and no wait.
   * Between turns, the open requests are cancelled in the name of `client`.
   * The end of the process writes no event. Resolves when every process of the
   * chat has ended. Until it settles, a message and a pick of the chat are
   * refused with `turn-running`. Refused with `chat-not-running` when the
   * daemon stops before it resolves.
   */
  end(live: LiveChat, input: ChatCancelInput): Promise<void>;
  /**
   * Aborts a read of the login shell in progress and does not wait for it, and
   * clears every idle timer, so no idle stop starts after it. A start that has
   * not spawned its agent yet then spawns none, and a later message is
   * refused. `close()` does the same.
   */
  stopStarts(): void;
  /**
   * Interrupts each chat in a turn or with an open request, as `LiveChat.interrupt`
   * does, and ends every agent process. Resolves when every process has ended
   * and every write is done; a fault of a write is reported.
   */
  close(): Promise<void>;
};

/** A pick that waits for the session of its run to open. */
type WaitingPick = {
  configId: string;
  value: string;
  resolve(diagnostics: Diagnostic[]): void;
  reject(error: unknown): void;
};

/** Sends the result of one waiting pick to its caller. */
type PickAnswer = () => void;

type Run = RunningChat & {
  /** The picks that the session takes as it opens, in arrival order. */
  waiting: WaitingPick[];
  /** Clear for a relaunch that a pick starts: the session gets no prompt. */
  promptOnOpen: boolean;
  /** Set with the process. */
  adapter: AgentAdapter | undefined;
  /** Set with the process. */
  idle: IdleTimer | undefined;
  /** The texts of the chat that no prompt has taken to the agent, in log order. A new session takes every text. */
  unsent: string[];
  /** Set when the run writes no more events: at a failure, once the chat is gone, and at a stop. */
  quiet: boolean;
  /** Set at the first refusal or fault of the log. */
  halted: boolean;
  /** Set from the message that starts a turn to its prompt result. While it is clear, the session is open. */
  turning: boolean;
  /** Set when `begin` reads `cancelledEarly`, after the session id is written. Then a cancel goes to the agent. */
  cancelReachesAgent: boolean;
  /** Set by a cancel before `cancelReachesAgent`. `begin` then sends no first prompt, and ends the first turn. */
  cancelledEarly: boolean;
  /**
   * Set while `end` waits for the turn to end. Called where `turning` becomes
   * false in a run that is not quiet. A run becomes quiet only where its
   * process ends or the daemon stops, and each of them ends the wait too.
   */
  turnEnded: (() => void) | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function cleanExit(end: AgentEnd): boolean {
  return !("error" in end) && end.code === 0;
}

function endReason(end: AgentEnd): string {
  if ("error" in end) return `The agent could not start: ${end.error.message}`;
  return end.signal === null
    ? `The agent process ended with exit code ${String(end.code)}`
    : `The agent process ended with signal ${end.signal}`;
}

function errorReason(adapter: AgentAdapter, error: unknown): string {
  if (error instanceof RequestError) {
    if (error.code === AUTH_REQUIRED) return adapter.notLoggedIn;
    const data: unknown = error.data;
    if (isRecord(data) && typeof data.details === "string") return data.details;
  }
  return causeOf(error);
}

/** The SDK checks the params of a permission request against the ACP schema before a handler gets them. */
function offers(params: AcpObject, optionId: string): boolean {
  return (params as RequestPermissionRequest).options.some((option) => option.optionId === optionId);
}

function nameOf(live: LiveChat): string {
  return `chat ${live.chat.chat} of ${live.chat.task}`;
}

function notRunning(live: LiveChat): DaemonError {
  return new DaemonError("chat-not-running", `${nameOf(live)} has no agent process`);
}

function daemonStopping(live: LiveChat): DaemonError {
  return new DaemonError("chat-not-running", `${nameOf(live)} cannot run: the daemon is stopping`);
}

function turnRunning(live: LiveChat): DaemonError {
  return new DaemonError("turn-running", `a turn of ${nameOf(live)} is running`);
}

function endingForRestart(live: LiveChat): DaemonError {
  return new DaemonError("turn-running", `${nameOf(live)} is ending for a restart`);
}

function couldNotRun(live: LiveChat, reason: string): DaemonError {
  return new DaemonError("chat-not-running", `${nameOf(live)} has no agent process: ${reason}`);
}

function notOffered(live: LiveChat, configId: string, value: string): DaemonError {
  return new DaemonError("option-refused", `the agent of ${nameOf(live)} offers no value "${value}" for "${configId}"`);
}

function refusedBy(live: LiveChat, configId: string, value: string, reason: string): DaemonError {
  return new DaemonError("option-refused", `the agent of ${nameOf(live)} refused "${value}" for "${configId}": ${reason}`);
}

function answerAll(answers: PickAnswer[]): void {
  for (const answer of answers) answer();
}

function newRun(live: LiveChat): Run {
  return {
    live,
    process: undefined,
    session: undefined,
    open: new Map(),
    options: [],
    waiting: [],
    promptOnOpen: true,
    adapter: undefined,
    idle: undefined,
    unsent: [],
    quiet: false,
    halted: false,
    turning: true,
    cancelReachesAgent: false,
    cancelledEarly: false,
    turnEnded: undefined,
  };
}

export function createChatRunner(options: {
  root?: string;
  chats: ChatRegistry;
  adapters: readonly AgentAdapter[];
  /** The environment of the daemon, which each launch starts from. */
  env: AgentEnv;
  spawn?: (launch: AgentLaunch, folder: string) => AgentProcess;
  /** Reads the environment of the login shell, for an agent binary that is not on the `PATH` of `env`. */
  shellEnv?: (signal: AbortSignal) => Promise<ShellEnv>;
  /** How long an agent with no turn and no open request runs before it is ended. */
  idleLimit?: IdleLimit;
  /** Where a fault of a chat log is reported. */
  stderr?: { write(text: string): unknown };
  /** The config option defaults of each agent. */
  defaults: AgentDefaultsStore;
  /** How long `end` waits for a cancelled turn to end. */
  endGraceMs?: number;
}): ChatRunner {
  const { root, chats, adapters, env, defaults } = options;
  const endGraceMs = options.endGraceMs ?? END_GRACE_MS;
  const spawn = options.spawn ?? spawnAgent;
  const shellEnv = options.shellEnv ?? ((signal) => readShellEnv(env, { signal }));
  const idleLimit = options.idleLimit ?? (() => Promise.resolve(AGENT_STEP_IDLE_MS));
  const stderr = options.stderr ?? process.stderr;
  const files = optionFiles({ root, defaults, stderr });
  const runs = new Map<LiveChat, Run>();
  /** Every agent process that has not exited, also of a chat that no longer runs. */
  const alive = new Set<AgentProcess>();
  /** For the last agent process of each chat: its `ended`, and the handling of its exit. */
  const ends = new WeakMap<LiveChat, Promise<unknown>>();
  /** The last run of each chat in this daemon. */
  const lastRuns = new WeakMap<LiveChat, Run>();
  /** The end of the last pick of each chat that has not ended, which the next pick of the chat waits for. */
  const picks = new WeakMap<LiveChat, Promise<void>>();
  /** The chats whose `end` has not settled. */
  const ending = new WeakSet<LiveChat>();
  const stopping = new AbortController();
  /** The last shell environment in which an agent binary was found. */
  let kept: AgentEnv | undefined;
  /** The read of the shell in progress, which every start shares. */
  let reading: Promise<ShellEnv> | undefined;

  async function readShell(): Promise<ShellEnv> {
    try {
      return await shellEnv(stopping.signal);
    } catch (error) {
      return { failed: causeOf(error) };
    }
  }

  /**
   * A kept environment with no binary, or a failed read, gives a new read at
   * the next start, so an install after a failed chat needs no daemon restart.
   */
  async function launchOf(adapter: AgentAdapter): Promise<AgentLaunch | { failed: string }> {
    const own = adapter.launch(env);
    if (!("missing" in own)) return own;
    if (kept !== undefined) {
      const again = adapter.launch(kept);
      if (!("missing" in again)) return again;
    }
    reading ??= readShell().finally(() => (reading = undefined));
    const read = await reading;
    if ("failed" in read) return read;
    const launch = adapter.launch(read.env);
    if ("missing" in launch) return { failed: launch.missing };
    kept = read.env;
    return launch;
  }

  function report(live: LiveChat, error: unknown): void {
    if (error instanceof TaskStoreError && GONE.has(error.code)) return;
    stderr.write(faultLine(live.chat, error));
  }

  function register(live: LiveChat): Run {
    const run = newRun(live);
    runs.set(live, run);
    lastRuns.set(live, run);
    return run;
  }

  /** `error` refuses each pick that still waits for the session. */
  function forget(run: Run, error: DaemonError = notRunning(run.live)): void {
    if (runs.get(run.live) === run) runs.delete(run.live);
    run.open.clear();
    run.idle?.clear();
    for (const pick of run.waiting.splice(0)) pick.reject(error);
  }

  function silence(run: Run, error?: DaemonError): void {
    run.quiet = true;
    forget(run, error);
  }

  /** Ends the process with no event. The chat keeps its state. */
  async function quit(run: Run): Promise<void> {
    silence(run);
    await run.process?.end();
  }

  /** After a refusal or a fault of the log: the run writes nothing more, and its process ends. */
  async function halt(run: Run, error: unknown): Promise<void> {
    if (!run.halted) report(run.live, error);
    run.halted = true;
    await quit(run);
  }

  /** A fault of the call halts the run, and then rejects the call. */
  async function haltOnFault<T>(run: Run, logCall: () => Promise<T>): Promise<T> {
    try {
      return await logCall();
    } catch (error) {
      await halt(run, error);
      throw error;
    }
  }

  async function record(run: Run, event: ChatEvent): Promise<void> {
    await haltOnFault(run, () => run.live.append(event));
  }

  async function append(run: Run, event: ChatEvent): Promise<void> {
    await record(run, event).catch(() => undefined);
  }

  async function fail(run: Run, reason: string): Promise<void> {
    if (run.quiet) return;
    silence(run, couldNotRun(run.live, reason));
    await append(run, { kind: "failed", reason });
    await run.process?.end();
  }

  /**
   * After `AgentClosed` the process can still run, for example when the SDK
   * closed the connection at a message over its size limit, so it is ended.
   * Its exit fails the run. Only a run with a process sends requests.
   */
  function failWith(run: Run, error: unknown): Promise<void> {
    if (error instanceof AgentClosed) return run.process!.end();
    return fail(run, errorReason(run.adapter!, error));
  }

  /** Sends one request to the agent. A failure of it fails the run, and gives undefined. */
  async function send<T>(run: Run, call: () => Promise<T>): Promise<T | undefined> {
    try {
      return await call();
    } catch (error) {
      await failWith(run, error);
      return undefined;
    }
  }

  /** Takes the request out of `open`, writes its resolution, and then sends the response to the agent. */
  function settle(run: Run, request: string, open: OpenRequest, result: AcpObject, client?: string): Promise<void> {
    run.open.delete(request);
    run.idle?.touch();
    const written = record(run, resolution(open.kind, request, result, client));
    open.answer(open.kind === "permission" ? { outcome: result } : result);
    return written;
  }

  function cancelOpen(run: Run, client?: string): Promise<void>[] {
    return [...run.open].map(([request, open]) => settle(run, request, open, CANCELLED[open.kind], client));
  }

  /** The agent still waits for an answer to each request that is open at the end of the turn. */
  async function endTurn(run: Run, stopReason: string): Promise<void> {
    run.turning = false;
    if (run.quiet) return;
    void Promise.allSettled(cancelOpen(run));
    run.idle?.touch();
    const written = append(run, { kind: "turn-end", stopReason });
    run.turnEnded?.();
    await written;
  }

  async function runTurn(run: Run, session: AgentSession): Promise<void> {
    const text = run.unsent.join("\n\n");
    run.unsent = [];
    const result = await send(run, () => session.prompt(text));
    if (result !== undefined) await endTurn(run, result.stopReason);
  }

  /** Each handler appends before its first await, so the log keeps the order in which the handlers run. */
  function handlersOf(run: Run, adapter: AgentAdapter): AgentHandlers {
    function ask(kind: RequestKind) {
      return (params: AcpObject, answer: (result: AcpObject) => void): () => void => {
        const request = randomUUID();
        if (!run.quiet) {
          run.open.set(request, { kind, params, answer });
          run.idle?.touch();
          void append(run, kind === "permission" ? { kind, request, permission: params } : { kind, request, question: params });
        }
        return () => {
          if (!run.open.delete(request)) return;
          run.idle?.touch();
          void append(run, resolution(kind, request, CANCELLED[kind]));
        };
      };
    }

    return {
      update(update) {
        if (run.quiet) return;
        run.idle?.touch();
        run.options = foldOptions(run.options, update);
        void append(run, { kind: "update", update: adapter.filterUpdate(update) });
      },
      permission: ask("permission"),
      question: ask("question"),
    };
  }

  /**
   * Resumes the stored session of the chat, or opens a new one, which gets
   * every text of the chat. An agent that never answered in a session may have
   * saved nothing of it, so its loss then fails nothing.
   */
  async function openSession(
    run: Run,
    connection: AgentConnection,
  ): Promise<{ session: AgentSession; created: boolean } | undefined> {
    const { live } = run;
    const { folder, session: stored } = live.chat;
    if (stored !== undefined) {
      const resumed = await send(run, () => connection.resume(folder, stored).catch((error: unknown) => {
        if (error instanceof SessionNotFound) return "lost" as const;
        throw error;
      }));
      if (resumed === undefined) return undefined;
      if (resumed !== "lost") return { session: resumed, created: false };
      if (live.answered) {
        await fail(run, run.adapter!.sessionGone);
        return undefined;
      }
    }
    run.unsent = [...live.unanswered];
    const session = await send(run, () => connection.create(folder));
    if (session === undefined) return undefined;
    try {
      await live.setSession(session.sessionId);
    } catch (error) {
      await halt(run, error);
      return undefined;
    }
    return { session, created: true };
  }

  /** Gives the reason of a refusal of the agent. `AgentClosed` passes on. */
  async function setOn(run: Run, session: AgentSession, configId: string, value: string): Promise<string | undefined> {
    try {
      run.options = await session.setConfigOption(configId, value);
    } catch (error) {
      if (error instanceof AgentClosed) throw error;
      return errorReason(run.adapter!, error);
    }
    if (!run.quiet) await append(run, optionsEvent(run.options));
    return undefined;
  }

  /** Sets one pick on the session and saves it. Refused as `setOption` is, and with `chat-not-running` at a close. */
  async function pickOn(run: Run, session: AgentSession, configId: string, value: string): Promise<Diagnostic[]> {
    const { live } = run;
    if (offering(run.options, configId, value) === undefined) throw notOffered(live, configId, value);
    let reason;
    try {
      reason = await setOn(run, session, configId, value);
    } catch {
      throw notRunning(live);
    }
    if (reason !== undefined) throw refusedBy(live, configId, value, reason);
    return files.save(live, configId, value);
  }

  /**
   * Takes the pick out of `run.waiting` and gives its answer to `answers`.
   * Gives false when the connection closed; the pick then has its answer
   * already. `pickOn` refuses only with a `DaemonError`.
   */
  async function applyPick(
    run: Run,
    session: AgentSession,
    pick: WaitingPick,
    answers: PickAnswer[],
  ): Promise<boolean> {
    run.waiting = run.waiting.filter((one) => one !== pick);
    try {
      const diagnostics = await pickOn(run, session, pick.configId, pick.value);
      answers.push(() => pick.resolve(diagnostics));
    } catch (error) {
      if ((error as DaemonError).code === "chat-not-running") {
        pick.reject(error);
        return false;
      }
      answers.push(() => pick.reject(error));
    }
    return true;
  }

  /**
   * Gives a session that just opened the values of `applyPlan`: the defaults
   * of the agent for a new session, the picks of the chat, and the waiting
   * picks. A default or a pick of the chat that `wanted` refuses is not sent,
   * and a refusal of it fails nothing. Sets `run.session` in the step that
   * finds no waiting pick left, unless the run ended. Gives the answers of the
   * waiting picks that it applied; a waiting pick that it did not reach stays
   * in `run.waiting`, for the end of the run.
   */
  async function applyOptions(run: Run, session: AgentSession, created: boolean): Promise<PickAnswer[]> {
    if (run.quiet) return [];
    const { live } = run;
    const { agent } = live.chat;
    run.options = session.configOptions;
    if (run.options.length > 0) await append(run, optionsEvent(run.options));
    const defaults = created && run.options.length > 0 ? await files.defaultsOf(agent) : {};
    const plan = applyPlan(run.options, { defaults, chosen: live.chat.options ?? {}, waiting: run.waiting });

    const answers: PickAnswer[] = [];
    for (const { configId, value, pick } of plan) {
      // The end of the run answered the waiting picks.
      if (run.quiet) return answers;
      if (pick !== undefined) {
        if (!(await applyPick(run, session, pick, answers))) return answers;
        continue;
      }
      if (!wanted(agent, run.options, configId, value)) continue;
      let reason;
      try {
        reason = await setOn(run, session, configId, value);
      } catch {
        return answers;
      }
      if (reason !== undefined) stderr.write(faultLine(live.chat, `the agent refused "${value}" for "${configId}": ${reason}`));
    }
    for (let pick = run.waiting[0]; pick !== undefined; pick = run.waiting[0]) {
      if (!(await applyPick(run, session, pick, answers))) return answers;
    }
    if (!run.quiet) run.session = session;
    return answers;
  }

  async function begin(run: Run, connection: AgentConnection): Promise<void> {
    await send(run, () => connection.initialize());
    if (run.quiet) return;
    const opened = await openSession(run, connection);
    if (opened === undefined) return;
    const answers = await applyOptions(run, opened.session, opened.created);
    const { session } = run;
    if (session === undefined) return answerAll(answers);
    run.cancelReachesAgent = true;
    if (!run.promptOnOpen) {
      // A pick takes a failed chat out of its stop, as a message does.
      if (run.live.fold.stopped !== undefined) await append(run, { kind: "resumed" });
      run.turning = false;
      run.turnEnded?.();
      run.idle?.touch();
      return answerAll(answers);
    }
    answerAll(answers);
    if (!run.cancelledEarly) return runTurn(run, session);
    // As `LiveChat.unanswered` does at a cancelled turn end.
    if (run.live.answered) run.unsent = [];
    await endTurn(run, "cancelled");
  }

  /**
   * Runs after the exit and the close of the connection, so after the handlers
   * of every message the agent sent, and before the rest of the group of the
   * process has ended.
   */
  function onExit(run: Run, end: AgentEnd): void {
    if (run.turning || !cleanExit(end)) void fail(run, endReason(end));
    forget(run);
  }

  /** Registered in the same step as the spawn, so `close()` sees every process. */
  function spawnRun(
    run: Run,
    adapter: AgentAdapter,
    launch: AgentLaunch,
    folder: string,
    limitMs: number,
  ): AgentConnection {
    const agentProcess = spawn(launch, folder);
    run.process = agentProcess;
    run.adapter = adapter;
    run.idle = idleTimer({ limitMs, busy: () => run.turning || run.open.size > 0, expire: () => void quit(run) });
    alive.add(agentProcess);
    void agentProcess.ended.then(() => alive.delete(agentProcess));
    const connection = connectAgent(agentProcess.stream, handlersOf(run, adapter));
    // With its connection closed, the process can take no more requests.
    void connection.closed.then(() => agentProcess.end());
    const exit = Promise.all([agentProcess.exited, connection.closed]).then(([end]) => onExit(run, end));
    // So a restart writes after the failure of the exit.
    ends.set(run.live, Promise.all([agentProcess.ended, exit]));
    return connection;
  }

  /** The background part of a restart, after its `user` event is written. */
  async function relaunch(run: Run): Promise<void> {
    const { live } = run;
    const { agent, folder, task, step } = live.chat;
    const adapter = adapters.find((one) => one.agent === agent);
    if (adapter === undefined) return fail(run, `Tasma cannot run ${agent} yet`);
    if (!(await isDirectory(folder))) {
      return fail(run, `The folder of this chat no longer exists: ${folder}. Start a new chat for this step.`);
    }
    const launch = await launchOf(adapter);
    const limitMs = await idleLimit(live.tag, task, step);
    // The run stays in a turn, so `close()` interrupts it.
    if (stopping.signal.aborted) {
      for (const pick of run.waiting.splice(0)) pick.reject(daemonStopping(live));
      return;
    }
    // An `end` stopped the run during the launch.
    if (run.quiet) return;
    if ("failed" in launch) return fail(run, launch.failed);
    await begin(run, spawnRun(run, adapter, launch, folder, limitMs));
  }

  /** A restart that the daemon stop or an `end` overtakes before its `user` event writes nothing more. */
  function refuseIfOvertaken(run: Run): void {
    if (!run.quiet && !stopping.signal.aborted) return;
    const error = stopping.signal.aborted ? daemonStopping(run.live) : endingForRestart(run.live);
    silence(run, error);
    throw error;
  }

  /**
   * The start of each restart, after the run of the restart is registered:
   * the wait for the last process of the chat and the interrupt of its turn.
   */
  async function reopen(run: Run, last: Run | undefined): Promise<void> {
    const { live } = run;
    await ends.get(live);
    // The log cannot show which texts of a cancelled turn with no answer reached the agent; the last run knows.
    run.unsent = [...(last?.unsent ?? live.unanswered)];
    refuseIfOvertaken(run);
    await haltOnFault(run, () => live.interrupt());
    refuseIfOvertaken(run);
  }

  /**
   * Registered before the first await, so a second message is refused and
   * `close()` sees the chat. Two processes never run on one session.
   */
  async function restart(live: LiveChat, text: string, client: string): Promise<void> {
    const last = lastRuns.get(live);
    const run = register(live);
    await reopen(run, last);
    await record(run, { kind: "user", text, client });
    run.unsent.push(text);
    void relaunch(run);
  }

  /**
   * As `restart`, with a pick in the place of the message: the run writes no
   * `user` event and sends no prompt. It stays in a turn until the session has
   * the pick, so a message meanwhile is refused.
   */
  async function relaunchForPick(live: LiveChat, pick: WaitingPick): Promise<void> {
    const last = lastRuns.get(live);
    const run = register(live);
    run.promptOnOpen = false;
    run.waiting.push(pick);
    try {
      await reopen(run, last);
    } catch {
      // The end of the run refused the pick.
      return;
    }
    void relaunch(run);
  }

  async function pickNow(live: LiveChat, { configId, value }: ChatOptionChange): Promise<Diagnostic[]> {
    if (ending.has(live)) throw endingForRestart(live);
    if (stopping.signal.aborted) throw daemonStopping(live);
    const run = runs.get(live);
    const session = run?.session;
    if (run === undefined || session === undefined) {
      return new Promise((resolve, reject) => {
        const pick = { configId, value, resolve, reject };
        if (run === undefined) void relaunchForPick(live, pick);
        else run.waiting.push(pick);
      });
    }
    run.idle?.touch();
    return pickOn(run, session, configId, value);
  }

  /**
   * Ends at the end of the turn, at the end of the processes of the chat,
   * after `endGraceMs`, or at the daemon stop.
   */
  async function waitForTurnEnd(run: Run): Promise<void> {
    const turn = new Promise<void>((resolve) => (run.turnEnded = resolve));
    const clearLimit = new AbortController();
    const limit = sleep(endGraceMs, undefined, { signal: AbortSignal.any([stopping.signal, clearLimit.signal]) })
      .catch(() => undefined);
    await Promise.race([turn, ends.get(run.live), limit]);
    run.turnEnded = undefined;
    clearLimit.abort();
  }

  /**
   * Ends the agent of the run, and gives the writes that this end calls: the
   * interrupt of a turn that still runs, or the cancelled resolutions of the
   * open requests of a run with no turn, in the name of `client`. The end of
   * the process writes no event.
   */
  function endNow(run: Run, client: string): Promise<unknown>[] {
    const writes: Promise<unknown>[] = [];
    if (!run.turning) writes.push(...cancelOpen(run, client));
    else if (!run.quiet) {
      silence(run);
      writes.push(haltOnFault(run, () => run.live.interrupt()));
    }
    void quit(run);
    return writes;
  }

  /** The steps of `end`. The chat is in `ending` while they run. */
  async function endOf(live: LiveChat, client: string): Promise<void> {
    if (stopping.signal.aborted) throw daemonStopping(live);
    const run = runs.get(live);
    if (run?.turning && run.cancelReachesAgent) {
      const turnEnd = waitForTurnEnd(run);
      // ACP wants `session/cancel` before the cancelled responses.
      run.session!.cancel();
      await Promise.all([turnEnd, Promise.all(cancelOpen(run, client))]);
      // `close()` interrupts the run.
      if (stopping.signal.aborted) throw daemonStopping(live);
    }
    const writes = run === undefined ? [] : endNow(run, client);
    await Promise.all([...writes, ends.get(live)]);
    // Only after `ends`: the handling of an exit calls its write before `ends` resolves.
    await live.written();
    if (stopping.signal.aborted) throw daemonStopping(live);
  }

  /** The open request an answer takes. The caller takes it out of `open` in the same synchronous step. */
  function pending(live: LiveChat, request: string, kind: RequestKind): { run: Run; open: OpenRequest } {
    const run = runs.get(live);
    const open = run?.open.get(request);
    if (run === undefined && live.fold.open.includes(request)) throw notRunning(live);
    if (run === undefined || open === undefined) {
      throw new DaemonError("already-answered", `request ${request} of ${nameOf(live)} is not open`);
    }
    if (open.kind !== kind) {
      throw new DaemonError(
        "malformed-request",
        `request ${request} of ${nameOf(live)} is a ${KIND_NAME[open.kind]}, not a ${KIND_NAME[kind]}`,
      );
    }
    return { run, open };
  }

  return {
    async start({ tag, task, step, agent, text, client }) {
      const adapter = adapters.find((one) => one.agent === agent);
      if (adapter === undefined) throw new ChatStartRefusal("agent-not-supported", `Tasma cannot run ${agent} yet`);
      const { path } = await readProjectDeclaration({ project: tag, root });
      if (path === undefined || !(await isDirectory(path))) {
        throw new ChatStartRefusal("project-has-no-folder", `project ${tag} has no folder for an agent to work in`);
      }

      const launch = await launchOf(adapter);
      const limitMs = await idleLimit(tag, task, step);
      const live = await chats.create(tag, task, { step, agent, folder: path }, { text, client });
      // After `stopStarts()`, the chat stays with no agent, as a daemon stop leaves every other chat.
      if (stopping.signal.aborted) return live;
      if ("failed" in launch) {
        try {
          await live.append({ kind: "failed", reason: launch.failed });
        } catch (error) {
          report(live, error);
        }
        return live;
      }

      const run = register(live);
      void begin(run, spawnRun(run, adapter, launch, path, limitMs));
      return live;
    },

    running(live) {
      return runs.get(live);
    },

    async message(live, { text, client }) {
      if (ending.has(live)) throw endingForRestart(live);
      const run = runs.get(live);
      if (run?.turning) throw turnRunning(live);
      if (stopping.signal.aborted) throw daemonStopping(live);
      if (run === undefined) return restart(live, text, client);
      run.turning = true;
      run.idle?.touch();
      run.unsent.push(text);
      const written = record(run, { kind: "user", text, client });
      void runTurn(run, run.session!);
      await written;
    },

    async cancel(live, { client }) {
      const run = runs.get(live);
      if (!run?.turning) return;
      // ACP wants `session/cancel` before the cancelled responses.
      if (run.cancelReachesAgent) run.session!.cancel();
      else run.cancelledEarly = true;
      await Promise.all(cancelOpen(run, client));
    },

    async answerPermission(live, request, { optionId, client }) {
      const { run, open } = pending(live, request, "permission");
      if (!offers(open.params, optionId)) {
        throw new DaemonError("malformed-request", `permission request ${request} of ${nameOf(live)} offers no option "${optionId}"`);
      }
      await settle(run, request, open, { outcome: "selected", optionId }, client);
    },

    async answerQuestion(live, request, answer) {
      const { run, open } = pending(live, request, "question");
      const result = answer.action === "accept" ? { action: "accept", content: answer.content } : { action: "decline" };
      await settle(run, request, open, result, answer.client);
    },

    setOption(live, change) {
      const { configId, value } = change;
      if (isHidden(live.chat.agent, configId, value)) return Promise.reject(notOffered(live, configId, value));
      // With no pick before it, the pick takes the chat in this step, as a message does.
      const before = picks.get(live);
      const picked = before === undefined ? pickNow(live, change) : before.then(() => pickNow(live, change));
      const settled: Promise<void> = picked.then(
        () => undefined,
        () => undefined,
      ).then(() => {
        if (picks.get(live) === settled) picks.delete(live);
      });
      picks.set(live, settled);
      return picked;
    },

    async stop(live) {
      const run = runs.get(live);
      if (run?.turning) throw turnRunning(live);
      if (run !== undefined) {
        if (run.open.size > 0) throw new DaemonError("turn-running", `${nameOf(live)} has a request open`);
        void quit(run);
      }
      await ends.get(live);
    },

    async end(live, { client }) {
      ending.add(live);
      try {
        await endOf(live, client);
      } finally {
        ending.delete(live);
      }
    },

    stopStarts() {
      stopping.abort();
      for (const run of runs.values()) run.idle?.clear();
    },

    async close() {
      stopping.abort();
      const writes = [...runs.values()].map((run) => {
        silence(run, daemonStopping(run.live));
        return run.live.interrupt().catch((error: unknown) => report(run.live, error));
      });
      await Promise.all([...writes, ...[...alive].map((agentProcess) => agentProcess.end())]);
    },
  };
}
