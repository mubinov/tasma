import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import type { NewSessionResponse, PromptResponse } from "@agentclientprotocol/sdk";
import { TaskStoreError } from "@tasma/engine";
import type { AcpObject, ChatEvent, FeedEvent } from "@tasma/protocol";
import { spawnAgent } from "../../src/agents/acp.js";
import type { AgentProcess } from "../../src/agents/acp.js";
import type { AgentAdapter, AgentEnv, AgentLaunch } from "../../src/agents/adapter.js";
import { claudeAdapter } from "../../src/agents/claude.js";
import type { ShellEnv } from "../../src/agents/shell-env.js";
import { createChatRegistry } from "../../src/chats/registry.js";
import type { ChatRegistry } from "../../src/chats/registry.js";
import { ChatStartRefusal, createChatRunner } from "../../src/chats/runner.js";
import type { ChatRunner } from "../../src/chats/runner.js";
import { createProjectHost } from "../../src/projects/host.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { taskRoutes } from "../../src/tasks/routes.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import {
  logOf,
  logUntil,
  plant,
  projectConfig,
  projectsRoot,
  requestsOf,
  send,
  startTestServer,
  target,
  taskFile,
  taskText,
  until,
} from "../helpers.js";
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
  /** The read of the login shell. Without it, a read fails the test. With `null`, the runner uses its own read. */
  shellEnv?: ((signal: AbortSignal) => Promise<ShellEnv>) | null;
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
  let unexpectedReads = 0;
  if (options.shellEnv === undefined) onTestFinished(() => expect(unexpectedReads, "reads of the shell").toBe(0));
  const unexpected = async (): Promise<ShellEnv> => {
    unexpectedReads += 1;
    return { failed: "The test reads no shell" };
  };
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
    shellEnv: options.shellEnv === null ? undefined : (options.shellEnv ?? unexpected),
    stderr: { write: (line: string) => errors.push(line) },
  });
  onTestFinished(() => runner.close());
  return { folder, chats, runner, feed, errors, processes: agents.processes, envs, server };
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
  const [first] = requestsOf(log);
  if (first === undefined) throw new Error("the log holds no request");
  return first;
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
      { kind: "permission", request: requestOf(log), permission: PERMISSION },
      { kind: "permission-resolved", request: requestOf(log), outcome: { outcome: "cancelled" } },
      { kind: "turn-end", stopReason: "end_turn" },
    ]);
    expect(feed.filter((event) => event.kind === "chat")).toEqual([
      chatState("working"),
      chatState("needs-you"),
      chatState("working"),
      chatState("needs-you"),
    ]);
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

  it("keeps each open request with its params until a client answers it", async () => {
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

    for (const [kind, params] of [["permission", PERMISSION], ["question", QUESTION]] as const) {
      const request = requestOf((await logUntil(live, kind)).filter((event) => event.kind === kind));
      const open = runner.running(live)?.open;
      expect([...open ?? []]).toEqual([[request, { kind, params, answer: expect.any(Function) as unknown }]]);
      if (kind === "permission") await runner.answerPermission(live, request, { optionId: "allow", client: "app" });
      else await runner.answerQuestion(live, request, { action: "decline", client: "app" });
      expect(open?.has(request)).toBe(false);
    }

    await logUntil(live, "turn-end");
    expect(answers).toEqual([{ outcome: { outcome: "selected", optionId: "allow" } }, { action: "decline" }]);
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

describe("createChatRunner.start with the environment of the login shell", () => {
  const DAEMON_ENV: AgentEnv = { PATH: "/usr/bin:/bin", HOME: "/home/alice" };
  const AGENT_PATH = "/opt/agent/bin";
  const SHELL_ENV: AgentEnv = { PATH: AGENT_PATH, HOME: "/home/alice", EDITOR: "vim" };

  /** An adapter that finds its binary only on the `PATH` that `installed` holds, and launches with the env it gets. */
  function pathAdapter(installed = { path: AGENT_PATH }) {
    const envs: AgentEnv[] = [];
    const adapter: AgentAdapter = {
      ...fakeAdapter().adapter,
      launch(env) {
        envs.push(env);
        return env.PATH === installed.path ? { ...LAUNCH, env } : { missing: "No agent binary" };
      },
    };
    return { adapter, envs, installed };
  }

  /** A read of the shell that gives `results` in order, and the last one after them. */
  function shellReads(...results: ShellEnv[]) {
    const signals: AbortSignal[] = [];
    const shellEnv = async (signal: AbortSignal): Promise<ShellEnv> => {
      signals.push(signal);
      return results[Math.min(signals.length, results.length) - 1]!;
    };
    return { shellEnv, signals };
  }

  /** A read of the shell that settles when the test releases it. */
  function heldRead() {
    const signals: AbortSignal[] = [];
    let release!: (result: ShellEnv) => void;
    const shellEnv = (signal: AbortSignal) => new Promise<ShellEnv>((resolve) => {
      signals.push(signal);
      release = resolve;
    });
    return { shellEnv, signals, release: (result: ShellEnv) => release(result) };
  }

  it("reads the login shell that SHELL of the daemon environment names, by default", async () => {
    const shell = join(await target(), "zsh");
    await writeFile(shell, `#!/bin/sh\nexport PATH=${AGENT_PATH}\nfor last; do :; done\n/bin/sh -c "$last"\n`, { mode: 0o755 });
    const { adapter } = pathAdapter();
    const env = { ...DAEMON_ENV, HOME: await target(), SHELL: shell };
    const { runner, processes } = await world({ adapter, env, shellEnv: null });

    await logUntil(await runner.start(START), "turn-end");

    expect(processes[0]?.launch.env).toEqual({ ...env, PATH: AGENT_PATH });
  });

  it("reads no shell when the adapter finds its binary in the environment of the daemon", async () => {
    const { adapter, envs } = pathAdapter({ path: DAEMON_ENV.PATH! });
    const { runner, processes } = await world({ adapter, env: DAEMON_ENV });

    await logUntil(await runner.start(START), "turn-end");

    expect(envs).toEqual([DAEMON_ENV]);
    expect(processes[0]?.launch.env).toEqual(DAEMON_ENV);
  });

  it("reads the shell one time when the binary is missing, and launches with the environment of the shell", async () => {
    const { adapter, envs } = pathAdapter();
    const { shellEnv, signals } = shellReads({ env: SHELL_ENV });
    const { runner, processes } = await world({ adapter, env: DAEMON_ENV, shellEnv });

    await logUntil(await runner.start(START), "turn-end");

    expect(signals).toHaveLength(1);
    expect(envs).toEqual([DAEMON_ENV, SHELL_ENV]);
    expect(processes[0]?.launch.env).toEqual(SHELL_ENV);
  });

  it("gives two starts at the same time one read", async () => {
    const { adapter } = pathAdapter();
    const read = heldRead();
    const { runner, processes } = await world({ adapter, env: DAEMON_ENV, shellEnv: read.shellEnv });

    const starts = Promise.all([runner.start(START), runner.start({ ...START, text: "Build the printer" })]);
    await until(() => read.signals.length > 0, "the shell is read");
    read.release({ env: SHELL_ENV });
    await starts;

    expect(read.signals).toHaveLength(1);
    expect(processes.map((fake) => fake.launch.env)).toEqual([SHELL_ENV, SHELL_ENV]);
  });

  it("launches a later chat with the kept environment, and reads no shell again", async () => {
    const { adapter, envs } = pathAdapter();
    const { shellEnv, signals } = shellReads({ env: SHELL_ENV });
    const { runner, processes } = await world({ adapter, env: DAEMON_ENV, shellEnv });

    await logUntil(await runner.start(START), "turn-end");
    await logUntil(await runner.start(START), "turn-end");

    expect(signals).toHaveLength(1);
    expect(envs).toEqual([DAEMON_ENV, SHELL_ENV, DAEMON_ENV, SHELL_ENV]);
    expect(processes.map((fake) => fake.launch.env)).toEqual([SHELL_ENV, SHELL_ENV]);
  });

  it("reads again when the kept environment has no binary, and keeps a new one only when the binary is in it", async () => {
    const moved: AgentEnv = { ...SHELL_ENV, PATH: "/opt/moved/bin" };
    const { adapter, installed } = pathAdapter();
    const { shellEnv, signals } = shellReads({ env: SHELL_ENV }, { env: SHELL_ENV }, { env: moved });
    const { runner, processes } = await world({ adapter, env: DAEMON_ENV, shellEnv });
    await logUntil(await runner.start(START), "turn-end");
    installed.path = moved.PATH!;

    const second = await runner.start(START);
    const third = await runner.start(START);
    await logUntil(third, "turn-end");
    await logUntil(await runner.start(START), "turn-end");

    expect(await logOf(second)).toEqual([USER, { kind: "failed", reason: "No agent binary" }]);
    expect(signals).toHaveLength(3);
    expect(processes.map((fake) => fake.launch.env)).toEqual([SHELL_ENV, moved, moved]);
  });

  it("fails with the text of the shell when the read fails, and reads again at the next start", async () => {
    const { adapter } = pathAdapter();
    const shellFailed = { failed: "Tasma could not read the environment of your login shell (/bin/zsh): it broke" };
    const { shellEnv, signals } = shellReads(shellFailed, { env: SHELL_ENV });
    const { runner, processes } = await world({ adapter, env: DAEMON_ENV, shellEnv });

    const first = await runner.start(START);
    await logUntil(await runner.start(START), "turn-end");

    expect(await logOf(first)).toEqual([USER, { kind: "failed", reason: shellFailed.failed }]);
    expect(signals).toHaveLength(2);
    expect(processes.map((fake) => fake.launch.env)).toEqual([SHELL_ENV]);
  });

  it("fails with the cause when the read of the shell throws, and the start does not reject", async () => {
    const { adapter } = pathAdapter();
    const shellEnv = () => {
      throw new Error("the shell broke");
    };
    const { runner, processes } = await world({ adapter, env: DAEMON_ENV, shellEnv });

    const live = await runner.start(START);

    expect(await logOf(live)).toEqual([USER, { kind: "failed", reason: "the shell broke" }]);
    expect(processes).toEqual([]);
  });

  it("fails with the text of the adapter when the environment of the shell has no binary either", async () => {
    const { adapter } = pathAdapter();
    const { shellEnv } = shellReads({ env: DAEMON_ENV });
    const { runner, processes } = await world({ adapter, env: DAEMON_ENV, shellEnv });

    const live = await runner.start(START);

    expect(await logOf(live)).toEqual([USER, { kind: "failed", reason: "No agent binary" }]);
    expect(processes).toEqual([]);
  });

  it("registers the process of the chat at the return of a start that waited for the shell", async () => {
    const { adapter } = pathAdapter();
    const read = heldRead();
    const { runner, processes } = await world({ adapter, env: DAEMON_ENV, shellEnv: read.shellEnv });

    const starting = runner.start(START);
    await until(() => read.signals.length > 0, "the shell is read");
    read.release({ env: SHELL_ENV });
    const live = await starting;

    expect(live.chat.state).toBe("working");
    expect(runner.running(live)?.process).toBe(processes[0]);
    await logUntil(live, "turn-end");
  });

  it("aborts a read at close and does not wait for it, and the chat gets no process", async () => {
    const { adapter } = pathAdapter();
    const read = heldRead();
    const { runner, processes } = await world({ adapter, env: DAEMON_ENV, shellEnv: read.shellEnv });
    const starting = runner.start(START);
    await until(() => read.signals.length > 0, "the shell is read");

    await runner.close();

    expect(read.signals[0]?.aborted).toBe(true);
    read.release({ env: SHELL_ENV });
    const live = await starting;
    expect(processes).toEqual([]);
    expect(runner.running(live)).toBeUndefined();
    expect(await logOf(live)).toEqual([USER]);
  });

  it("aborts a read at stopStarts, and the chat gets no process and no failure", async () => {
    const { adapter } = pathAdapter();
    const read = heldRead();
    const { runner, processes } = await world({ adapter, env: DAEMON_ENV, shellEnv: read.shellEnv });
    const starting = runner.start(START);
    await until(() => read.signals.length > 0, "the shell is read");

    runner.stopStarts();

    expect(read.signals[0]?.aborted).toBe(true);
    read.release({ failed: "Tasma could not read the environment of your login shell (/bin/zsh): the daemon is stopping" });
    const live = await starting;
    expect(processes).toEqual([]);
    expect(await logOf(live)).toEqual([USER]);
  });

  it("spawns no agent for a start after stopStarts, also with the binary on the PATH of the daemon", async () => {
    const { adapter } = pathAdapter({ path: DAEMON_ENV.PATH! });
    const { runner, processes } = await world({ adapter, env: DAEMON_ENV });

    runner.stopStarts();
    const live = await runner.start(START);

    expect(processes).toEqual([]);
    expect(await logOf(live)).toEqual([USER]);
  });
});

/**
 * A script whose prompts stay open until `finish`, or until a `session/cancel`
 * ends the oldest one with `cancelled`.
 */
function heldTurns(): { script: Script; finish: () => void } {
  const turns: ((result: PromptResponse) => void)[] = [];
  const script: Script = {
    prompt: () => new Promise((resolve) => turns.push(resolve)),
    cancel: () => turns.shift()?.({ stopReason: "cancelled" }),
  };
  return { script, finish: () => turns.shift()?.({ stopReason: "end_turn" }) };
}

const NEXT = { text: "Now the printer", client: "web" } as const;

describe("createChatRunner.message", () => {
  it("starts a turn after the end of the last one, and writes the message with its client first", async () => {
    const { runner, processes, feed } = await world({
      script: {
        async prompt(_params, agent) {
          await agent.update(text("Working"));
          return { stopReason: "end_turn" };
        },
      },
    });
    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    await runner.message(live, NEXT);
    const log = await logUntil(live, "turn-end");

    expect(log).toEqual([
      USER,
      filtered(text("Working")),
      { kind: "turn-end", stopReason: "end_turn" },
      { kind: "user", ...NEXT },
      filtered(text("Working")),
      { kind: "turn-end", stopReason: "end_turn" },
    ]);
    expect(processes[0]?.prompts.map((prompt) => prompt.prompt)).toEqual([
      [{ type: "text", text: START.text }],
      [{ type: "text", text: NEXT.text }],
    ]);
    expect(feed.filter((event) => event.kind === "chat")).toEqual([
      chatState("working"),
      chatState("needs-you"),
      chatState("working"),
      chatState("needs-you"),
    ]);
  });

  describe("refuses with turn-running", () => {
    it("during the first turn, before the session starts", async () => {
      const { runner } = await world({ script: { newSession: forever } });
      const live = await runner.start(START);

      await expect(runner.message(live, NEXT)).rejects.toMatchObject({ code: "turn-running" });
    });

    it("during a later turn", async () => {
      const { script, finish } = heldTurns();
      const { runner, processes } = await world({ script });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the first turn started");
      finish();
      await logUntil(live, "turn-end");
      await runner.message(live, NEXT);

      await expect(runner.message(live, { ...NEXT, client: "app" })).rejects.toMatchObject({ code: "turn-running" });
      expect((await logOf(live)).filter((event) => event.kind === "user")).toHaveLength(2);
    });

    it("while a permission request waits", async () => {
      const { runner } = await world({
        script: {
          async prompt(_params, agent) {
            void agent.permission().catch(() => undefined);
            return forever();
          },
        },
      });
      const live = await runner.start(START);
      await logUntil(live, "permission");

      expect(live.chat.state).toBe("needs-you");
      await expect(runner.message(live, NEXT)).rejects.toMatchObject({ code: "turn-running" });
    });

    it("after a cancel, until the cancelled turn ends", async () => {
      const { runner, processes } = await world({ script: { prompt: forever } });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");

      await runner.cancel(live, { client: "web" });

      await expect(runner.message(live, NEXT)).rejects.toMatchObject({ code: "turn-running" });
    });
  });

  it("accepts one of two messages sent in one synchronous step, and prompts the agent once", async () => {
    const { runner, processes } = await world();
    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    const sent = await Promise.allSettled([runner.message(live, NEXT), runner.message(live, { ...NEXT, client: "app" })]);

    expect(sent).toMatchObject([{ status: "fulfilled" }, { status: "rejected", reason: { code: "turn-running" } }]);
    await logUntil(live, "turn-end");
    expect(processes[0]?.prompts).toHaveLength(2);
    expect((await logOf(live)).filter((event) => event.kind === "user")).toEqual([USER, { kind: "user", ...NEXT }]);
  });

  it("accepts a message at once after the prompt result, and writes it after the turn end", async () => {
    const { runner } = await world();
    const live = await runner.start(START);
    const append = live.append.bind(live);
    let next: Promise<void> | undefined;
    vi.spyOn(live, "append").mockImplementation((event) => {
      const written = append(event);
      if (event.kind === "turn-end") next ??= runner.message(live, NEXT);
      return written;
    });

    await until(() => next !== undefined, "the first turn ended");
    await next;

    expect(await logUntil(live, "turn-end")).toEqual([
      USER,
      { kind: "turn-end", stopReason: "end_turn" },
      { kind: "user", ...NEXT },
      { kind: "turn-end", stopReason: "end_turn" },
    ]);
  });

  describe("refuses with chat-not-running", () => {
    it("a failed chat", async () => {
      const { runner } = await world({ adapter: fakeAdapter({ failed: "No agent here" }).adapter });
      const live = await runner.start(START);

      await expect(runner.message(live, NEXT)).rejects.toMatchObject({ code: "chat-not-running" });
    });

    it("a chat whose process exited with code 0 while idle", async () => {
      const { runner, processes } = await world();
      const live = await runner.start(START);
      await logUntil(live, "turn-end");
      processes[0]?.exit({ code: 0, signal: null });
      await until(() => runner.running(live) === undefined, "the chat stopped running");

      await expect(runner.message(live, NEXT)).rejects.toMatchObject({ code: "chat-not-running" });
    });

    it("a chat after close", async () => {
      const { runner } = await world();
      const live = await runner.start(START);
      await logUntil(live, "turn-end");
      await runner.close();

      await expect(runner.message(live, NEXT)).rejects.toMatchObject({ code: "chat-not-running" });
      expect((await logOf(live)).at(-1)).toEqual({ kind: "turn-end", stopReason: "end_turn" });
    });
  });

  it("rejects with chat-not-found when the task is deleted while the message is written, and ends the process", async () => {
    const { script, finish } = heldTurns();
    const { runner, server, processes, errors } = await world({ script });
    const live = await runner.start(START);
    await until(() => processes[0]?.prompts.length === 1, "the first turn started");
    finish();
    await logUntil(live, "turn-end");
    const append = live.append.bind(live);
    vi.spyOn(live, "append").mockImplementation(async (event) => {
      if (event.kind === "user") await send(server, "DELETE", "/projects/ALPHA/tasks/ALPHA-1");
      return append(event);
    });

    await expect(runner.message(live, NEXT)).rejects.toMatchObject({ code: "chat-not-found" });

    await endedByRunner(processes[0]);
    await until(() => runner.running(live) === undefined, "the chat stopped running");
    expect(errors).toEqual([]);
  });
});

describe("createChatRunner.cancel", () => {
  it("sends session/cancel, resolves each open request in the name of the client, and ends the turn", async () => {
    const answers: unknown[] = [];
    const withdraw = new AbortController();
    let stop!: (result: PromptResponse) => void;
    const { runner, processes } = await world({
      script: {
        prompt(_params, agent) {
          void agent.permission({}, withdraw.signal).then((answer) => answers.push(answer));
          void agent.question({}, withdraw.signal).then((answer) => answers.push(answer));
          return new Promise((resolve) => (stop = resolve));
        },
        cancel() {
          // As the adapter does: it withdraws its open requests, and then ends the prompt.
          withdraw.abort();
          stop({ stopReason: "cancelled" });
        },
      },
    });
    const live = await runner.start(START);
    const [permission, question] = requestsOf(await logUntil(live, "question"));

    await runner.cancel(live, { client: "web" });

    expect(await logUntil(live, "turn-end")).toEqual([
      USER,
      { kind: "permission", request: permission, permission: PERMISSION },
      { kind: "question", request: question, question: QUESTION },
      { kind: "permission-resolved", request: permission, outcome: { outcome: "cancelled" }, client: "web" },
      { kind: "question-resolved", request: question, answer: { action: "cancel" }, client: "web" },
      { kind: "turn-end", stopReason: "cancelled" },
    ]);
    expect(processes[0]?.cancels).toEqual([{ sessionId: SESSION }]);
    await until(() => answers.length === 2, "the agent got both answers");
    expect(answers).toEqual([{ outcome: { outcome: "cancelled" } }, { action: "cancel" }]);
  });

  it("does nothing when no turn runs, and for a chat that does not run", async () => {
    const { runner, processes } = await world();
    const live = await runner.start(START);
    const before = await logUntil(live, "turn-end");

    await runner.cancel(live, { client: "web" });
    await new Promise((resolve) => setImmediate(resolve));
    await runner.close();
    await runner.cancel(live, { client: "web" });

    expect(await logOf(live)).toEqual(before);
    expect(processes[0]?.cancels).toEqual([]);
  });

  describe("before the first prompt is sent", () => {
    /** Cancels while `held` holds the start: the first turn ends with no prompt, and a later message runs. */
    async function cancelled(setup: World, held: { started: () => boolean; release: () => void }): Promise<void> {
      const { runner, processes } = setup;
      const live = await runner.start(START);
      await until(held.started, "the start is held");

      await runner.cancel(live, { client: "web" });
      held.release();

      expect(await logUntil(live, "turn-end")).toEqual([USER, { kind: "turn-end", stopReason: "cancelled" }]);
      expect(processes[0]?.prompts).toEqual([]);
      expect(processes[0]?.cancels).toEqual([]);
      expect(live.chat.session).toBe(SESSION);

      await runner.message(live, NEXT);
      await logUntil(live, "turn-end");
      expect(processes[0]?.prompts.map((prompt) => prompt.prompt)).toEqual([[{ type: "text", text: NEXT.text }]]);
    }

    it("while session/new runs", async () => {
      let release!: () => void;
      const setup = await world({
        script: { newSession: () => new Promise((resolve) => (release = () => resolve({ sessionId: SESSION }))) },
      });

      await cancelled(setup, { started: () => setup.processes[0]?.newSession !== undefined, release: () => release() });
    });

    it("while the session id is written", async () => {
      let release: (() => void) | undefined;
      const setup = await world({
        chats: (chats) => ({
          ...chats,
          async create(...args) {
            const live = await chats.create(...args);
            const setSession = live.setSession.bind(live);
            vi.spyOn(live, "setSession").mockImplementation(async (session) => {
              await new Promise<void>((resolve) => (release = resolve));
              await setSession(session);
            });
            return live;
          },
        }),
      });

      await cancelled(setup, { started: () => release !== undefined, release: () => release?.() });
    });
  });

  it("resolves a request still open at the prompt result as cancelled, with no client", async () => {
    const answers: unknown[] = [];
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          void agent.question().then((answer) => answers.push(answer));
          return { stopReason: "end_turn" };
        },
      },
    });
    const live = await runner.start(START);

    const log = await logUntil(live, "turn-end");

    expect(log).toEqual([
      USER,
      { kind: "question", request: requestOf(log), question: QUESTION },
      { kind: "question-resolved", request: requestOf(log), answer: { action: "cancel" } },
      { kind: "turn-end", stopReason: "end_turn" },
    ]);
    await until(() => answers.length === 1, "the agent got the answer");
    expect(answers).toEqual([{ action: "cancel" }]);
    await expect(runner.answerQuestion(live, requestOf(log), { action: "decline", client: "web" }))
      .rejects.toMatchObject({ code: "already-answered" });
  });
});

describe("createChatRunner.answerPermission", () => {
  it("gives the agent the option, and writes the resolution with the client before the next update", async () => {
    const answers: unknown[] = [];
    const { runner, feed } = await world({
      script: {
        async prompt(_params, agent) {
          answers.push(await agent.permission());
          await agent.update(text("Built"));
          return { stopReason: "end_turn" };
        },
      },
    });
    const live = await runner.start(START);
    const request = requestOf(await logUntil(live, "permission"));

    await runner.answerPermission(live, request, { optionId: "reject", client: "web" });

    expect(await logUntil(live, "turn-end")).toEqual([
      USER,
      { kind: "permission", request, permission: PERMISSION },
      { kind: "permission-resolved", request, outcome: { outcome: "selected", optionId: "reject" }, client: "web" },
      filtered(text("Built")),
      { kind: "turn-end", stopReason: "end_turn" },
    ]);
    expect(answers).toEqual([{ outcome: { outcome: "selected", optionId: "reject" } }]);
    expect(feed.filter((event) => event.kind === "chat")).toEqual([
      chatState("working"),
      chatState("needs-you"),
      chatState("working"),
      chatState("needs-you"),
    ]);
  });

  it("refuses with malformed-request an option the request does not offer, and a question", async () => {
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          void agent.permission().catch(() => undefined);
          void agent.question().catch(() => undefined);
          return forever();
        },
      },
    });
    const live = await runner.start(START);
    const log = await logUntil(live, "question");
    const [permission, question] = requestsOf(log);

    await expect(runner.answerPermission(live, permission!, { optionId: "maybe", client: "web" }))
      .rejects.toMatchObject({ code: "malformed-request" });
    await expect(runner.answerPermission(live, question!, { optionId: "allow", client: "web" }))
      .rejects.toMatchObject({ code: "malformed-request", message: expect.stringContaining("is a question, not a permission request") as string });

    expect(runner.running(live)?.open.size).toBe(2);
    expect(await logOf(live)).toEqual(log);
  });

  it("refuses with already-answered a second answer, a withdrawn request, a cancelled request and an unknown id", async () => {
    const withdraw = new AbortController();
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          for (const signal of [undefined, withdraw.signal, undefined]) {
            void agent.permission({}, signal).catch(() => undefined);
          }
          return forever();
        },
      },
    });
    const live = await runner.start(START);
    await until(() => live.fold.open.length === 3, "three permission requests are open");
    const [first, withdrawn, cancelled] = live.fold.open;
    const answer = { optionId: "allow", client: "web" };

    await runner.answerPermission(live, first!, answer);
    withdraw.abort();
    await until(() => !live.fold.open.includes(withdrawn!), "the agent withdrew its request");
    await runner.cancel(live, { client: "app" });

    for (const request of [first!, withdrawn!, cancelled!, "unknown"]) {
      await expect(runner.answerPermission(live, request, { ...answer, client: "app" }))
        .rejects.toMatchObject({ code: "already-answered" });
    }
    expect((await logOf(live)).filter((event) => event.kind === "permission-resolved")).toEqual([
      { kind: "permission-resolved", request: first, outcome: { outcome: "selected", optionId: "allow" }, client: "web" },
      { kind: "permission-resolved", request: withdrawn, outcome: { outcome: "cancelled" } },
      { kind: "permission-resolved", request: cancelled, outcome: { outcome: "cancelled" }, client: "app" },
    ]);
  });

  it("refuses after close with chat-not-running a request the log shows open, and with already-answered another", async () => {
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          void agent.permission().catch(() => undefined);
          return forever();
        },
      },
    });
    const live = await runner.start(START);
    const request = requestOf(await logUntil(live, "permission"));
    await runner.close();

    await expect(runner.answerPermission(live, request, { optionId: "allow", client: "web" }))
      .rejects.toMatchObject({ code: "chat-not-running" });
    await expect(runner.answerPermission(live, "unknown", { optionId: "allow", client: "web" }))
      .rejects.toMatchObject({ code: "already-answered" });
  });
});

describe("createChatRunner.answerQuestion", () => {
  it("gives the agent an accepted answer and a decline unchanged, and writes each with its client", async () => {
    const answers: unknown[] = [];
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          answers.push(await agent.question());
          answers.push(await agent.question());
          return { stopReason: "end_turn" };
        },
      },
    });
    const live = await runner.start(START);
    const content = { parser: "peg", depth: 2, strict: true, tags: ["fast", "small"] };

    const first = requestOf(await logUntil(live, "question"));
    await runner.answerQuestion(live, first, { action: "accept", content, client: "web" });
    const second = requestsOf(await logUntil(live, "question")).at(-1)!;
    await runner.answerQuestion(live, second, { action: "decline", client: "app" });

    expect(await logUntil(live, "turn-end")).toEqual([
      USER,
      { kind: "question", request: first, question: QUESTION },
      { kind: "question-resolved", request: first, answer: { action: "accept", content }, client: "web" },
      { kind: "question", request: second, question: QUESTION },
      { kind: "question-resolved", request: second, answer: { action: "decline" }, client: "app" },
      { kind: "turn-end", stopReason: "end_turn" },
    ]);
    expect(answers).toEqual([{ action: "accept", content }, { action: "decline" }]);
  });

  it("refuses a permission request with malformed-request", async () => {
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          void agent.permission().catch(() => undefined);
          return forever();
        },
      },
    });
    const live = await runner.start(START);
    const request = requestOf(await logUntil(live, "permission"));

    await expect(runner.answerQuestion(live, request, { action: "decline", client: "web" }))
      .rejects.toMatchObject({ code: "malformed-request", message: expect.stringContaining("is a permission request, not a question") as string });
    expect(runner.running(live)?.open.has(request)).toBe(true);
  });
});

describe("createChatRunner failures", () => {
  it("fails with the text of the launch, and starts no process", async () => {
    const { runner, processes, feed } = await world({ adapter: fakeAdapter({ failed: "No agent here" }).adapter });

    const live = await runner.start(START);

    expect(await logOf(live)).toEqual([USER, { kind: "failed", reason: "No agent here" }]);
    expect(live.chat.state).toBe("failed");
    expect(feed.filter((event) => event.kind === "chat")).toEqual([chatState("working"), chatState("failed")]);
    expect(processes).toEqual([]);
    expect(runner.running(live)).toBeUndefined();
  });

  it("fails with the install text of the real Claude adapter when PATH holds no claude", async () => {
    const { runner } = await world({
      adapter: claudeAdapter,
      env: { PATH: await target() },
      shellEnv: async () => ({ env: { PATH: "" } }),
    });

    const live = await runner.start(START);

    expect(live.chat.state).toBe("failed");
    expect(await logOf(live)).toEqual([USER, { kind: "failed", reason: "Claude Code is not installed" }]);
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
    expect((await logOf(live)).at(-1)).toEqual({ kind: "turn-end", stopReason: "end_turn" });
  });

  it("writes nothing when the process exits with code 0 between turns", async () => {
    const { runner, processes } = await world();
    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    processes[0]?.exit({ code: 0, signal: null });
    await processes[0]?.ended;
    await until(() => runner.running(live) === undefined, "the chat stopped running");

    expect((await logOf(live)).at(-1)).toEqual({ kind: "turn-end", stopReason: "end_turn" });
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

  it("writes no turn end for a prompt result that comes after a fault of the log", async () => {
    let finish!: () => void;
    const { runner, processes } = await world({
      script: {
        prompt: (_params, agent) => new Promise((resolve) => {
          finish = () => {
            void agent.update(text("late")).catch(() => undefined);
            resolve({ stopReason: "end_turn" });
          };
        }),
      },
      started: slowEnd(100),
    });
    const live = await runner.start(START);
    await until(() => processes[0]?.prompts.length === 1, "the turn started");
    const append = vi.spyOn(live, "append").mockRejectedValue(new Error("the disk is gone"));

    finish();
    await processes[0]?.ended;

    expect(append.mock.calls.map(([event]) => event.kind)).toEqual(["update"]);
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
    expect(await logOf(live)).toEqual([USER]);
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
    const before = [await logOf(live), await logOf(second)];

    await runner.close();

    expect(processes.map((fake) => fake.endCalls > 0)).toEqual([true, true]);
    expect(await Promise.all(processes.map((fake) => fake.ended))).toEqual([
      { code: 0, signal: null },
      { code: 0, signal: null },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect([await logOf(live), await logOf(second)]).toEqual(before);
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

    expect(await logOf(live)).toEqual(before);
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
    expect(await logOf(live)).toEqual([USER]);
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
