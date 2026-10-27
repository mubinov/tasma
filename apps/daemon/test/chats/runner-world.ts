// The chat runner of the tests: a daemon over one project with a fake agent,
// and the helpers that the runner tests share.

import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import type { PromptResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import { openAgentDefaults } from "@tasma/engine";
import type { AcpObject, ChatEvent, FeedEvent } from "@tasma/protocol";
import type { AgentProcess } from "../../src/agents/acp.js";
import type { AgentAdapter, AgentEnv, AgentLaunch } from "../../src/agents/adapter.js";
import type { ShellEnv } from "../../src/agents/shell-env.js";
import { createChatRegistry } from "../../src/chats/registry.js";
import type { IdleLimit } from "../../src/chats/idle.js";
import type { ChatRegistry } from "../../src/chats/registry.js";
import { createChatRunner } from "../../src/chats/runner.js";
import type { ChatRunner } from "../../src/chats/runner.js";
import { createProjectHost } from "../../src/projects/host.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { taskRoutes } from "../../src/tasks/routes.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import { plant, projectConfig, projectsRoot, requestsOf, startTestServer, target, taskFile, taskText, until } from "../helpers.js";
import type { TestServer } from "../helpers.js";
import { fakeAgent } from "../agents/fake-agent.js";
import type { FakeProcess, Script } from "../agents/fake-agent.js";

export const START = { tag: "ALPHA", task: "ALPHA-1", step: "dev:build", agent: "claude", text: "Build the parser", client: "app" } as const;

export const LAUNCH: AgentLaunch = { command: "fake-agent", args: [], env: {} };

/** An adapter that launches the fake agent, records the environment it gets, and marks each update it filters. */
export function fakeAdapter(launch: AgentLaunch | { failed: string } = LAUNCH) {
  const envs: AgentEnv[] = [];
  const adapter: AgentAdapter = {
    agent: "claude",
    launch(env) {
      envs.push(env);
      return launch;
    },
    notLoggedIn: "Log in to the agent first",
    sessionGone: "The agent lost the chat",
    filterUpdate: (update) => ({ ...update, filtered: true }),
  };
  return { adapter, envs };
}

export type World = {
  root: string;
  folder: string;
  chats: ChatRegistry;
  runner: ChatRunner;
  /** The queue of the registry, in which a test can hold the turns of the chat writes. */
  writes: WriteQueue;
  feed: FeedEvent[];
  errors: string[];
  processes: FakeProcess[];
  envs: AgentEnv[];
  server: TestServer;
};

export type WorldOptions = {
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
  /** Without it, the runner uses its default limit, which no test reaches. */
  idleLimit?: IdleLimit;
  /** Without it, the runner uses its default wait of `end`. */
  endGraceMs?: number;
};

/** A daemon over project ALPHA, whose folder is a directory, with the task ALPHA-1. */
export async function world(options: WorldOptions = {}): Promise<World> {
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
    idleLimit: options.idleLimit,
    endGraceMs: options.endGraceMs,
    stderr: { write: (line: string) => errors.push(line) },
    defaults: openAgentDefaults(root),
  });
  onTestFinished(() => runner.close());
  return { root, folder, chats, runner, writes, feed, errors, processes: agents.processes, envs, server };
}

/** The file of the config option defaults of the tree. */
export function defaultsFile(root: string): string {
  return join(root, "agent-defaults.json");
}

/** A list of options as the daemon writes it to the log. */
export function optionsUpdate(configOptions: SessionConfigOption[]): ChatEvent {
  return { kind: "update", update: { sessionUpdate: "config_option_update", configOptions } };
}

/** The `current_mode_update` of the agent as the log keeps it. */
export function modeUpdate(currentModeId: string): ChatEvent {
  return filtered({ sessionUpdate: "current_mode_update", currentModeId });
}

export const PICK = { configId: "mode", value: "acceptEdits", client: "web" } as const;

/** A promise and the function that resolves it. */
export function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

export const USER: ChatEvent = { kind: "user", text: START.text, client: START.client };

export function filtered(update: AcpObject): ChatEvent {
  return { kind: "update", update: { ...update, filtered: true } };
}

export function chatState(state: "working" | "needs-you" | "failed"): FeedEvent {
  return { kind: "chat", tag: "ALPHA", task: "ALPHA-1", chat: 1, step: START.step, state };
}

/** The id the daemon gave the open request of the log, which a resolution names. */
export function requestOf(log: ChatEvent[]): string {
  const [first] = requestsOf(log);
  if (first === undefined) throw new Error("the log holds no request");
  return first;
}

/** Waits until the runner has ended the process. */
export async function endedByRunner(fake: FakeProcess | undefined): Promise<void> {
  await until(() => (fake?.endCalls ?? 0) > 0, "the runner ended the process");
}

/**
 * Makes each process exit `ms` after the runner ends it, as a real agent does
 * after its stdin closes. `first` runs when the end starts.
 */
export function slowEnd(ms: number, first: () => void = () => {}): (fake: FakeProcess) => void {
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

/**
 * A script whose prompts stay open until `finish`, or until a `session/cancel`
 * ends the oldest one with `cancelled`.
 */
export function heldTurns(): { script: Script; finish: () => void } {
  const turns: ((result: PromptResponse) => void)[] = [];
  const script: Script = {
    prompt: () => new Promise((resolve) => turns.push(resolve)),
    cancel: () => turns.shift()?.({ stopReason: "cancelled" }),
  };
  return { script, finish: () => turns.shift()?.({ stopReason: "end_turn" }) };
}

export const NEXT = { text: "Now the printer", client: "web" } as const;
