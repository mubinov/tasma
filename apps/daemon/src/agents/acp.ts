// The ACP client of a chat: the agent process, and the connection to it over
// its stdin and stdout.

import { spawn } from "node:child_process";
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  AnyMessage,
  CreateElicitationResponse,
  RequestPermissionResponse,
  Stream,
} from "@agentclientprotocol/sdk";
import type { AcpObject } from "@tasma/protocol";
import type { AgentLaunch } from "./adapter.js";

/** How long `end()` waits for the process to exit after its stdin closes. */
const END_GRACE_MS = 2000;

const REQUEST_CANCELLED = RequestError.requestCancelled().code;

export type AgentEnd = { code: number | null; signal: NodeJS.Signals | null } | { error: Error };

export type AgentProcess = {
  stream: Stream;
  /** Resolves one time: at the exit of the process, or when it cannot start. */
  ended: Promise<AgentEnd>;
  /**
   * Closes stdin, and kills the process with its group if it has not exited
   * after a grace time. Resolves at the exit.
   */
  end(): Promise<void>;
};

export type AgentSession = { sessionId: string; prompt(text: string): Promise<{ stopReason: string }> };

export type AgentConnection = {
  /** Resolves when the connection closes, after the handlers of every message the agent sent before. */
  closed: Promise<void>;
  /** Initializes the agent and opens a session in `folder`. */
  open(folder: string): Promise<AgentSession>;
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

/** A process that did not start. Its connection closes at once. */
function notStarted(ended: Promise<AgentEnd>): AgentProcess {
  const done = ended.then(() => undefined);
  return {
    stream: {
      readable: new ReadableStream<AnyMessage>({ start: (controller) => controller.close() }),
      writable: new WritableStream<AnyMessage>(),
    },
    ended,
    end: () => done,
  };
}

/** Kills the process and the processes it started that stay in its group. */
function killGroup(child: ChildProcess, pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Unlike `child.kill`, `process.kill` throws, for example when the group has no live process left.
    child.kill("SIGKILL");
  }
}

/**
 * The process has a group of its own, so the signals of a terminal that runs
 * the daemon do not reach it. It still exits when its stdin closes.
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
  const ended = new Promise<AgentEnd>((resolve) => {
    // A spawn that fails emits `error` before `close`.
    child.on("error", (error) => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const { pid } = child;
  // At EMFILE and ENFILE, a process that did not start has no stdio either.
  if (pid === undefined) return notStarted(ended);

  const end = async (): Promise<void> => {
    child.stdin.end();
    // After the exit, the system can give the group id to a new process.
    if (child.exitCode === null && child.signalCode === null) {
      const kill = setTimeout(() => killGroup(child, pid), END_GRACE_MS);
      child.once("exit", () => clearTimeout(kill));
    }
    await ended;
  };
  let ending: Promise<void> | undefined;

  return {
    stream: ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
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

  return {
    closed: connection.closed,
    async open(folder) {
      await call(connection.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: { form: {} },
          _meta: { terminal_output: true },
        },
      }));
      const { sessionId } = await call(connection.agent.request("session/new", { cwd: folder, mcpServers: [] }));

      return {
        sessionId,
        async prompt(text) {
          const { stopReason } = await call(connection.agent.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text }],
          }));
          return { stopReason };
        },
      };
    },
  };
}
