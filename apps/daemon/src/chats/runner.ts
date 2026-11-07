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
import { chatBusy } from "@tasma/protocol";
import type {
  AcpObject,
  ChatAgent,
  ChatCancelInput,
  ChatEvent,
  ChatMessageInput,
  ChatOptionChange,
  Diagnostic,
  PermissionAnswer,
  ProjectChat,
  QuestionAnswer,
} from "@tasma/protocol";
import { AgentClosed, connectAgent, SessionNotFound, spawnAgent } from "../agents/acp.js";
import type { AgentConnection, AgentEnd, AgentHandlers, AgentProcess, AgentSession } from "../agents/acp.js";
import type { AgentAdapter, AgentEnv, AgentLaunch, BackgroundCommands, BackgroundState } from "../agents/adapter.js";
import { readShellEnv } from "../agents/shell-env.js";
import type { ShellEnv } from "../agents/shell-env.js";
import { causeOf, DaemonError } from "../http/failure.js";
import {
  AGENT_STEP_IDLE_MS,
  holdReason,
  idleTimer,
  JOB_HOLD_MS,
  ownTurnReason,
  PROJECT_CHAT_IDLE_MS,
  stopNote,
} from "./idle.js";
import type { IdleLimit, IdleTimer } from "./idle.js";
import { applyPlan, foldOptions, isHidden, offering, optionFiles, optionsEvent, wanted } from "./options.js";
import { CANCELLED, chatFault, chatName, isProjectChat, resolution } from "./registry.js";
import type { AnyLiveChat, ChatRegistry, LiveChat, RequestKind } from "./registry.js";

const AUTH_REQUIRED = RequestError.authRequired().code;

/** The refusals of a chat write that mean the chat is gone: a delete of its project or of its task. */
const GONE: ReadonlySet<TaskStoreErrorCode> = new Set(["chat-not-found", "task-not-found", "project-not-found"]);

const KIND_NAME = { permission: "permission request", question: "question" } as const;

const END_GRACE_MS = 10_000;

/** The kinds of update that show an own turn. */
const OWN_TURN_OUTPUT: ReadonlySet<unknown> = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call"]);

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
  live: AnyLiveChat;
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
  /**
   * As `start`, for a project chat in the folder of the project. The agent
   * gets `text` as its first prompt. The chat stores `title` as it is given.
   */
  startProjectChat(input: {
    tag: string;
    title: string;
    agent: ChatAgent;
    text: string;
    client: string;
  }): Promise<LiveChat<ProjectChat>>;
  running(live: AnyLiveChat): RunningChat | undefined;
  /**
   * Writes the `user` event and starts a turn with the text, and with the
   * earlier texts of the chat that the agent has still to get. A chat with no
   * agent process gets its agent started again in the background, on the
   * stored session, after the last process of the chat has ended. A message
   * while a pick starts the agent again joins that start: its `user` event
   * comes after the interrupt of the start, and its turn starts once the
   * session has that pick and each pick that came before the message.
   *
   * A message during a turn goes into that turn. Before the first prompt is
   * sent, its text joins the first prompt, and its `user` event comes after
   * those of the messages before it. After that, the agent gets the text at
   * its next step through a steer, or else as the next prompt of the same
   * turn. It never waits for the agent. Refused with `turn-running` while the
   * chat ends for a restart, and with `chat-not-running` once `stopStarts()`
   * was called.
   */
  message(live: AnyLiveChat, input: ChatMessageInput): Promise<void>;
  /**
   * Cancels the turn that runs, also an own turn, and resolves its open requests
   * in the name of `client`. Each text of a message that the agent has not got
   * yet is dropped, except before the first prompt in a chat with no answer of
   * the agent, as `LiveChat.unanswered` keeps them. Sends nothing to the agent
   * when no turn runs, during the check after the prompt of a turn returned,
   * and while a pick starts the agent again and no message has joined that
   * start.
   */
  cancel(live: AnyLiveChat, input: ChatCancelInput): Promise<void>;
  answerPermission(live: AnyLiveChat, request: string, answer: PermissionAnswer): Promise<void>;
  answerQuestion(live: AnyLiveChat, request: string, answer: QuestionAnswer): Promise<void>;
  /**
   * Sets one config option on the agent of the chat. An accepted value is
   * saved in the chat and, unless `AGENT_OPTION_RULES` lists it as unsaved, as
   * the default of the agent. The picks of one chat run one after the other. A
   * chat whose session is not open yet gets the value as the session opens. A
   * chat with no agent process gets its agent started again, with no prompt
   * unless a message joins the start. Resolves with a diagnostic for each file
   * that a write missed. Refused with `option-refused` when the agent does not
   * offer or does not take the value, and with `turn-running` while the chat
   * ends for a restart.
   */
  setOption(live: AnyLiveChat, change: ChatOptionChange): Promise<Diagnostic[]>;
  /**
   * Ends the agent of the chat, and resolves when every process of the chat
   * has ended. The only event is a `background` event that clears a job or an
   * own turn. Refused with `turn-running` while a turn runs or a request of the
   * agent is open.
   */
  stop(live: AnyLiveChat): Promise<void>;
  /**
   * Cancels the turn that runs, as `cancel` does, waits up to `endGraceMs` for
   * the turn to end, and then ends the agent of the chat. A turn that does not
   * end in time is interrupted, as `close()` interrupts each chat. A turn of a
   * message is interrupted at once, with no cancel and no wait, until its
   * prompt is sent. So is the turn of a pick that starts the agent again with
   * no message, until its session is open. Between turns, the open requests
   * are cancelled in the name of `client`, and a `background` event clears a
   * job or an own turn. The end of the process writes no event.
   * Resolves when every process of the chat has ended. Until it settles, a
   * message and a pick of the chat are refused with `turn-running`.
   * Refused with `chat-not-running` when the daemon stops before it resolves.
   */
  end(live: LiveChat, input: ChatCancelInput): Promise<void>;
  /**
   * Aborts a read of the login shell in progress and does not wait for it, and
   * clears every idle timer, so no idle stop starts after it. A start that has
   * not spawned its agent yet then spawns none, a restart and a message that
   * joined a start get no prompt, a text that waits at the end of a prompt
   * gets no next prompt, and a later message is refused. `close()` does the
   * same.
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

/** A text of the chat that the agent has not got. Its identity tells it from another text with the same words. */
type Unsent = { readonly text: string };

function unsentOf(texts: readonly string[]): Unsent[] {
  return texts.map((text) => ({ text }));
}

type Run = RunningChat & {
  /** The picks that the session takes as it opens, in arrival order. */
  waiting: WaitingPick[];
  /**
   * Set for a relaunch that a pick starts, until a message joins it or its
   * session has the pick. While it is set, the session gets no prompt.
   */
  pickRelaunch: boolean;
  /** The wait for the last process and the interrupt of a restart, and of a relaunch that a pick starts. */
  reopened: Promise<void> | undefined;
  /**
   * The writes of the `user` events of the messages that came before the
   * first prompt of the run, each with the push of its text into `unsent`, in
   * message order. Each message adds its write at the end.
   */
  held: Promise<void> | undefined;
  /** The cancels of the turn before its first prompt is sent. A message records the count at its arrival. */
  earlyCancels: number;
  /** The end of the picks of the chat that came before the message that joined a pick relaunch. */
  earlierPicks: Promise<void> | undefined;
  /** Set with the process. */
  adapter: AgentAdapter | undefined;
  /** Set with the process. */
  idle: IdleTimer | undefined;
  /** Set with the process, when its adapter reports background commands. */
  background: BackgroundCommands | undefined;
  /** The `job` commands that the checks of `background` found ended since the last idle check. */
  jobsEnded: number;
  /** The last `job` of a `background` event of this run. A `user` event clears it, as the fold does. */
  job: boolean;
  /** The last `ownTurn` of a `background` event of this run. A `user` event clears it, as the fold does. */
  ownTurn: boolean;
  /** The outputs of the agent with no turn of a message. A check of a marker that sees it change has an old result. */
  outputs: number;
  /** The messages that started a turn in this run. A check that sees it change has an old result. */
  messages: number;
  /** Set from the return of a prompt of a turn until the turn ends or its next prompt is sent. */
  endCheck: boolean;
  /** Set during the check of a stop of an own turn. A check of a marker then writes nothing, so the notice stays. */
  stopCheck: boolean;
  /** Set by a stop of an own turn until the next marker or message. Output until then is late output of that turn. */
  ownTurnStopped: boolean;
  /**
   * The texts of the chat that no prompt and no steer has taken to the agent,
   * in log order. A new session takes every text.
   */
  unsent: Unsent[];
  /** The steers of the run whose answer has not come. */
  steering: Set<Promise<void>>;
  /** Set by a cancel after the prompt of the turn was sent, until the next prompt. A message then sends no steer. */
  cancelAsked: boolean;
  /** Set when the run writes no more events: at a failure, once the chat is gone, and at a stop. */
  quiet: boolean;
  /** Set at the first refusal or fault of the log. */
  halted: boolean;
  /** Set from the message that starts a turn until the turn ends. While it is clear, the session is open. */
  turning: boolean;
  /**
   * Set when `begin` reads `cancelledEarly`, after the session id is written,
   * and for a pick relaunch before its `resumed` event. Then `end` sends a
   * cancel to the agent, and so does `cancel()` while `pickRelaunch` is clear.
   * A message that joins a pick relaunch clears it.
   */
  cancelReachesAgent: boolean;
  /**
   * Set by a cancel of a turn of a message before `cancelReachesAgent`, and
   * cleared by a message after it. `begin` then sends no first prompt, and
   * ends the first turn.
   */
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

function notRunning(live: AnyLiveChat): DaemonError {
  return new DaemonError("chat-not-running", `${chatName(live)} has no agent process`);
}

function daemonStopping(live: AnyLiveChat): DaemonError {
  return new DaemonError("chat-not-running", `${chatName(live)} cannot run: the daemon is stopping`);
}

function turnRunning(live: AnyLiveChat): DaemonError {
  return new DaemonError("turn-running", `a turn of ${chatName(live)} is running`);
}

function endingForRestart(live: AnyLiveChat): DaemonError {
  return new DaemonError("turn-running", `${chatName(live)} is ending for a restart`);
}

function couldNotRun(live: AnyLiveChat, reason: string): DaemonError {
  return new DaemonError("chat-not-running", `${chatName(live)} has no agent process: ${reason}`);
}

function notOffered(live: AnyLiveChat, configId: string, value: string): DaemonError {
  return new DaemonError("option-refused", `the agent of ${chatName(live)} offers no value "${value}" for "${configId}"`);
}

function refusedBy(live: AnyLiveChat, configId: string, value: string, reason: string): DaemonError {
  return new DaemonError("option-refused", `the agent of ${chatName(live)} refused "${value}" for "${configId}": ${reason}`);
}

function answerAll(answers: PickAnswer[]): void {
  for (const answer of answers) answer();
}

function jobRuns(state: BackgroundState | undefined): boolean {
  return state?.running.some((command) => command.mark === "job") === true;
}

function newRun(live: AnyLiveChat): Run {
  return {
    live,
    process: undefined,
    session: undefined,
    open: new Map(),
    options: [],
    waiting: [],
    pickRelaunch: false,
    reopened: undefined,
    held: undefined,
    earlyCancels: 0,
    earlierPicks: undefined,
    adapter: undefined,
    idle: undefined,
    background: undefined,
    jobsEnded: 0,
    job: false,
    ownTurn: false,
    outputs: 0,
    messages: 0,
    endCheck: false,
    stopCheck: false,
    ownTurnStopped: false,
    unsent: [],
    steering: new Set(),
    cancelAsked: false,
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
  /** How long an agent of a task chat with no turn and no open request runs before it is ended. */
  idleLimit?: IdleLimit;
  /** How long an agent of a project chat with no turn and no open request runs before it is ended. */
  projectIdleMs?: number;
  /** Where a fault of a chat log is reported. */
  stderr?: { write(text: string): unknown };
  /** The config option defaults of each agent. */
  defaults: AgentDefaultsStore;
  /** How long `end` waits for a cancelled turn to end. */
  endGraceMs?: number;
  /** How long after the last activity a running `job` command keeps the agent. */
  jobHoldMs?: number;
}): ChatRunner {
  const { root, chats, adapters, env, defaults } = options;
  const endGraceMs = options.endGraceMs ?? END_GRACE_MS;
  const jobHoldMs = options.jobHoldMs ?? JOB_HOLD_MS;
  const spawn = options.spawn ?? spawnAgent;
  const shellEnv = options.shellEnv ?? ((signal) => readShellEnv(env, { signal }));
  const idleLimit = options.idleLimit ?? (() => Promise.resolve(AGENT_STEP_IDLE_MS));
  const projectIdleMs = options.projectIdleMs ?? PROJECT_CHAT_IDLE_MS;
  const stderr = options.stderr ?? process.stderr;
  const files = optionFiles({ root, defaults, stderr });
  const runs = new Map<AnyLiveChat, Run>();
  /** Every agent process that has not exited, also of a chat that no longer runs. */
  const alive = new Set<AgentProcess>();
  /** For the last agent process of each chat: its `ended`, and the handling of its exit. */
  const ends = new WeakMap<AnyLiveChat, Promise<unknown>>();
  /** The last run of each chat in this daemon. */
  const lastRuns = new WeakMap<AnyLiveChat, Run>();
  /** The end of the last pick of each chat that has not ended, which the next pick of the chat waits for. */
  const picks = new WeakMap<AnyLiveChat, Promise<void>>();
  /** The chats whose `end` has not settled. */
  const ending = new WeakSet<AnyLiveChat>();
  /** The text that the next prompt of each chat begins with, after an idle stop ended background commands. */
  const notes = new WeakMap<AnyLiveChat, string>();
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

  function report(live: AnyLiveChat, error: unknown): void {
    if (error instanceof TaskStoreError && GONE.has(error.code)) return;
    stderr.write(chatFault(live, error));
  }

  function register(live: AnyLiveChat): Run {
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

  /** Resolves when no steer of the run waits for its answer, also a steer that starts during the wait. */
  async function steersAnswered(run: Run): Promise<void> {
    while (run.steering.size > 0) await Promise.all(run.steering);
  }

  /** Resolves when each message that joins the start has written, also a message that joins during the wait. */
  async function heldWritten(run: Run): Promise<void> {
    let held: Promise<void> | undefined;
    while (held !== run.held) {
      held = run.held;
      await held?.catch(() => undefined);
    }
  }

  /** Gives the text to the turn that runs. A text that the agent does not take stays in `unsent`. */
  function steer(run: Run, session: AgentSession, entry: Unsent): void {
    const answered = session.steer(entry.text).then(
      (outcome) => {
        if (outcome === "injected") run.unsent = run.unsent.filter((one) => one !== entry);
      },
      (error: unknown) => {
        // The exit of the process reports a closed connection.
        if (error instanceof AgentClosed) return;
        stderr.write(chatFault(run.live, `the steer of a message failed: ${errorReason(run.adapter!, error)}`));
      },
    );
    run.steering.add(answered);
    void answered.then(() => run.steering.delete(answered));
  }

  /**
   * Sends the texts of `unsent` as one prompt. A text that waits when the
   * prompt returns goes as the next prompt of the same turn, so the turn ends
   * only when no text waits.
   */
  async function runTurn(run: Run, session: AgentSession): Promise<void> {
    const text = run.unsent.map((one) => one.text).join("\n\n");
    run.unsent = [];
    run.cancelAsked = false;
    const note = notes.get(run.live);
    notes.delete(run.live);
    const result = await send(run, () => session.prompt(note === undefined ? text : `${note}\n\n${text}`));
    if (result === undefined) return;
    run.endCheck = true;
    const state = await backgroundState(run);
    // An injected text leaves `unsent` at the answer of its steer, which can come after the prompt result.
    await steersAnswered(run);
    run.endCheck = false;
    if (run.unsent.length > 0 && !run.quiet) {
      // The run stays in its turn, for `close()`.
      if (stopping.signal.aborted) return;
      return runTurn(run, session);
    }
    // In the log before `turn-end`, so the state does not change to "Needs you" for a moment.
    if (jobRuns(state)) void setBackground(run, true, false);
    await endTurn(run, result.stopReason);
  }

  /** Writes a `background` event when a value changes. The write starts in this step, so the event keeps its place. */
  function setBackground(run: Run, job: boolean, ownTurn: boolean, stopReason?: string): Promise<void> {
    if (run.quiet || (run.job === job && run.ownTurn === ownTurn)) return Promise.resolve();
    run.job = job;
    run.ownTurn = ownTurn;
    return append(run, { kind: "background", job, ownTurn, ...(stopReason === undefined ? {} : { stopReason }) });
  }

  /** Writes the state at the end of an own turn. A stop keeps its result after new output, and not after a message. */
  async function settleBackground(run: Run, stopReason?: string): Promise<void> {
    const { outputs, messages } = run;
    const stops = stopReason !== undefined;
    if (stops) run.stopCheck = true;
    const state = await backgroundState(run);
    if (stops) run.stopCheck = false;
    if (state === undefined || run.quiet || runs.get(run.live) !== run || run.messages !== messages) return;
    if (!stops && (run.outputs !== outputs || run.stopCheck)) return;
    await setBackground(run, jobRuns(state), false, stopReason);
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
        run.background?.note(update);
        run.options = foldOptions(run.options, update);
        const ownTurnPossible = !run.turning && run.background !== undefined;
        if (ownTurnPossible && OWN_TURN_OUTPUT.has(update.sessionUpdate)) {
          run.outputs += 1;
          if (!run.ownTurnStopped) void setBackground(run, run.job, true);
        }
        void append(run, { kind: "update", update: adapter.filterUpdate(update) });
        if (ownTurnPossible && run.background?.ownTurnEnded(update) === true) {
          run.ownTurnStopped = false;
          // Two jobs that end together give a marker with no output before the turn that reports them.
          if (run.ownTurn) void settleBackground(run);
        }
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
    const meta = run.adapter!.sessionMeta;
    if (stored !== undefined) {
      const resumed = await send(run, () => connection.resume(folder, stored, meta).catch((error: unknown) => {
        if (error instanceof SessionNotFound) return "lost" as const;
        throw error;
      }));
      if (resumed === undefined) return undefined;
      if (resumed !== "lost") return { session: resumed, created: false };
      if (live.answered) {
        await fail(run, isProjectChat(live) ? run.adapter!.projectSessionGone : run.adapter!.sessionGone);
        return undefined;
      }
    }
    run.unsent = unsentOf(live.unanswered);
    const session = await send(run, () => connection.create(folder, meta));
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
      if (reason !== undefined) stderr.write(chatFault(live, `the agent refused "${value}" for "${configId}": ${reason}`));
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
    if (run.pickRelaunch) {
      run.cancelReachesAgent = true;
      // A pick takes a failed chat out of its stop, as a message does.
      if (run.live.fold.stopped !== undefined) await append(run, { kind: "resumed" });
    }
    // A message can join during the write of `resumed`.
    if (run.pickRelaunch) {
      run.pickRelaunch = false;
      run.turning = false;
      run.turnEnded?.();
      run.idle?.touch();
      return answerAll(answers);
    }
    answerAll(answers);
    if (run.held !== undefined) {
      // Only after `answerAll`: the earlier picks wait for the answer of the pick of the relaunch.
      await run.earlierPicks;
      await heldWritten(run);
      // Once the daemon stops, `pickNow` refuses the earlier picks. The run stays in a turn for `close()`.
      if (run.quiet || stopping.signal.aborted) return;
      // The `user` event of a message can come after `openSession` took the texts.
      if (opened.created) run.unsent = unsentOf(run.live.unanswered);
    }
    run.cancelReachesAgent = true;
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
    else void setBackground(run, false, false);
    forget(run);
  }

  /**
   * The background commands of the run that still run, or undefined when its
   * adapter does not track background commands. Every call of `running()`
   * goes through here, so that no caller hides an ended job from the next
   * idle check. A failed check counts as no command running.
   */
  async function backgroundState(run: Run): Promise<BackgroundState | undefined> {
    if (run.background === undefined) return undefined;
    const state = await run.background.running().catch((error: unknown) => {
      report(run.live, error);
      return { running: [], jobsEnded: 0 };
    });
    run.jobsEnded += state.jobsEnded;
    return state;
  }

  /**
   * The idle stop. A running job, an own turn, or a job that ended since the
   * last check gives one more limit, until `jobHoldMs` after the last activity.
   * The write of `setBackground` is not awaited: a message can start a turn
   * during an await, and `quit` then ends that turn with no event.
   */
  async function idleCheck(run: Run, idle: IdleTimer): Promise<void> {
    const touches = idle.touches();
    const state = await backgroundState(run);
    if (state === undefined) return quit(run);
    if (run.quiet || runs.get(run.live) !== run || stopping.signal.aborted) return;
    if (run.turning || run.open.size > 0 || idle.touches() !== touches) return;
    const ended = run.jobsEnded;
    run.jobsEnded = 0;
    const jobs = state.running.filter((command) => command.mark === "job");
    const others = state.running.filter((command) => command.mark !== "job");
    if (jobs.length === 0) void setBackground(run, false, run.ownTurn);
    const held = (jobs.length > 0 || run.ownTurn) && idle.idleMs() < jobHoldMs;
    if (held || (jobs.length === 0 && ended > 0)) return idle.rearm();
    if (state.running.length > 0) notes.set(run.live, stopNote([...jobs, ...others]));
    if (jobs.length > 0) return fail(run, holdReason(jobs, others, jobHoldMs));
    if (run.ownTurn) return fail(run, ownTurnReason(jobHoldMs));
    await quit(run);
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
    run.background = adapter.backgroundCommands?.((cause) => stderr.write(chatFault(run.live, cause)));
    const idle = idleTimer({
      limitMs,
      busy: () => run.turning || run.open.size > 0,
      expire: () => void idleCheck(run, idle),
    });
    run.idle = idle;
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
    const { agent, folder } = live.chat;
    const adapter = adapters.find((one) => one.agent === agent);
    if (adapter === undefined) return fail(run, `Tasma cannot run ${agent} yet`);
    if (!(await isDirectory(folder))) {
      const next = isProjectChat(live) ? "Start a new chat." : "Start a new chat for this step.";
      return fail(run, `The folder of this chat no longer exists: ${folder}. ${next}`);
    }
    const launch = await launchOf(adapter);
    const limitMs = isProjectChat(live) ? projectIdleMs : await idleLimit(live.tag, live.chat.task, live.chat.step);
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

  function refuseIfStopping(run: Run): void {
    if (!stopping.signal.aborted) return;
    const error = daemonStopping(run.live);
    silence(run, error);
    throw error;
  }

  /** As `refuseIfStopping`, but a run with a turn in the log stays for `close()`, which interrupts it. */
  function refuseJoinIfStopping(run: Run): void {
    if (!stopping.signal.aborted) return;
    const error = daemonStopping(run.live);
    if (chatBusy(run.live.fold)) {
      for (const pick of run.waiting.splice(0)) pick.reject(error);
    } else {
      silence(run, error);
    }
    throw error;
  }

  /** A restart that the daemon stop or an `end` overtakes before its `user` event writes nothing more. */
  function refuseIfOvertaken(run: Run): void {
    refuseIfStopping(run);
    if (!run.quiet) return;
    const error = endingForRestart(run.live);
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
    // A cancel during the wait drops them in a chat with an answer, as `LiveChat.unanswered` does.
    run.unsent = run.earlyCancels > 0 && live.answered ? [] : [...(last?.unsent ?? unsentOf(live.unanswered))];
    refuseIfOvertaken(run);
    await haltOnFault(run, () => live.interrupt());
    refuseIfOvertaken(run);
  }

  /**
   * Registered before the first await, so a second message joins the start
   * and `close()` sees the chat. Two processes never run on one session.
   */
  async function restart(live: AnyLiveChat, text: string, client: string): Promise<void> {
    const last = lastRuns.get(live);
    const run = register(live);
    run.reopened = reopen(run, last);
    await hold(run, text, client);
    void relaunch(run);
  }

  /**
   * As `restart`, with a pick in the place of the message: the run writes no
   * `user` event and sends no prompt, and stays in a turn until the session
   * has the pick. A message that joins it adds its `user` event and a turn, as
   * `restart` does.
   */
  async function relaunchForPick(live: AnyLiveChat, pick: WaitingPick): Promise<void> {
    const last = lastRuns.get(live);
    const run = register(live);
    run.pickRelaunch = true;
    run.waiting.push(pick);
    run.reopened = reopen(run, last);
    try {
      await run.reopened;
    } catch {
      // The end of the run refused the pick.
      return;
    }
    void relaunch(run);
  }

  /**
   * The part of a message that joins the start of the agent: after the writes
   * of the messages before it and the interrupt of the start, it writes its
   * `user` event and puts its text in `unsent`. A cancel after the message
   * drops the text in a chat with an answer, as `LiveChat.unanswered` does.
   */
  function hold(run: Run, text: string, client: string): Promise<void> {
    run.cancelledEarly = false;
    const cancels = run.earlyCancels;
    const before = run.held;
    const held = (async () => {
      await before?.catch(() => undefined);
      await run.reopened;
      refuseJoinIfStopping(run);
      // The run ended during the wait.
      if (run.quiet) return message(run.live, { text, client });
      await record(run, { kind: "user", text, client });
      if (run.earlyCancels === cancels || !run.live.answered) run.unsent.push({ text });
    })();
    run.held = held;
    return held;
  }

  async function message(live: AnyLiveChat, { text, client }: ChatMessageInput): Promise<void> {
    if (ending.has(live)) throw endingForRestart(live);
    if (stopping.signal.aborted) throw daemonStopping(live);
    const run = runs.get(live);
    if (run === undefined) return restart(live, text, client);
    if (run.pickRelaunch) {
      run.pickRelaunch = false;
      run.cancelReachesAgent = false;
      run.earlierPicks = picks.get(live);
      return hold(run, text, client);
    }
    if (!run.turning) return startTurn(run, text, client);
    if (!run.cancelReachesAgent) return hold(run, text, client);
    return joinTurn(run, text, client);
  }

  /** A message to a turn whose prompt is sent. The agent gets the text by a steer, or else as the next prompt. */
  async function joinTurn(run: Run, text: string, client: string): Promise<void> {
    const entry = { text };
    run.unsent.push(entry);
    run.job = false;
    run.ownTurn = false;
    run.idle?.touch();
    const written = record(run, { kind: "user", text, client });
    if (!run.cancelAsked) steer(run, run.session!, entry);
    await written;
  }

  /** A message to a run whose session is open and in no turn. */
  async function startTurn(run: Run, text: string, client: string): Promise<void> {
    run.turning = true;
    run.job = false;
    run.ownTurn = false;
    run.ownTurnStopped = false;
    run.messages += 1;
    run.idle?.touch();
    run.unsent.push({ text });
    const written = record(run, { kind: "user", text, client });
    void runTurn(run, run.session!);
    await written;
  }

  async function pickNow(live: AnyLiveChat, { configId, value }: ChatOptionChange): Promise<Diagnostic[]> {
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
   * interrupt of a turn that still runs, or for a run with no turn the
   * cancelled resolutions of the open requests, in the name of `client`, and
   * the `background` event that clears its values. The end of the process
   * writes no event.
   */
  function endNow(run: Run, client: string): Promise<unknown>[] {
    const writes: Promise<unknown>[] = [];
    if (!run.turning) writes.push(...cancelOpen(run, client), setBackground(run, false, false));
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
      run.cancelAsked = true;
      run.unsent = [];
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
  function pending(live: AnyLiveChat, request: string, kind: RequestKind): { run: Run; open: OpenRequest } {
    const run = runs.get(live);
    const open = run?.open.get(request);
    if (run === undefined && live.fold.open.includes(request)) throw notRunning(live);
    if (run === undefined || open === undefined) {
      throw new DaemonError("already-answered", `request ${request} of ${chatName(live)} is not open`);
    }
    if (open.kind !== kind) {
      throw new DaemonError(
        "malformed-request",
        `request ${request} of ${chatName(live)} is a ${KIND_NAME[open.kind]}, not a ${KIND_NAME[kind]}`,
      );
    }
    return { run, open };
  }

  /** The adapter and the folder of a new chat, or the `ChatStartRefusal` of the start. */
  async function startSetup(tag: string, agent: ChatAgent): Promise<{ adapter: AgentAdapter; path: string }> {
    const adapter = adapters.find((one) => one.agent === agent);
    if (adapter === undefined) throw new ChatStartRefusal("agent-not-supported", `Tasma cannot run ${agent} yet`);
    const { path } = await readProjectDeclaration({ project: tag, root });
    if (path === undefined || !(await isDirectory(path))) {
      throw new ChatStartRefusal("project-has-no-folder", `project ${tag} has no folder for an agent to work in`);
    }
    return { adapter, path };
  }

  /** Starts the agent of a chat just created, unless the daemon stops or the launch failed. */
  async function launchCreated(
    live: AnyLiveChat,
    adapter: AgentAdapter,
    launch: AgentLaunch | { failed: string },
    folder: string,
    limitMs: number,
  ): Promise<void> {
    // After `stopStarts()`, the chat stays with no agent, as a daemon stop leaves every other chat.
    if (stopping.signal.aborted) return;
    if ("failed" in launch) {
      try {
        await live.append({ kind: "failed", reason: launch.failed });
      } catch (error) {
        report(live, error);
      }
      return;
    }

    const run = register(live);
    void begin(run, spawnRun(run, adapter, launch, folder, limitMs));
  }

  return {
    async start({ tag, task, step, agent, text, client }) {
      const { adapter, path } = await startSetup(tag, agent);
      const launch = await launchOf(adapter);
      const limitMs = await idleLimit(tag, task, step);
      const live = await chats.create(tag, task, { step, agent, folder: path }, { text, client });
      await launchCreated(live, adapter, launch, path, limitMs);
      return live;
    },

    async startProjectChat({ tag, title, agent, text, client }) {
      const { adapter, path } = await startSetup(tag, agent);
      const launch = await launchOf(adapter);
      const live = await chats.createProjectChat(tag, { title, agent, folder: path }, { text, client });
      await launchCreated(live, adapter, launch, path, projectIdleMs);
      return live;
    },

    running(live) {
      return runs.get(live);
    },

    message,

    async cancel(live, { client }) {
      const run = runs.get(live);
      if (run?.ownTurn && !run.turning) {
        run.ownTurnStopped = true;
        // ACP wants `session/cancel` before the cancelled responses.
        run.session!.cancel();
        await Promise.all([...cancelOpen(run, client), settleBackground(run, "cancelled")]);
        return;
      }
      // A pick relaunch that no message joined has no turn of a message to cancel.
      if (!run?.turning || run.pickRelaunch) return;
      if (run.cancelReachesAgent) {
        run.cancelAsked = true;
        run.unsent = [];
        // The prompt has returned, and a `session/cancel` with no prompt can lose the later report of a job.
        if (run.endCheck) return;
        // ACP wants `session/cancel` before the cancelled responses.
        run.session!.cancel();
      } else {
        run.cancelledEarly = true;
        run.earlyCancels += 1;
        // As `LiveChat.unanswered` does at a cancelled turn end.
        if (run.live.answered) run.unsent = [];
      }
      await Promise.all(cancelOpen(run, client));
    },

    async answerPermission(live, request, { optionId, client }) {
      const { run, open } = pending(live, request, "permission");
      if (!offers(open.params, optionId)) {
        throw new DaemonError("malformed-request", `permission request ${request} of ${chatName(live)} offers no option "${optionId}"`);
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
        if (run.open.size > 0) throw new DaemonError("turn-running", `${chatName(live)} has a request open`);
        const cleared = setBackground(run, false, false);
        void quit(run);
        await cleared;
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
