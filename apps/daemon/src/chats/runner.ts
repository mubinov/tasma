// The agents of the chats. One chat has one agent process, which the daemon
// owns: the runner starts it with the first message of the chat, writes every
// event of the agent into the chat log, and ends the process.

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { RequestError } from "@agentclientprotocol/sdk";
import { readProjectDeclaration, TaskStoreError } from "@tasma/engine";
import type { TaskStoreErrorCode } from "@tasma/engine";
import { DAEMON_NAME, printable } from "@tasma/protocol";
import type { AcpObject, ChatAgent, ChatEvent } from "@tasma/protocol";
import { AgentClosed, connectAgent, spawnAgent } from "../agents/acp.js";
import type { AgentConnection, AgentEnd, AgentHandlers, AgentProcess, AgentSession } from "../agents/acp.js";
import type { AgentAdapter, AgentEnv, AgentLaunch } from "../agents/adapter.js";
import { causeOf } from "../http/failure.js";
import type { ChatRegistry, LiveChat } from "./registry.js";

const AUTH_REQUIRED = RequestError.authRequired().code;

/** The refusals of a chat write that mean the chat is gone: a delete of its project or of its task. */
const GONE: ReadonlySet<TaskStoreErrorCode> = new Set(["chat-not-found", "task-not-found", "project-not-found"]);

export class ChatStartRefusal extends Error {
  readonly code: "agent-not-supported" | "project-has-no-folder";

  constructor(code: ChatStartRefusal["code"], message: string) {
    super(message);
    this.name = "ChatStartRefusal";
    this.code = code;
  }
}

export type OpenRequest = { kind: "permission" | "question"; answer(result: AcpObject): void };

export type RunningChat = {
  live: LiveChat;
  process: AgentProcess;
  /** Set once the agent has opened the session. */
  session: AgentSession | undefined;
  /** The requests of the agent that wait for an answer, keyed by the `request` of their log event. */
  open: Map<string, OpenRequest>;
  /**
   * Prompts the agent and writes the end of the turn, or the failure of the
   * chat. Rejects only when the session is not open yet.
   */
  turn(text: string): Promise<void>;
};

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
    const { task, chat } = live.chat;
    stderr.write(`${DAEMON_NAME}: ${printable(`chat ${chat} of ${task}: ${causeOf(error)}`)}\n`);
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

  async function append(run: Run, event: ChatEvent): Promise<void> {
    try {
      await run.live.append(event);
    } catch (error) {
      await halt(run, error);
    }
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

  async function runTurn(run: Run, session: AgentSession, text: string): Promise<void> {
    const result = await send(run, () => session.prompt(text));
    if (result !== undefined && !run.quiet) await append(run, { kind: "turn-end", stopReason: result.stopReason });
  }

  /** Each handler appends before its first await, so the log keeps the order in which the handlers run. */
  function handlersOf(run: Run): AgentHandlers {
    function ask(kind: OpenRequest["kind"]) {
      return (params: AcpObject, answer: (result: AcpObject) => void): () => void => {
        const request = randomUUID();
        if (!run.quiet) {
          run.open.set(request, {
            kind,
            answer(result) {
              if (run.open.delete(request)) answer(result);
            },
          });
          void append(run, kind === "permission" ? { kind, request, permission: params } : { kind, request, question: params });
        }
        return () => {
          if (!run.open.delete(request)) return;
          void append(run, kind === "permission"
            ? { kind: "permission-resolved", request, outcome: { outcome: "cancelled" } }
            : { kind: "question-resolved", request, answer: { action: "cancel" } });
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
    await runTurn(run, session, text);
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
        turn(next) {
          const { session } = run;
          if (session === undefined) return Promise.reject(new Error("the agent session has not started"));
          return runTurn(run, session, next);
        },
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

    async close() {
      closing = true;
      for (const run of [...runs.values()]) silence(run);
      await Promise.all([...alive].map((agentProcess) => agentProcess.end()));
    },
  };
}
