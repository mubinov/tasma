// The ACP client of a chat: the agent process, and the connection to it over
// its stdin and stdout.

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  AnyMessage,
  CreateElicitationResponse,
  RequestPermissionResponse,
  SessionConfigOption,
  Stream,
} from "@agentclientprotocol/sdk";
import type { AcpObject } from "@tasma/protocol";
import type { AgentLaunch } from "./adapter.js";
import { endGroup } from "./process.js";

const REQUEST_CANCELLED = RequestError.requestCancelled().code;

const RESOURCE_NOT_FOUND = RequestError.resourceNotFound().code;

export type AgentEnd = { code: number | null; signal: NodeJS.Signals | null } | { error: Error };

export type AgentProcess = {
  stream: Stream;
  /** Resolves one time with the exit of the process, or when it cannot start. */
  exited: Promise<AgentEnd>;
  /** Resolves as `exited` does, once every process of the group of the process has ended too. */
  ended: Promise<AgentEnd>;
  /**
   * Closes stdin, and kills the group of the process if it has not ended
   * after a grace time. Resolves as `ended` does.
   */
  end(): Promise<void>;
};

export type AgentSession = {
  sessionId: string;
  /** The config options of the session as it opened; `[]` when the agent gives none. */
  configOptions: SessionConfigOption[];
  /** Gives the full list after the change. A refusal of the agent rejects with its `RequestError`. */
  setConfigOption(configId: string, value: string): Promise<SessionConfigOption[]>;
  prompt(text: string): Promise<{ stopReason: string }>;
  /** Sends `session/cancel`. Never throws: a send that fails means that the connection closes. */
  cancel(): void;
};

export type AgentConnection = {
  /** Resolves when the connection closes, after the handlers of every message the agent sent before. */
  closed: Promise<void>;
  /** The first request on a connection. */
  initialize(): Promise<void>;
  /** Opens a new session in `folder`. */
  create(folder: string): Promise<AgentSession>;
  /** Opens a session of an earlier process again. Rejects with `SessionNotFound` when the agent no longer has it. */
  resume(folder: string, sessionId: string): Promise<AgentSession>;
};

/**
 * Takes a request of the agent that waits for a person, with the function that
 * answers it. Gives the function to call when the agent cancels the request.
 */
type AgentRequestHandler = (params: AcpObject, answer: (result: AcpObject) => void) => () => void;

export type AgentHandlers = {
  update(update: AcpObject): void;
  permission: AgentRequestHandler;
  question: AgentRequestHandler;
};

/** A request to the agent failed because the connection or the process ended. */
export class AgentClosed extends Error {
  constructor() {
    super("the agent connection closed");
    this.name = "AgentClosed";
  }
}

/** The agent refused to resume a session with `resource_not_found` (-32002). */
export class SessionNotFound extends Error {
  constructor(sessionId: string) {
    super(`the agent has no session ${sessionId}`);
    this.name = "SessionNotFound";
  }
}

/** A process that did not start. Its connection closes at once. */
function notStarted(ended: Promise<AgentEnd>): AgentProcess {
  const done = ended.then(() => undefined);
  return {
    stream: {
      readable: new ReadableStream<AnyMessage>({ start: (controller) => controller.close() }),
      writable: new WritableStream<AnyMessage>(),
    },
    exited: ended,
    ended,
    end: () => done,
  };
}

/**
 * The process has a group of its own, so the signals of a terminal that runs
 * the daemon do not reach it. It still exits when its stdin closes. At its
 * exit, whatever the cause, the end of its group starts.
 */
export function spawnAgent(launch: AgentLaunch, folder: string): AgentProcess {
  let child: ChildProcessByStdio<Writable, Readable, null>;
  try {
    child = spawn(launch.command, launch.args, {
      cwd: folder,
      env: launch.env,
      stdio: ["pipe", "pipe", "inherit"],
      detached: true,
    });
  } catch (error) {
    // Node throws most errors of the system call, for example E2BIG, and emits only a few, for example ENOENT.
    return notStarted(Promise.resolve({ error: error as Error }));
  }
  const exited = new Promise<AgentEnd>((resolve) => {
    // A spawn that fails emits `error` before `close`.
    child.on("error", (error) => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const { pid } = child;
  // At EMFILE and ENFILE, a process that did not start has no stdio either.
  if (pid === undefined) return notStarted(exited);

  let groupEnding: Promise<void> | undefined;
  const endGroupOnce = () => (groupEnding ??= endGroup(child, pid));
  child.once("exit", () => void endGroupOnce());
  const ended = exited.then(async (end) => {
    await endGroupOnce();
    return end;
  });

  const end = async (): Promise<void> => {
    child.stdin.end();
    void endGroupOnce();
    await ended;
  };
  let ending: Promise<void> | undefined;

  return {
    stream: ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
    exited,
    ended,
    end: () => (ending ??= end()),
  };
}

/** Settles with the answer, or rejects when the agent cancels the request or the connection closes. */
function waitForAnswer(handler: AgentRequestHandler, params: AcpObject, signal: AbortSignal): Promise<AcpObject> {
  return new Promise((resolve, reject) => {
    const cancelled = handler(params, resolve);
    // The signal of a request aborts at a `$/cancel_request` of the agent, and when the connection closes.
    signal.addEventListener("abort", () => {
      const reason: unknown = signal.reason;
      if (reason instanceof RequestError && reason.code === REQUEST_CANCELLED) {
        cancelled();
        reject(reason);
      } else {
        reject(new AgentClosed());
      }
    }, { once: true });
  });
}

/**
 * Gives the client one message of the agent per macrotask. The SDK starts the
 * handler of each message without waiting for the one before it, and the
 * handler of each method is a different number of microtasks away, so without
 * this a handler can run before the handler of a message that came first. A
 * handler runs within microtasks of its message, and so before the next one.
 */
function oneByOne(stream: Stream): Stream {
  const ordered = new TransformStream<AnyMessage, AnyMessage>({
    async transform(message, controller) {
      controller.enqueue(message);
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  return { writable: stream.writable, readable: stream.readable.pipeThrough(ordered) };
}

/**
 * Connects to the agent. Each handler gets its messages in the order of the
 * wire, and a request to the agent settles after the handlers of the messages
 * before its answer.
 */
export function connectAgent(stream: Stream, handlers: AgentHandlers): AgentConnection {
  const connection = client({ name: "tasma" })
    .onNotification("session/update", ({ params }) => handlers.update(params.update as AcpObject))
    .onRequest("session/request_permission", async ({ params, signal }) =>
      (await waitForAnswer(handlers.permission, params, signal)) as RequestPermissionResponse)
    .onRequest("elicitation/create", async ({ params, signal }) =>
      (await waitForAnswer(handlers.question, params as AcpObject, signal)) as CreateElicitationResponse)
    .connect(oneByOne(stream));

  async function call<T>(request: Promise<T>): Promise<T> {
    try {
      return await request;
    } catch (error) {
      throw connection.signal.aborted ? new AgentClosed() : error;
    }
  }

  function sessionOf(sessionId: string, configOptions: SessionConfigOption[] | null | undefined): AgentSession {
    return {
      sessionId,
      configOptions: configOptions ?? [],
      async setConfigOption(configId, value) {
        const answer = await call(connection.agent.request("session/set_config_option", { sessionId, configId, value }));
        return answer.configOptions;
      },
      async prompt(text) {
        const { stopReason } = await call(connection.agent.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text }],
        }));
        return { stopReason };
      },
      cancel() {
        void connection.agent.notify("session/cancel", { sessionId }).catch(() => undefined);
      },
    };
  }

  return {
    closed: connection.closed,
    async initialize() {
      await call(connection.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: { form: {} },
          _meta: { terminal_output: true },
        },
      }));
    },
    async create(folder) {
      const { sessionId, configOptions } = await call(connection.agent.request("session/new", { cwd: folder, mcpServers: [] }));
      return sessionOf(sessionId, configOptions);
    },
    async resume(folder, sessionId) {
      try {
        const { configOptions } = await call(connection.agent.request("session/resume", { sessionId, cwd: folder, mcpServers: [] }));
        return sessionOf(sessionId, configOptions);
      } catch (error) {
        if (error instanceof RequestError && error.code === RESOURCE_NOT_FOUND) throw new SessionNotFound(sessionId);
        throw error;
      }
    },
  };
}
