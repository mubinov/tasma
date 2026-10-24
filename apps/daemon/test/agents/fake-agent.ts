// A fake ACP agent on the agent side of the SDK, over in-memory byte streams
// through `ndJsonStream`, so the client runs the transport code a real chat
// runs.

import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  AgentContext,
  CancelNotification,
  CreateElicitationRequest,
  InitializeRequest,
  JsonRpcId,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentEnd, AgentProcess } from "../../src/agents/acp.js";
import type { AgentLaunch } from "../../src/agents/adapter.js";

export const SESSION = "session-1";

/** One direction of a pipe: what the writer side writes, the reader side reads. */
function pipe() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (closed) throw new Error("the pipe is closed");
      controller.enqueue(chunk);
    },
  });
  return {
    readable,
    writable,
    push(text: string): void {
      if (!closed) controller.enqueue(encoder.encode(text));
    },
    close(): void {
      if (closed) return;
      closed = true;
      controller.close();
    },
  };
}

export type FakeProcess = AgentProcess & {
  launch: AgentLaunch;
  folder: string;
  initialize?: InitializeRequest;
  newSession?: NewSessionRequest;
  /** The params of each `session/resume`. */
  resumes: ResumeSessionRequest[];
  prompts: PromptRequest[];
  /** The JSON-RPC id of each prompt, in the order of `prompts`. */
  promptIds: JsonRpcId[];
  /** The params of each `session/cancel` notification. */
  cancels: CancelNotification[];
  /** The calls of `end()`, which ends the process one time and exits with code 0. */
  endCalls: number;
  /** The end of the other processes of the group, which `ended` waits for after the exit. */
  group: Promise<void>;
  /** The agent side of the connection, once the client has connected. */
  client: AgentContext;
  /** Sends one session update to the client. Rejects when the connection is closed. */
  update(update: SessionUpdate): Promise<void>;
  permission(params?: Partial<RequestPermissionRequest>, signal?: AbortSignal): Promise<unknown>;
  question(params?: Partial<CreateElicitationRequest>, signal?: AbortSignal): Promise<unknown>;
  /** Writes text to the client as it is, as a broken agent would. */
  raw(text: string): void;
  /** Ends the process: both pipes close, `exited` gives `end`, and `ended` gives it after `group`. */
  exit(end: AgentEnd): void;
};

/** What the fake agent does. A handler that never settles keeps its request open. */
export type Script = {
  newSession?(params: NewSessionRequest, fake: FakeProcess): Promise<NewSessionResponse>;
  /** Without it, every resume succeeds. An agent with no such session refuses with `RequestError.resourceNotFound`. */
  resume?(params: ResumeSessionRequest, fake: FakeProcess): Promise<ResumeSessionResponse>;
  prompt?(params: PromptRequest, fake: FakeProcess): Promise<PromptResponse>;
  /** Runs at each `session/cancel`, for example to end the running prompt with `cancelled`. */
  cancel?(params: CancelNotification, fake: FakeProcess): void;
};

export const PERMISSION: RequestPermissionRequest = {
  sessionId: SESSION,
  toolCall: { toolCallId: "call-1", title: "Run the build" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
};

export const QUESTION: CreateElicitationRequest = {
  sessionId: SESSION,
  mode: "form",
  message: "Which parser?",
  requestedSchema: { type: "object", properties: { parser: { type: "string" } } },
};

export function text(chunk: string): SessionUpdate {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } };
}

/** One JSON-RPC message as a line of the wire. */
export function line(message: object): string {
  return `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
}

/** A session update as a line of the wire. */
export function updateLine(update: SessionUpdate): string {
  return line({ method: "session/update", params: { sessionId: SESSION, update } });
}

/** A promise that never settles: a request of the agent that stays open. */
export function forever<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/**
 * A spawn whose processes are fake agents that run `script`. Every process it
 * starts is in `processes`, in start order.
 */
export function fakeAgent(script: Script = {}): {
  spawn: (launch: AgentLaunch, folder: string) => FakeProcess;
  processes: FakeProcess[];
} {
  const processes: FakeProcess[] = [];

  function spawn(launch: AgentLaunch, folder: string): FakeProcess {
    const toAgent = pipe();
    const toClient = pipe();
    let settle!: (end: AgentEnd) => void;
    const exited = new Promise<AgentEnd>((resolve) => (settle = resolve));
    const ended = exited.then(async (end) => {
      await fake.group;
      return end;
    });
    let ending: Promise<void> | undefined;

    const fake: FakeProcess = {
      launch,
      folder,
      resumes: [],
      prompts: [],
      promptIds: [],
      cancels: [],
      endCalls: 0,
      group: Promise.resolve(),
      stream: ndJsonStream(toAgent.writable, toClient.readable),
      exited,
      ended,
      get client() {
        return connection.client;
      },
      end() {
        fake.endCalls += 1;
        // As the adapter does when its stdin closes.
        return ending ??= (async () => {
          fake.exit({ code: 0, signal: null });
          await ended;
        })();
      },
      update(update) {
        return fake.client.notify("session/update", { sessionId: SESSION, update });
      },
      permission(params, signal) {
        return fake.client.request("session/request_permission", { ...PERMISSION, ...params }, {
          cancellationSignal: signal,
        });
      },
      question(params, signal) {
        return fake.client.request("elicitation/create", { ...QUESTION, ...params }, {
          cancellationSignal: signal,
        });
      },
      raw(text) {
        toClient.push(text);
      },
      exit(end) {
        toClient.close();
        toAgent.close();
        connection.close();
        settle(end);
      },
    };

    const connection = agent({ name: "fake" })
      .onRequest("initialize", ({ params }) => {
        fake.initialize = params;
        return { protocolVersion: PROTOCOL_VERSION };
      })
      .onRequest("session/new", ({ params }) => {
        fake.newSession = params;
        return script.newSession?.(params, fake) ?? { sessionId: SESSION };
      })
      .onRequest("session/resume", ({ params }) => {
        fake.resumes.push(params);
        return script.resume?.(params, fake) ?? {};
      })
      .onRequest("session/prompt", ({ params, requestId }) => {
        fake.prompts.push(params);
        fake.promptIds.push(requestId);
        return script.prompt?.(params, fake) ?? { stopReason: "end_turn" };
      })
      .onNotification("session/cancel", ({ params }) => {
        fake.cancels.push(params);
        script.cancel?.(params, fake);
      })
      .connect(ndJsonStream(toClient.writable, toAgent.readable));

    processes.push(fake);
    return fake;
  }

  return { spawn, processes };
}
