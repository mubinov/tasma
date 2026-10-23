// The agents of the chats. One chat has one agent process, which the daemon
// owns: the runner starts it with the first message of the chat, writes every
// event of the agent into the chat log, and ends the process. The commands of
// the clients on a chat run here too: a message, a cancel and an answer.

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { RequestError } from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { readProjectDeclaration, TaskStoreError } from "@tasma/engine";
import type { TaskStoreErrorCode } from "@tasma/engine";
import { DAEMON_NAME, printable } from "@tasma/protocol";
import type {
  AcpObject,
  ChatAgent,
  ChatCancelInput,
  ChatEvent,
  ChatMessageInput,
  PermissionAnswer,
  QuestionAnswer,
} from "@tasma/protocol";
import { AgentClosed, connectAgent, spawnAgent } from "../agents/acp.js";
import type { AgentConnection, AgentEnd, AgentHandlers, AgentProcess, AgentSession } from "../agents/acp.js";
import type { AgentAdapter, AgentEnv, AgentLaunch } from "../agents/adapter.js";
import { causeOf, DaemonError } from "../http/failure.js";
import type { ChatRegistry, LiveChat } from "./registry.js";

const AUTH_REQUIRED = RequestError.authRequired().code;

/** The refusals of a chat write that mean the chat is gone: a delete of its project or of its task. */
const GONE: ReadonlySet<TaskStoreErrorCode> = new Set(["chat-not-found", "task-not-found", "project-not-found"]);

/** The outcome of a permission request and the answer to a question that nobody gives. */
const CANCELLED = {
  permission: { outcome: "cancelled" },
  question: { action: "cancel" },
} as const satisfies Record<OpenRequest["kind"], AcpObject>;

const KIND_NAME = { permission: "permission request", question: "question" } as const;

export class ChatStartRefusal extends Error {
  readonly code: "agent-not-supported" | "project-has-no-folder";

  constructor(code: ChatStartRefusal["code"], message: string) {
    super(message);
    this.name = "ChatStartRefusal";
    this.code = code;
  }
}

export type OpenRequest = {
  kind: "permission" | "question";
  /** The params of the request, as the SDK gives them. */
  params: AcpObject;
  /** Sends the response to the agent. Only the runner calls it, once, after it takes the request out of `open`. */
  answer(result: AcpObject): void;
};

export type RunningChat = {
  live: LiveChat;
  process: AgentProcess;
  /** Set once the agent has opened the session. */
  session: AgentSession | undefined;
  /** The requests of the agent that wait for an answer, keyed by the `request` of their log event, in open order. */
  open: Map<string, OpenRequest>;
};

/**
 * Each command resolves when its events are in the log. A refusal is a
 * `DaemonError`. A fault of the log rejects the command after the run halts.
 */
export type ChatRunner = {
  /**
   * Creates the chat with its first message, so it is `working`, and starts
   * its agent in the background. A `ChatStartRefusal` comes before the chat is
   * created.
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
  /** Writes the `user` event and starts a turn with the text. */
  message(live: LiveChat, input: ChatMessageInput): Promise<void>;
  /**
   * Cancels the turn that runs and resolves its open requests in the name of
   * `client`. Does nothing when no turn runs.
   */
  cancel(live: LiveChat, input: ChatCancelInput): Promise<void>;
  answerPermission(live: LiveChat, request: string, answer: PermissionAnswer): Promise<void>;
  answerQuestion(live: LiveChat, request: string, answer: QuestionAnswer): Promise<void>;
  /** Ends every agent process and waits until all have exited, with no event in any log. */
  close(): Promise<void>;
};

type Run = RunningChat & {
  adapter: AgentAdapter;
  /** The requests to the agent that have not settled. */
  requests: number;
  /** Set when the run writes no more events: at a failure, once the chat is gone, and at a daemon stop. */
  quiet: boolean;
  /** Set at the first refusal or fault of the log. */
  halted: boolean;
  /** Set from the message that starts a turn to its prompt result. While it is clear, the session is open. */
  turning: boolean;
  /** Set when `begin` reads `cancelledEarly`, after the session id is written. Then a cancel goes to the agent. */
  cancelReachesAgent: boolean;
  /** Set by a cancel before `cancelReachesAgent`. `begin` then sends no first prompt, and ends the first turn. */
  cancelledEarly: boolean;
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

/** A resolution with no `client` is one of the daemon. */
function resolution(kind: OpenRequest["kind"], request: string, result: AcpObject, client?: string): ChatEvent {
  const by = client === undefined ? {} : { client };
  return kind === "permission"
    ? { kind: "permission-resolved", request, outcome: result, ...by }
    : { kind: "question-resolved", request, answer: result, ...by };
}

function notRunning(live: LiveChat): DaemonError {
  return new DaemonError("chat-not-running", `${nameOf(live)} has no agent process`);
}

export function createChatRunner(options: {
  root?: string;
  chats: ChatRegistry;
  adapters: readonly AgentAdapter[];
  /** The environment of the daemon, which each launch starts from. */
  env: AgentEnv;
  spawn?: (launch: AgentLaunch, folder: string) => AgentProcess;
  /** Where a fault of a chat log is reported. */
  stderr?: { write(text: string): unknown };
}): ChatRunner {
  const { root, chats, adapters, env } = options;
  const spawn = options.spawn ?? spawnAgent;
  const stderr = options.stderr ?? process.stderr;
  const runs = new Map<LiveChat, Run>();
  /** Every agent process that has not exited, also of a chat that no longer runs. */
  const alive = new Set<AgentProcess>();
  let closing = false;

  function report(live: LiveChat, error: unknown): void {
    if (error instanceof TaskStoreError && GONE.has(error.code)) return;
    stderr.write(`${DAEMON_NAME}: ${printable(`${nameOf(live)}: ${causeOf(error)}`)}\n`);
  }

  function forget(run: Run): void {
    if (runs.get(run.live) === run) runs.delete(run.live);
    run.open.clear();
  }

  function silence(run: Run): void {
    run.quiet = true;
    forget(run);
  }

  /** After a refusal or a fault of the log: the run writes nothing more, and its process ends. */
  async function halt(run: Run, error: unknown): Promise<void> {
    if (!run.halted) report(run.live, error);
    run.halted = true;
    silence(run);
    await run.process.end();
  }

  /** Rejects with a fault of the log after the run halts. */
  async function record(run: Run, event: ChatEvent): Promise<void> {
    try {
      await run.live.append(event);
    } catch (error) {
      await halt(run, error);
      throw error;
    }
  }

  async function append(run: Run, event: ChatEvent): Promise<void> {
    await record(run, event).catch(() => undefined);
  }

  async function fail(run: Run, reason: string): Promise<void> {
    if (run.quiet) return;
    silence(run);
    await append(run, { kind: "failed", reason });
    await run.process.end();
  }

  /**
   * After `AgentClosed` the process can still run, for example when the SDK
   * closed the connection at a message over its size limit, so it is ended
   * before its end is read.
   */
  async function failWith(run: Run, error: unknown): Promise<void> {
    if (!(error instanceof AgentClosed)) return fail(run, errorReason(run.adapter, error));
    await run.process.end();
    await fail(run, endReason(await run.process.ended));
  }

  /** Sends one request to the agent. A failure of it fails the run, and gives undefined. */
  async function send<T>(run: Run, call: () => Promise<T>): Promise<T | undefined> {
    run.requests += 1;
    try {
      return await call();
    } catch (error) {
      await failWith(run, error);
      return undefined;
    } finally {
      run.requests -= 1;
    }
  }

  /** Takes the request out of `open`, writes its resolution, and then sends the response to the agent. */
  function settle(run: Run, request: string, open: OpenRequest, result: AcpObject, client?: string): Promise<void> {
    run.open.delete(request);
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
    await append(run, { kind: "turn-end", stopReason });
  }

  async function runTurn(run: Run, session: AgentSession, text: string): Promise<void> {
    const result = await send(run, () => session.prompt(text));
    if (result !== undefined) await endTurn(run, result.stopReason);
  }

  /** Each handler appends before its first await, so the log keeps the order in which the handlers run. */
  function handlersOf(run: Run): AgentHandlers {
    function ask(kind: OpenRequest["kind"]) {
      return (params: AcpObject, answer: (result: AcpObject) => void): () => void => {
        const request = randomUUID();
        if (!run.quiet) {
          run.open.set(request, { kind, params, answer });
          void append(run, kind === "permission" ? { kind, request, permission: params } : { kind, request, question: params });
        }
        return () => {
          if (!run.open.delete(request)) return;
          void append(run, resolution(kind, request, CANCELLED[kind]));
        };
      };
    }

    return {
      update(update) {
        if (!run.quiet) void append(run, { kind: "update", update: run.adapter.filterUpdate(update) });
      },
      permission: ask("permission"),
      question: ask("question"),
    };
  }

  async function begin(run: Run, connection: AgentConnection, folder: string, text: string): Promise<void> {
    const session = await send(run, () => connection.open(folder));
    if (session === undefined) return;
    run.session = session;
    try {
      await run.live.setSession(session.sessionId);
    } catch (error) {
      await halt(run, error);
      return;
    }
    run.cancelReachesAgent = true;
    if (run.cancelledEarly) await endTurn(run, "cancelled");
    else await runTurn(run, session, text);
  }

  /** The open request an answer takes. The caller takes it out of `open` in the same synchronous step. */
  function pending(live: LiveChat, request: string, kind: OpenRequest["kind"]): { run: Run; open: OpenRequest } {
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

  /**
   * Runs after the exit and the close of the connection, so after the handlers
   * of every message the agent sent. An exit while a request runs is written by
   * the failure of that request.
   */
  function onExit(run: Run, end: AgentEnd): void {
    alive.delete(run.process);
    forget(run);
    if (run.requests === 0 && !cleanExit(end)) void fail(run, endReason(end));
  }

  return {
    async start({ tag, task, step, agent, text, client }) {
      const adapter = adapters.find((one) => one.agent === agent);
      if (adapter === undefined) throw new ChatStartRefusal("agent-not-supported", `Tasma cannot run ${agent} yet`);
      const { path } = await readProjectDeclaration({ project: tag, root });
      if (path === undefined || !(await isDirectory(path))) {
        throw new ChatStartRefusal("project-has-no-folder", `project ${tag} has no folder for an agent to work in`);
      }

      const live = await chats.create(tag, task, { step, agent, folder: path }, { text, client });
      // After `close()`, the chat stays with no agent, as a daemon stop leaves every other chat.
      if (closing) return live;
      const launch = adapter.launch(env);
      if ("failed" in launch) {
        try {
          await live.append({ kind: "failed", reason: launch.failed });
        } catch (error) {
          report(live, error);
        }
        return live;
      }

      // Registered in the same step as the spawn, so `close()` sees every process.
      const agentProcess = spawn(launch, path);
      const run: Run = {
        live,
        process: agentProcess,
        session: undefined,
        open: new Map(),
        adapter,
        requests: 0,
        quiet: false,
        halted: false,
        turning: true,
        cancelReachesAgent: false,
        cancelledEarly: false,
      };
      runs.set(live, run);
      alive.add(agentProcess);
      const connection = connectAgent(agentProcess.stream, handlersOf(run));
      // With its connection closed, the process can take no more requests.
      void connection.closed.then(() => agentProcess.end());
      void Promise.all([agentProcess.ended, connection.closed]).then(([end]) => onExit(run, end));
      void begin(run, connection, path, text);
      return live;
    },

    running(live) {
      return runs.get(live);
    },

    async message(live, { text, client }) {
      const run = runs.get(live);
      if (run === undefined) throw notRunning(live);
      if (run.turning) throw new DaemonError("turn-running", `a turn of ${nameOf(live)} is running`);
      run.turning = true;
      const written = record(run, { kind: "user", text, client });
      void runTurn(run, run.session!, text);
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

    async close() {
      closing = true;
      for (const run of [...runs.values()]) silence(run);
      await Promise.all([...alive].map((agentProcess) => agentProcess.end()));
    },
  };
}
