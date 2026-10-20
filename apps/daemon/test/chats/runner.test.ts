import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import type { NewSessionResponse } from "@agentclientprotocol/sdk";
import { TaskStoreError } from "@tasma/engine";
import type { AcpObject, ChatEvent, FeedEvent } from "@tasma/protocol";
import { spawnAgent } from "../../src/agents/acp.js";
import type { AgentProcess } from "../../src/agents/acp.js";
import type { AgentAdapter, AgentEnv, AgentLaunch } from "../../src/agents/adapter.js";
import { claudeAdapter } from "../../src/agents/claude.js";
import { createChatRegistry } from "../../src/chats/registry.js";
import type { ChatRegistry, LiveChat } from "../../src/chats/registry.js";
import { ChatStartRefusal, createChatRunner } from "../../src/chats/runner.js";
import type { ChatRunner } from "../../src/chats/runner.js";
import { createProjectHost } from "../../src/projects/host.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { taskRoutes } from "../../src/tasks/routes.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import { plant, projectConfig, projectsRoot, send, startTestServer, target, taskFile, taskText, until } from "../helpers.js";
import type { TestServer } from "../helpers.js";
import { fakeAgent, forever, line, PERMISSION, QUESTION, SESSION, text, updateLine } from "../agents/fake-agent.js";
import type { FakeProcess, Script } from "../agents/fake-agent.js";

const START = { tag: "ALPHA", task: "ALPHA-1", step: "dev:build", agent: "claude", text: "Build the parser", client: "app" } as const;

const LAUNCH: AgentLaunch = { command: "fake-agent", args: [], env: {} };

/** An adapter that launches the fake agent, records the environment it gets, and marks each update it filters. */
function fakeAdapter(launch: AgentLaunch | { failed: string } = LAUNCH) {
  const envs: AgentEnv[] = [];
  const adapter: AgentAdapter = {
    agent: "claude",
    launch(env) {
      envs.push(env);
      return launch;
    },
    notLoggedIn: "Log in to the agent first",
    filterUpdate: (update) => ({ ...update, filtered: true }),
  };
  return { adapter, envs };
}

type World = {
  folder: string;
  chats: ChatRegistry;
  runner: ChatRunner;
  feed: FeedEvent[];
  errors: string[];
  processes: FakeProcess[];
  envs: AgentEnv[];
  server: TestServer;
};

type Options = {
  script?: Script;
  adapter?: AgentAdapter;
  /** What the spawn does with each process it starts, before the runner gets it. */
  started?: (fake: FakeProcess) => void;
  config?: (folder: string) => string;
  chats?: (chats: ChatRegistry) => ChatRegistry;
  env?: AgentEnv;
  /** Replaces the spawn of the fake agent. */
  spawn?: (launch: AgentLaunch, folder: string) => AgentProcess;
};

/** A daemon over project ALPHA, whose folder is a directory, with the task ALPHA-1. */
async function world(options: Options = {}): Promise<World> {
  const root = await projectsRoot("ALPHA");
  const folder = await target();
  await plant(projectConfig(root, "ALPHA"), options.config?.(folder) ?? `path: ${folder}\n`);
  await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskText("ALPHA-1"));
  const host = createProjectHost({ root });
  onTestFinished(() => host.close());
  const writes = new WriteQueue();
  const feed: FeedEvent[] = [];
  const registry = createChatRegistry({ root, host, writes, publish: (event) => feed.push(event) });
  const chats = options.chats?.(registry) ?? registry;
  const server = await startTestServer([
    ...projectRoutes(host, writes, registry),
    ...taskRoutes(host, { writes, chats: registry }),
  ]);
  const agents = fakeAgent(options.script);
  const { adapter, envs } = fakeAdapter();
  const errors: string[] = [];
  const runner = createChatRunner({
    root,
    chats,
    adapters: [options.adapter ?? adapter],
    env: options.env ?? { PATH: "/usr/bin", HOME: "/home/alice" },
    spawn: options.spawn ?? ((launch, at) => {
      const fake = agents.spawn(launch, at);
      options.started?.(fake);
      return fake;
    }),
    stderr: { write: (line: string) => errors.push(line) },
  });
  onTestFinished(() => runner.close());
  return { folder, chats, runner, feed, errors, processes: agents.processes, envs, server };
}

async function events(live: LiveChat): Promise<ChatEvent[]> {
  return (await live.read(0)).map((entry) => entry.event);
}

/** Waits until the log of the chat ends with an event of `kind`, and gives the events. */
async function logUntil(live: LiveChat, kind: ChatEvent["kind"]): Promise<ChatEvent[]> {
  let seen: ChatEvent[] = [];
  await until(() => seen.at(-1)?.kind === kind, `the log ends with ${kind}`, async () => {
    seen = await events(live);
  });
  return seen;
}

const USER: ChatEvent = { kind: "user", text: START.text, client: START.client };

function filtered(update: AcpObject): ChatEvent {
  return { kind: "update", update: { ...update, filtered: true } };
}

function chatState(state: "working" | "needs-you" | "failed"): FeedEvent {
  return { kind: "chat", tag: "ALPHA", task: "ALPHA-1", chat: 1, step: START.step, state };
}

/** The id the daemon gave the open request of the log, which a resolution names. */
function requestOf(log: ChatEvent[]): string {
  const asked = log.find((event) => event.kind === "permission" || event.kind === "question");
  if (asked === undefined) throw new Error("the log holds no request");
  return asked.request;
}

/** Waits until the runner has ended the process. */
async function endedByRunner(fake: FakeProcess | undefined): Promise<void> {
  await until(() => (fake?.endCalls ?? 0) > 0, "the runner ended the process");
}

/**
 * Makes each process exit `ms` after the runner ends it, as a real agent does
 * after its stdin closes. `first` runs when the end starts.
 */
function slowEnd(ms: number, first: () => void = () => {}): (fake: FakeProcess) => void {
  return (fake) => {
    const end = fake.end.bind(fake);
    let ending: Promise<void> | undefined;
    fake.end = () => (ending ??= (async () => {
      first();
      await new Promise((resolve) => setTimeout(resolve, ms));
      await end();
    })());
  };
}

describe("createChatRunner.start", () => {
  it("writes the updates, a permission request and the turn end in order, and keeps the session", async () => {
    const { runner, feed, folder, processes, envs } = await world({
      script: {
        async prompt(_params, agent) {
          await agent.update(text("Reading"));
          await agent.update(text("Done"));
          void agent.permission();
          return { stopReason: "end_turn" };
        },
      },
    });

    const live = await runner.start(START);
    const log = await logUntil(live, "turn-end");

    expect(log).toEqual([
      USER,
      filtered(text("Reading")),
      filtered(text("Done")),
      { kind: "permission", request: expect.any(String) as string, permission: PERMISSION },
      { kind: "turn-end", stopReason: "end_turn" },
    ]);
    expect(feed.filter((event) => event.kind === "chat")).toEqual([chatState("working"), chatState("needs-you")]);
    expect(live.chat).toMatchObject({ state: "needs-you", session: SESSION, folder, agent: "claude", step: START.step });
    expect(processes.map((fake) => fake.folder)).toEqual([folder]);
    expect(processes[0]?.newSession).toEqual({ cwd: folder, mcpServers: [] });
    expect(processes[0]?.prompts).toEqual([{ sessionId: SESSION, prompt: [{ type: "text", text: START.text }] }]);
    expect(envs).toEqual([{ PATH: "/usr/bin", HOME: "/home/alice" }]);
  });

  it("gives back the chat working, with its process registered and no session yet", async () => {
    const { runner, processes } = await world();

    const live = await runner.start(START);

    expect(live.chat.state).toBe("working");
    const running = runner.running(live);
    expect(running?.live).toBe(live);
    expect(running?.process).toBe(processes[0]);
    expect(running?.session).toBeUndefined();
    await logUntil(live, "turn-end");
  });

  it("keeps the turn end last after updates sent with no wait before the result", async () => {
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          for (const chunk of ["a", "b", "c"]) void agent.update(text(chunk));
          return { stopReason: "end_turn" };
        },
      },
    });

    const live = await runner.start(START);

    expect(await logUntil(live, "turn-end")).toEqual([
      USER,
      filtered(text("a")),
      filtered(text("b")),
      filtered(text("c")),
      { kind: "turn-end", stopReason: "end_turn" },
    ]);
  });

  it("keeps the failure last after updates sent with no wait before an error", async () => {
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          for (const chunk of ["a", "b"]) void agent.update(text(chunk));
          throw RequestError.internalError({ details: "the model is gone" });
        },
      },
    });

    const live = await runner.start(START);

    expect(await logUntil(live, "failed")).toEqual([
      USER,
      filtered(text("a")),
      filtered(text("b")),
      { kind: "failed", reason: "the model is gone" },
    ]);
  });

  it("writes the resolution of a permission request the agent cancels, with no client", async () => {
    const cancel = new AbortController();
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          const asked = agent.permission({}, cancel.signal);
          cancel.abort();
          await asked.catch(() => undefined);
          return { stopReason: "cancelled" };
        },
      },
    });

    const live = await runner.start(START);
    const log = await logUntil(live, "turn-end");

    expect(log).toEqual([
      USER,
      { kind: "permission", request: requestOf(log), permission: PERMISSION },
      { kind: "permission-resolved", request: requestOf(log), outcome: { outcome: "cancelled" } },
      { kind: "turn-end", stopReason: "cancelled" },
    ]);
  });

  it("writes the resolution of a question the agent cancels, with no client", async () => {
    const cancel = new AbortController();
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          const asked = agent.question({}, cancel.signal);
          cancel.abort();
          await asked.catch(() => undefined);
          return { stopReason: "cancelled" };
        },
      },
    });

    const live = await runner.start(START);
    const log = await logUntil(live, "turn-end");

    expect(log).toEqual([
      USER,
      { kind: "question", request: requestOf(log), question: QUESTION },
      { kind: "question-resolved", request: requestOf(log), answer: { action: "cancel" } },
      { kind: "turn-end", stopReason: "cancelled" },
    ]);
  });

  it("keeps each open request with the function that answers it", async () => {
    const answers: unknown[] = [];
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          answers.push(await agent.permission());
          answers.push(await agent.question());
          return { stopReason: "end_turn" };
        },
      },
    });
    const live = await runner.start(START);
    const granted = { outcome: { outcome: "selected", optionId: "allow" } };
    const replied = { action: "decline" };

    for (const [kind, result] of [["permission", granted], ["question", replied]] as const) {
      await logUntil(live, kind);
      const open = runner.running(live)?.open;
      expect([...open?.values() ?? []].map((request) => request.kind)).toEqual([kind]);
      const pending = open?.get(requestOf((await events(live)).filter((event) => event.kind === kind)));
      pending?.answer(result);
      pending?.answer({ outcome: { outcome: "cancelled" } });
      expect(open?.size).toBe(0);
    }

    await logUntil(live, "turn-end");
    expect(answers).toEqual([granted, replied]);
  });

  it("runs a later turn with the same rules", async () => {
    const { runner, processes } = await world();
    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    await runner.running(live)?.turn("Now the printer");

    expect(processes[0]?.prompts.map((prompt) => prompt.prompt)).toEqual([
      [{ type: "text", text: START.text }],
      [{ type: "text", text: "Now the printer" }],
    ]);
    expect((await events(live)).at(-1)).toEqual({ kind: "turn-end", stopReason: "end_turn" });
  });

  it("refuses a turn before the session starts", async () => {
    const { runner } = await world({ script: { newSession: forever } });
    const live = await runner.start(START);

    await expect(runner.running(live)?.turn("Now the printer")).rejects.toThrow("the agent session has not started");
  });

  describe("refuses before it creates a chat", () => {
    async function refusal(start: Promise<unknown>): Promise<ChatStartRefusal> {
      try {
        await start;
      } catch (error) {
        if (error instanceof ChatStartRefusal) return error;
        throw error;
      }
      throw new Error("the start was not refused");
    }

    it("an agent with no adapter", async () => {
      const { runner, chats } = await world();

      expect(await refusal(runner.start({ ...START, agent: "codex" }))).toMatchObject({ code: "agent-not-supported" });
      expect((await chats.list("ALPHA", "ALPHA-1")).chats).toEqual([]);
    });

    it("a project that declares no folder", async () => {
      const { runner, chats } = await world({ config: () => "name: Alpha\n" });

      expect(await refusal(runner.start(START))).toMatchObject({ code: "project-has-no-folder" });
      expect((await chats.list("ALPHA", "ALPHA-1")).chats).toEqual([]);
    });

    it("a project whose folder is missing or is not a directory", async () => {
      for (const name of ["missing", "file"]) {
        const { runner, chats, folder } = await world({ config: (folder) => `path: ${join(folder, name)}\n` });
        if (name === "file") await writeFile(join(folder, name), "");

        expect(await refusal(runner.start(START))).toMatchObject({ code: "project-has-no-folder" });
        expect((await chats.list("ALPHA", "ALPHA-1")).chats).toEqual([]);
      }
    });
  });

  it("passes on the refusals of the project and of the task", async () => {
    const { runner } = await world();

    await expect(runner.start({ ...START, tag: "BETA", task: "BETA-1" })).rejects.toMatchObject({ code: "project-not-found" });
    await expect(runner.start({ ...START, task: "ALPHA-9" })).rejects.toMatchObject({ code: "task-not-found" });
  });
});

describe("createChatRunner failures", () => {
  it("fails with the text of the launch, and starts no process", async () => {
    const { runner, processes, feed } = await world({ adapter: fakeAdapter({ failed: "No agent here" }).adapter });

    const live = await runner.start(START);

    expect(await events(live)).toEqual([USER, { kind: "failed", reason: "No agent here" }]);
    expect(live.chat.state).toBe("failed");
    expect(feed.filter((event) => event.kind === "chat")).toEqual([chatState("working"), chatState("failed")]);
    expect(processes).toEqual([]);
    expect(runner.running(live)).toBeUndefined();
  });

  it("fails with the install text of the real Claude adapter when PATH holds no claude", async () => {
    const { runner } = await world({ adapter: claudeAdapter, env: { PATH: await target() } });

    const live = await runner.start(START);

    expect(live.chat.state).toBe("failed");
    expect(await events(live)).toEqual([USER, { kind: "failed", reason: "Claude Code is not installed" }]);
  });

  it("fails when the process cannot start", async () => {
    const { runner } = await world({ started: (fake) => fake.exit({ error: new Error("spawn fake-agent ENOENT") }) });

    const live = await runner.start(START);

    expect(await logUntil(live, "failed")).toEqual([
      USER,
      { kind: "failed", reason: "The agent could not start: spawn fake-agent ENOENT" },
    ]);
    expect(runner.running(live)).toBeUndefined();
  });

  it("fails when the system refuses the spawn at once", async () => {
    const oversized = { command: process.execPath, args: ["-e", ""], env: { TASMA_TEST_PAD: "x".repeat(4 * 1024 * 1024) } };
    const { runner } = await world({ adapter: fakeAdapter(oversized).adapter, spawn: spawnAgent });

    const live = await runner.start(START);

    expect(await logUntil(live, "failed")).toEqual([USER, { kind: "failed", reason: "The agent could not start: spawn E2BIG" }]);
    await until(() => runner.running(live) === undefined, "the chat stopped running");
  });

  for (const [end, reason] of [
    [{ code: 1, signal: null }, "The agent process ended with exit code 1"],
    [{ code: 0, signal: null }, "The agent process ended with exit code 0"],
    [{ code: null, signal: "SIGTERM" }, "The agent process ended with signal SIGTERM"],
  ] as const) {
    it(`fails once with "${reason}" when the process ends during a turn`, async () => {
      const { runner, processes } = await world({
        script: {
          async prompt(_params, agent) {
            void agent.permission();
            await agent.update(text("Working"));
            agent.exit(end);
            return forever();
          },
        },
      });

      const live = await runner.start(START);
      const log = await logUntil(live, "failed");

      expect(log.slice(-2)).toEqual([filtered(text("Working")), { kind: "failed", reason }]);
      expect(log.filter((event) => event.kind === "failed")).toHaveLength(1);
      expect(runner.running(live)).toBeUndefined();
      expect(processes[0]?.endCalls).toBeGreaterThan(0);
    });
  }

  it("fails when the process ends during the start of the session", async () => {
    const { runner } = await world({
      script: {
        async newSession(_params, agent) {
          agent.exit({ code: 2, signal: null });
          return forever();
        },
      },
    });

    const live = await runner.start(START);

    expect(await logUntil(live, "failed")).toEqual([USER, { kind: "failed", reason: "The agent process ended with exit code 2" }]);
  });

  it("ends the process and writes the exit when the client closes the connection", async () => {
    const { runner, processes } = await world({
      script: {
        async prompt(_params, agent) {
          agent.raw("[1]\n");
          return forever();
        },
      },
    });

    const live = await runner.start(START);

    expect((await logUntil(live, "failed")).at(-1)).toEqual({
      kind: "failed",
      reason: "The agent process ended with exit code 0",
    });
    expect(processes[0]?.endCalls).toBeGreaterThan(0);
  });

  it("fails when the process ends between turns with an error", async () => {
    const { runner, processes } = await world();
    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    processes[0]?.exit({ code: 137, signal: null });

    expect((await logUntil(live, "failed")).at(-1)).toEqual({
      kind: "failed",
      reason: "The agent process ended with exit code 137",
    });
    expect(runner.running(live)).toBeUndefined();
  });

  it("writes the exit after the turn end when the process ends right after the prompt result", async () => {
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          agent.raw(updateLine(text("a")) + updateLine(text("b"))
            + line({ id: agent.promptIds.at(-1), result: { stopReason: "end_turn" } }));
          agent.exit({ code: 1, signal: null });
          return forever();
        },
      },
    });

    const live = await runner.start(START);

    expect(await logUntil(live, "failed")).toEqual([
      USER,
      filtered(text("a")),
      filtered(text("b")),
      { kind: "turn-end", stopReason: "end_turn" },
      { kind: "failed", reason: "The agent process ended with exit code 1" },
    ]);
  });

  it("writes the messages sent before an exit between turns, then the exit", async () => {
    const { runner, processes } = await world();
    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    processes[0]?.raw(updateLine(text("a")) + updateLine(text("b")));
    processes[0]?.exit({ code: 1, signal: null });

    expect((await logUntil(live, "failed")).slice(-4)).toEqual([
      { kind: "turn-end", stopReason: "end_turn" },
      filtered(text("a")),
      filtered(text("b")),
      { kind: "failed", reason: "The agent process ended with exit code 1" },
    ]);
  });

  it("ends the process when the connection closes between turns", async () => {
    const { runner, processes } = await world();
    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    processes[0]?.raw("[1]\n");

    await endedByRunner(processes[0]);
    await until(() => runner.running(live) === undefined, "the chat stopped running");
    expect((await events(live)).at(-1)).toEqual({ kind: "turn-end", stopReason: "end_turn" });
  });

  it("writes nothing when the process exits with code 0 between turns", async () => {
    const { runner, processes } = await world();
    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    processes[0]?.exit({ code: 0, signal: null });
    await processes[0]?.ended;
    await until(() => runner.running(live) === undefined, "the chat stopped running");

    expect((await events(live)).at(-1)).toEqual({ kind: "turn-end", stopReason: "end_turn" });
    expect(live.chat.state).toBe("needs-you");
  });

  for (const [stage, script] of [
    ["the session start", { newSession: () => Promise.reject(RequestError.authRequired()) }],
    ["a turn", { prompt: () => Promise.reject(RequestError.authRequired()) }],
  ] as const) {
    it(`fails with the login text of the adapter when ${stage} needs a login`, async () => {
      const { runner, processes } = await world({ script });

      const live = await runner.start(START);

      expect((await logUntil(live, "failed")).at(-1)).toEqual({ kind: "failed", reason: "Log in to the agent first" });
      await endedByRunner(processes[0]);
    });
  }

  it("fails with the message of a fault that is not an error of the agent", async () => {
    const { runner } = await world({ script: { newSession: async () => null as unknown as NewSessionResponse } });

    const live = await runner.start(START);

    expect((await logUntil(live, "failed")).at(-1)).toEqual({
      kind: "failed",
      reason: expect.stringContaining("sessionId") as string,
    });
  });

  it("fails with the message of an error that carries no details", async () => {
    const { runner } = await world({
      script: { prompt: () => Promise.reject(new RequestError(-32603, "Internal error", { reason: "unknown" })) },
    });

    const live = await runner.start(START);

    expect((await logUntil(live, "failed")).at(-1)).toEqual({ kind: "failed", reason: "Internal error" });
  });
});

describe("createChatRunner when the chat is gone", () => {
  /**
   * A script whose turn stays open, and a function that sends an update, a
   * permission request and a question in it. It settles when the process ends.
   */
  function lateUpdates() {
    let late!: () => Promise<unknown>;
    const script: Script = {
      async prompt(_params, agent) {
        late = () => Promise.all([
          agent.permission().catch(() => undefined),
          agent.update(text("late")).catch(() => undefined),
          agent.question().catch(() => undefined),
        ]);
        return forever();
      },
    };
    return { script, late: () => late() };
  }

  it("ends the process silently after a delete of the task during a turn", async () => {
    const { script, late } = lateUpdates();
    const { runner, server, processes, errors } = await world({ script });
    const live = await runner.start(START);
    await until(() => processes[0]?.prompts.length === 1, "the turn started");

    expect((await send(server, "DELETE", "/projects/ALPHA/tasks/ALPHA-1")).status).toBe(200);
    await late();

    await endedByRunner(processes[0]);
    expect(errors).toEqual([]);
    expect(runner.running(live)).toBeUndefined();
    expect(live.chat.state).toBe("working");
  });

  it("ends the process, writes nothing more and reports a fault of the log on stderr", async () => {
    const { script, late } = lateUpdates();
    const { runner, processes, errors } = await world({ script, started: slowEnd(20) });
    const live = await runner.start(START);
    await until(() => processes[0]?.prompts.length === 1, "the turn started");
    const append = vi.spyOn(live, "append").mockRejectedValue(new Error("the disk is gone"));

    await late();

    expect(processes[0]?.endCalls).toBeGreaterThan(0);
    expect(append).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(["tasma-daemon: chat 1 of ALPHA-1: the disk is gone\n"]);
  });

  it("reports one line for the faults of several writes that were already running", async () => {
    const { script, late } = lateUpdates();
    const { runner, processes, errors } = await world({ script });
    const live = await runner.start(START);
    await until(() => processes[0]?.prompts.length === 1, "the turn started");
    const slowFault = () => new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("the disk is gone")), 50));
    const append = vi.spyOn(live, "append").mockImplementation(slowFault);

    await late();
    await Promise.allSettled(append.mock.results.map((result) => result.value as Promise<unknown>));
    await new Promise((resolve) => setImmediate(resolve));

    expect(append.mock.calls.length).toBeGreaterThan(1);
    expect(errors).toEqual(["tasma-daemon: chat 1 of ALPHA-1: the disk is gone\n"]);
  });

  it("ends the process when the session cannot be kept", async () => {
    const { runner, processes, errors } = await world({
      chats: (chats) => ({
        ...chats,
        async create(...args) {
          const live = await chats.create(...args);
          vi.spyOn(live, "setSession").mockRejectedValue(new TaskStoreError("chat-not-found", "gone"));
          return live;
        },
      }),
    });

    const live = await runner.start(START);

    await endedByRunner(processes[0]);
    expect(processes[0]?.prompts).toEqual([]);
    expect(await events(live)).toEqual([USER]);
    expect(errors).toEqual([]);
  });

  it("reports a fault of the log when the failure of the launch cannot be written", async () => {
    const { runner, errors } = await world({
      adapter: fakeAdapter({ failed: "No agent here" }).adapter,
      chats: (chats) => ({
        ...chats,
        async create(...args) {
          const live = await chats.create(...args);
          vi.spyOn(live, "append").mockRejectedValue(new Error("the disk is gone"));
          return live;
        },
      }),
    });

    await runner.start(START);

    expect(errors).toEqual(["tasma-daemon: chat 1 of ALPHA-1: the disk is gone\n"]);
  });
});

describe("createChatRunner.close", () => {
  it("ends every agent process, waits for each exit and writes no event", async () => {
    const { runner, processes } = await world({
      script: {
        async prompt(_params, agent) {
          void agent.permission();
          return forever();
        },
      },
    });
    const live = await runner.start(START);
    const second = await runner.start({ ...START, text: "Build the printer" });
    await logUntil(live, "permission");
    await logUntil(second, "permission");
    const before = [await events(live), await events(second)];

    await runner.close();

    expect(processes.map((fake) => fake.endCalls > 0)).toEqual([true, true]);
    expect(await Promise.all(processes.map((fake) => fake.ended))).toEqual([
      { code: 0, signal: null },
      { code: 0, signal: null },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect([await events(live), await events(second)]).toEqual(before);
    expect(runner.running(live)).toBeUndefined();
  });

  it("writes nothing for an open request that the agent cancels while it ends", async () => {
    const cancel = new AbortController();
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          void agent.permission({}, cancel.signal).catch(() => undefined);
          return forever();
        },
      },
      started: slowEnd(20, () => cancel.abort()),
    });
    const live = await runner.start(START);
    const before = await logUntil(live, "permission");

    await runner.close();

    expect(await events(live)).toEqual(before);
  });

  it("starts no agent for a start that the close overtakes", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { runner, processes } = await world({
      chats: (chats) => ({
        ...chats,
        async create(...args) {
          await held;
          return chats.create(...args);
        },
      }),
    });
    const starting = runner.start(START);

    const closing = runner.close();
    release();
    const live = await starting;
    await closing;

    expect(processes).toEqual([]);
    expect(runner.running(live)).toBeUndefined();
    expect(await events(live)).toEqual([USER]);
  });

  it("waits for a process that a failure is ending", async () => {
    let release!: () => void;
    const { runner, processes } = await world({
      script: { prompt: () => Promise.reject(RequestError.internalError({ details: "broken" })) },
      started(fake) {
        const end = fake.end.bind(fake);
        const held = new Promise<void>((resolve) => (release = resolve));
        let ending: Promise<void> | undefined;
        fake.end = () => (ending ??= held.then(end));
      },
    });
    const live = await runner.start(START);
    await logUntil(live, "failed");

    let closed = false;
    const closing = runner.close().then(() => (closed = true));
    await new Promise((resolve) => setImmediate(resolve));

    expect(closed).toBe(false);
    release();
    await closing;
    expect(await processes[0]?.ended).toEqual({ code: 0, signal: null });
  });
});
