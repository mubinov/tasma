import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { AcpObject } from "@tasma/protocol";
import { AgentClosed, connectAgent, SessionNotFound, spawnAgent } from "../../src/agents/acp.js";
import type { AgentHandlers } from "../../src/agents/acp.js";
import type { AgentLaunch } from "../../src/agents/adapter.js";
import { target, until } from "../helpers.js";
import { fakeAgent, forever, line, PERMISSION, QUESTION, SESSION, text, updateLine } from "./fake-agent.js";
import type { Script } from "./fake-agent.js";

const LAUNCH: AgentLaunch = { command: "fake-agent", args: [], env: {} };

const FOLDER = "/srv/alpha";

type Seen
  = | { update: AcpObject }
    | { permission: AcpObject }
    | { question: AcpObject }
    | { cancelled: AcpObject };

/** Handlers that record each call in `seen`, and answer a request when `reply` gives an answer for it. */
function recorder(reply: (params: AcpObject) => AcpObject | undefined = () => undefined) {
  const seen: Seen[] = [];
  function ask(kind: "permission" | "question") {
    return (params: AcpObject, answer: (result: AcpObject) => void) => {
      seen.push(kind === "permission" ? { permission: params } : { question: params });
      const result = reply(params);
      if (result !== undefined) answer(result);
      return () => seen.push({ cancelled: params });
    };
  }
  const handlers: AgentHandlers = {
    update: (update) => seen.push({ update }),
    permission: ask("permission"),
    question: ask("question"),
  };
  return { seen, handlers };
}

async function started(script: Script = {}, handlers = recorder().handlers) {
  const fake = fakeAgent(script).spawn(LAUNCH, FOLDER);
  const connection = connectAgent(fake.stream, handlers);
  await connection.initialize();
  const session = await connection.create(FOLDER);
  return { fake, connection, session };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the promise did not reject");
}

describe("connectAgent", () => {
  it("declares the form questions and the terminal output, and opens a session in the folder", async () => {
    const { fake, session } = await started();

    expect(session.sessionId).toBe(SESSION);
    expect(fake.initialize).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
        _meta: { terminal_output: true },
        // A default the schema check of the agent's SDK adds.
        auth: { terminal: false },
      },
    });
    expect(fake.newSession).toEqual({ cwd: FOLDER, mcpServers: [] });
  });

  it("opens a stored session again with session/resume in the folder, and prompts in it", async () => {
    const fake = fakeAgent().spawn(LAUNCH, FOLDER);
    const connection = connectAgent(fake.stream, recorder().handlers);
    await connection.initialize();

    const session = await connection.resume(FOLDER, "session-7");
    await session.prompt("Go on");

    expect(session.sessionId).toBe("session-7");
    expect(fake.resumes).toEqual([{ sessionId: "session-7", cwd: FOLDER, mcpServers: [] }]);
    expect(fake.newSession).toBeUndefined();
    expect(fake.prompts).toEqual([{ sessionId: "session-7", prompt: [{ type: "text", text: "Go on" }] }]);
  });

  it("rejects a resume with SessionNotFound when the agent has no such session, and then creates one", async () => {
    const fake = fakeAgent({
      async resume() {
        throw RequestError.resourceNotFound("session-7");
      },
    }).spawn(LAUNCH, FOLDER);
    const connection = connectAgent(fake.stream, recorder().handlers);
    await connection.initialize();

    const error = await rejection(connection.resume(FOLDER, "session-7"));
    const session = await connection.create(FOLDER);

    expect(error).toBeInstanceOf(SessionNotFound);
    expect(error).toMatchObject({ message: "the agent has no session session-7" });
    expect(session.sessionId).toBe(SESSION);
    expect(fake.newSession).toEqual({ cwd: FOLDER, mcpServers: [] });
  });

  it("rejects a resume with the error of the agent for another refusal", async () => {
    const fake = fakeAgent({
      async resume() {
        throw RequestError.authRequired();
      },
    }).spawn(LAUNCH, FOLDER);
    const connection = connectAgent(fake.stream, recorder().handlers);
    await connection.initialize();

    const error = await rejection(connection.resume(FOLDER, "session-7"));

    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: -32000 });
  });

  it("sends a prompt as one text block, and gives the stop reason after the updates of the turn", async () => {
    const { seen, handlers } = recorder();
    const { fake, session } = await started({
      async prompt(_params, agent) {
        void agent.update(text("one"));
        void agent.update(text("two"));
        return { stopReason: "max_tokens" };
      },
    }, handlers);

    const result = await session.prompt("Build the parser");

    expect(fake.prompts).toEqual([{ sessionId: SESSION, prompt: [{ type: "text", text: "Build the parser" }] }]);
    expect(result).toEqual({ stopReason: "max_tokens" });
    expect(seen).toEqual([{ update: text("one") }, { update: text("two") }]);
  });

  it("hands each permission request and question to its handler, and the answer to the agent", async () => {
    const granted = { outcome: { outcome: "selected", optionId: "allow" } };
    const replied = { action: "accept", content: { parser: "peg" } };
    const { seen, handlers } = recorder((params) => ("toolCall" in params ? granted : replied));
    const answers: unknown[] = [];
    const { session } = await started({
      async prompt(_params, agent) {
        answers.push(await agent.permission());
        answers.push(await agent.question());
        return { stopReason: "end_turn" };
      },
    }, handlers);

    await session.prompt("Build the parser");

    expect(seen).toEqual([{ permission: PERMISSION }, { question: QUESTION }]);
    expect(answers).toEqual([granted, replied]);
  });

  it("calls the cancellation of a request the agent cancels, and answers the agent with a cancel", async () => {
    const { seen, handlers } = recorder();
    const cancel = new AbortController();
    let outcome: unknown;
    const { session } = await started({
      async prompt(_params, agent) {
        const asked = agent.permission({}, cancel.signal);
        await until(() => seen.length === 1, "the permission request reached the client");
        cancel.abort();
        outcome = await rejection(asked);
        return { stopReason: "cancelled" };
      },
    }, handlers);

    await session.prompt("Build the parser");

    expect(seen).toEqual([{ permission: PERMISSION }, { cancelled: PERMISSION }]);
    expect(outcome).toMatchObject({ code: -32800 });
  });

  it("does not call the cancellation of an open request when the connection closes", async () => {
    const { seen, handlers } = recorder();
    const { fake, session } = await started({
      async prompt(_params, agent) {
        void agent.question();
        return forever();
      },
    }, handlers);
    const turn = rejection(session.prompt("Build the parser"));
    await until(() => seen.length === 1, "the question reached the client");

    fake.exit({ code: 0, signal: null });
    await turn;

    expect(seen).toEqual([{ question: QUESTION }]);
  });

  it("sends session/cancel with the session id", async () => {
    const { fake, session } = await started();

    session.cancel();

    await until(() => fake.cancels.length === 1, "the agent got the cancel");
    expect(fake.cancels).toEqual([{ sessionId: SESSION }]);
  });

  it("cancels after the connection closed with no throw and no unhandled rejection", async () => {
    const { fake, connection, session } = await started();
    fake.exit({ code: 0, signal: null });
    await connection.closed;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    onTestFinished(() => {
      process.off("unhandledRejection", unhandled);
    });

    expect(() => session.cancel()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).not.toHaveBeenCalled();
    expect(fake.cancels).toEqual([]);
  });

  it("closes after the handlers of every message sent before the end", async () => {
    const { seen, handlers } = recorder();
    const { fake, connection } = await started({}, handlers);

    fake.raw(updateLine(text("a")) + updateLine(text("b")));
    fake.exit({ code: 1, signal: null });
    await connection.closed;

    expect(seen).toEqual([{ update: text("a") }, { update: text("b") }]);
  });

  describe("keeps the wire order", () => {
    it("of a question and an update that arrive together", async () => {
      const { seen, handlers } = recorder();
      const { fake } = await started({}, handlers);

      fake.raw(line({ id: "q-1", method: "elicitation/create", params: QUESTION })
        + updateLine(text("after")));
      await until(() => seen.length === 2, "both messages reached the client");

      expect(seen).toEqual([{ question: QUESTION }, { update: text("after") }]);
    });

    it("of a permission request and an update that arrive together", async () => {
      const { seen, handlers } = recorder();
      const { fake } = await started({}, handlers);

      fake.raw(line({ id: "p-1", method: "session/request_permission", params: PERMISSION })
        + updateLine(text("after")));
      await until(() => seen.length === 2, "both messages reached the client");

      expect(seen).toEqual([{ permission: PERMISSION }, { update: text("after") }]);
    });

    it("of an update and a cancellation that arrive together", async () => {
      const { seen, handlers } = recorder();
      const { fake } = await started({}, handlers);
      fake.raw(line({ id: "p-1", method: "session/request_permission", params: PERMISSION }));
      await until(() => seen.length === 1, "the permission request reached the client");

      fake.raw(updateLine(text("before"))
        + line({ method: "$/cancel_request", params: { requestId: "p-1" } }));
      await until(() => seen.length === 3, "both messages reached the client");

      expect(seen).toEqual([{ permission: PERMISSION }, { update: text("before") }, { cancelled: PERMISSION }]);
    });

    it("of an update and the prompt result right after it", async () => {
      const { seen, handlers } = recorder();
      const { session } = await started({
        async prompt(_params, agent) {
          agent.raw(updateLine(text("last")));
          return { stopReason: "end_turn" };
        },
      }, handlers);

      await session.prompt("Build the parser");

      expect(seen).toEqual([{ update: text("last") }]);
    });
  });

  describe("rejects", () => {
    it("with AgentClosed when the process ends during a prompt", async () => {
      const { session } = await started({
        async prompt(_params, agent) {
          agent.exit({ code: 1, signal: null });
          return forever();
        },
      });

      expect(await rejection(session.prompt("Build the parser"))).toBeInstanceOf(AgentClosed);
    });

    it("with AgentClosed when the process is gone before the session starts", async () => {
      const fake = fakeAgent().spawn(LAUNCH, FOLDER);
      fake.exit({ error: new Error("spawn fake-agent ENOENT") });

      expect(await rejection(connectAgent(fake.stream, recorder().handlers).initialize())).toBeInstanceOf(AgentClosed);
    });

    it("with AgentClosed when the client closes the connection on a message it refuses", async () => {
      const { session } = await started({
        async prompt(_params, agent) {
          agent.raw("[1]\n");
          return forever();
        },
      });

      expect(await rejection(session.prompt("Build the parser"))).toBeInstanceOf(AgentClosed);
    });

    it("with the error of the agent while the connection is open", async () => {
      const fake = fakeAgent({
        async newSession() {
          throw RequestError.authRequired();
        },
      }).spawn(LAUNCH, FOLDER);

      const connection = connectAgent(fake.stream, recorder().handlers);
      await connection.initialize();
      const error = await rejection(connection.create(FOLDER));

      expect(error).toBeInstanceOf(RequestError);
      expect(error).toMatchObject({ code: -32000 });
    });

    it("a prompt with the error of the agent while the connection is open", async () => {
      const { session } = await started({
        async prompt() {
          throw RequestError.internalError({ details: "the model is gone" });
        },
      });

      const error = await rejection(session.prompt("Build the parser"));

      expect(error).toBeInstanceOf(RequestError);
      expect(error).toMatchObject({ code: -32603, data: { details: "the model is gone" } });
    });
  });
});

describe("spawnAgent", () => {
  /** A script that stays alive after its stdin closes. */
  const STUBBORN = "process.stdin.resume(); setInterval(() => {}, 1000);";

  function node(script: string, env: Record<string, string> = {}): AgentLaunch {
    return { command: process.execPath, args: ["-e", script], env };
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("runs the launch in the folder with its environment, over stdin and stdout", async () => {
    const dir = await target();
    const echo = `
      const lines = require("node:readline").createInterface({ input: process.stdin });
      lines.on("line", (text) => {
        const { method } = JSON.parse(text);
        const params = { method, cwd: process.cwd(), value: process.env.TASMA_TEST_VALUE };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "echo", params }) + "\\n");
      });
    `;
    const agent = spawnAgent(node(echo, { TASMA_TEST_VALUE: "kept" }), dir);
    const writer = agent.stream.writable.getWriter();
    const reader = agent.stream.readable.getReader();

    await writer.write({ jsonrpc: "2.0", method: "ping" });
    const { value } = await reader.read();

    expect(value).toEqual({
      jsonrpc: "2.0",
      method: "echo",
      params: { method: "ping", cwd: await realpath(dir), value: "kept" },
    });
    writer.releaseLock();
    reader.releaseLock();
    await agent.end();
    expect(await agent.ended).toEqual({ code: 0, signal: null });
  });

  it("gives the exit code of a process that ends by itself", async () => {
    const agent = spawnAgent(node("process.exit(3)"), await target());

    expect(await agent.ended).toEqual({ code: 3, signal: null });
    await agent.end();
  });

  it("refuses the writes to a process that ends under them through the stream alone", async () => {
    const agent = spawnAgent(node("setTimeout(() => process.exit(0), 50)"), await target());
    const writer = agent.stream.writable.getWriter();
    const message = { jsonrpc: "2.0" as const, method: "fill", params: { pad: "x".repeat(65_536) } };

    let refused: unknown;
    while (refused === undefined) await writer.write(message).catch((error: unknown) => (refused = error));

    expect(refused).toMatchObject({ code: expect.stringMatching(/^(EPIPE|ABORT_ERR)$/) as string });
    await agent.ended;
  });

  it("kills a process that does not exit after its stdin closes", async () => {
    const agent = spawnAgent(node(STUBBORN), await target());

    await agent.end();

    expect(await agent.ended).toEqual({ code: null, signal: "SIGKILL" });
  }, 10_000);

  it("kills the children of the process with it", async () => {
    const parent = `
      const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "child", params: { pid: child.pid } }) + "\\n");
      ${STUBBORN}
    `;
    const agent = spawnAgent(node(parent), await target());
    const reader = agent.stream.readable.getReader();
    const { params } = (await reader.read()).value as { params: { pid: number } };
    onTestFinished(() => {
      if (isAlive(params.pid)) process.kill(params.pid, "SIGKILL");
    });
    reader.releaseLock();

    await agent.end();

    expect(await agent.ended).toEqual({ code: null, signal: "SIGKILL" });
    await until(() => !isAlive(params.pid), "the child of the process ended");
  }, 10_000);

  it("kills the process alone when its group cannot be signalled", async () => {
    const kill = process.kill.bind(process);
    const groupKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      return kill(pid, signal);
    });
    onTestFinished(() => groupKill.mockRestore());
    const agent = spawnAgent(node(STUBBORN), await target());

    await agent.end();

    expect(groupKill.mock.calls.filter(([pid, signal]) => pid < 0 && signal === "SIGKILL"))
      .toEqual([[expect.any(Number), "SIGKILL"]]);
    expect(await agent.ended).toEqual({ code: null, signal: "SIGKILL" });
  }, 10_000);

  describe("waits for the group of the process after its exit", () => {
    /**
     * A process that starts a child in its own group, which ends after
     * `childMs` or never, writes the pid of the child, and exits with code 3
     * by itself or with code 0 when its stdin closes.
     */
    function withChild(childMs: number | "never", exit: "itself" | "at-end"): AgentLaunch {
      const life = childMs === "never" ? "setInterval(() => {}, 1000)" : `setTimeout(() => {}, ${childMs})`;
      const script = `
        const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(life)}], { stdio: "ignore" });
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "child", params: { pid: child.pid } }) + "\\n");
        ${exit === "itself" ? "setTimeout(() => process.exit(3), 50);" : "process.stdin.on(\"end\", () => process.exit(0)); process.stdin.resume();"}
      `;
      return node(script);
    }

    async function childOf(agent: ReturnType<typeof spawnAgent>): Promise<number> {
      const reader = agent.stream.readable.getReader();
      const { params } = (await reader.read()).value as { params: { pid: number } };
      reader.releaseLock();
      onTestFinished(() => {
        if (isAlive(params.pid)) process.kill(params.pid, "SIGKILL");
      });
      return params.pid;
    }

    function kills() {
      const kill = vi.spyOn(process, "kill");
      onTestFinished(() => kill.mockRestore());
      return () => kill.mock.calls.filter(([, signal]) => signal === "SIGKILL");
    }

    it("resolves the end after a child that ends by itself, and kills nothing", async () => {
      const killed = kills();
      const agent = spawnAgent(withChild(600, "at-end"), await target());
      const child = await childOf(agent);
      const started = Date.now();

      await agent.end();

      expect(isAlive(child)).toBe(false);
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(await agent.ended).toEqual({ code: 0, signal: null });
      expect(killed()).toEqual([]);
    }, 10_000);

    it("kills a child that does not end when the grace time ends", async () => {
      const killed = kills();
      const agent = spawnAgent(withChild("never", "at-end"), await target());
      const child = await childOf(agent);

      await agent.end();

      expect(await agent.ended).toEqual({ code: 0, signal: null });
      expect(killed()).toEqual([[expect.any(Number), "SIGKILL"]]);
      await until(() => !isAlive(child), "the child of the process ended");
    }, 10_000);

    it("waits the same way after an exit that end() did not cause, and gives the exit before", async () => {
      const agent = spawnAgent(withChild(600, "itself"), await target());
      const child = await childOf(agent);

      expect(await agent.exited).toEqual({ code: 3, signal: null });
      expect(isAlive(child)).toBe(true);
      expect(await agent.ended).toEqual({ code: 3, signal: null });
      expect(isAlive(child)).toBe(false);
      await agent.end();
    }, 10_000);
  });

  it("gives the error of a process that cannot start", async () => {
    const dir = await target();
    const agent = spawnAgent({ command: join(dir, "missing-agent"), args: [], env: {} }, dir);

    const end = await agent.ended;

    expect(end).toMatchObject({ error: { code: "ENOENT" } });
    await agent.end();
  });

  it("gives the error of a process that the spawn refuses at once, and a closed connection", async () => {
    const dir = await target();
    const agent = spawnAgent(node("", { TASMA_TEST_PAD: "x".repeat(4 * 1024 * 1024) }), dir);
    const connection = connectAgent(agent.stream, recorder().handlers);

    expect(await agent.ended).toMatchObject({ error: { code: "E2BIG" } });
    expect(await rejection(connection.initialize())).toBeInstanceOf(AgentClosed);
    await connection.closed;
    await agent.end();
  });

  it("closes the connection after the messages a process wrote before its exit", async () => {
    const { seen, handlers } = recorder();
    const write = Array.from({ length: 50 }, (_, n) => `process.stdout.write(${JSON.stringify(updateLine(text(`n${n}`)))});`);
    const agent = spawnAgent(node(`${write.join("")} process.exit(3);`), await target());

    await connectAgent(agent.stream, handlers).closed;

    expect(seen).toHaveLength(50);
    expect(seen.at(-1)).toEqual({ update: text("n49") });
    expect(await agent.ended).toEqual({ code: 3, signal: null });
  });

  it("closes the connection of a process that cannot start", async () => {
    const dir = await target();
    const agent = spawnAgent({ command: join(dir, "missing-agent"), args: [], env: {} }, dir);

    await connectAgent(agent.stream, recorder().handlers).closed;

    expect(await agent.ended).toMatchObject({ error: { code: "ENOENT" } });
  });

  it("starts the process in a group of its own, out of reach of the signals of a terminal", async () => {
    const report = `
      let own = true;
      try { process.kill(-process.pid, 0); } catch { own = false; }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "group", params: { own } }) + "\\n");
      process.stdin.resume();
    `;
    const agent = spawnAgent(node(report), await target());
    const reader = agent.stream.readable.getReader();

    expect((await reader.read()).value).toEqual({ jsonrpc: "2.0", method: "group", params: { own: true } });
    reader.releaseLock();
    await agent.end();
  });

  it("ends a process one time for any number of calls", async () => {
    const agent = spawnAgent(node("process.stdin.resume();"), await target());

    const first = agent.end();

    expect(agent.end()).toBe(first);
    await first;
  });
});
