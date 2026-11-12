import { existsSync, mkdirSync } from "node:fs";
import { chmod, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentOptionsEntry } from "@tasma/engine";
import type { ChatAgent } from "@tasma/protocol";
import type { AgentAdapter, AgentLaunch } from "../../src/agents/adapter.js";
import { createOptionRefresh } from "../../src/chats/option-refresh.js";
import { target, until } from "../helpers.js";
import { fakeAgent, forever, modelOption, modeOption, SESSION, text } from "../agents/fake-agent.js";
import type { Script } from "../agents/fake-agent.js";
import { fakeAdapter, gate, LAUNCH, OPTIONS_META } from "./runner-world.js";

/** What runs before and after each `mkdir`, when a test sets it. */
const making = vi.hoisted(() => ({
  before: undefined as ((path: string) => void) | undefined,
  after: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();

  return {
    ...actual,
    async mkdir(...args: Parameters<typeof actual.mkdir>) {
      making.before?.(String(args[0]));
      const made = await actual.mkdir(...args);
      making.after?.(String(args[0]));
      return made;
    },
  };
});

const OPTIONS = [modeOption(), modelOption()];

const DAY_MS = 24 * 60 * 60_000;

const MAX_AGE_MS = 7 * DAY_MS;

const PAUSE_MS = 10 * 60_000;

const WORK_FOLDER = "tasma-options-claude";

/** A list written `ms` before now. A negative `ms` is a time in the future. */
function storedAgo(ms: number, options: SessionConfigOption[] = OPTIONS): AgentOptionsEntry {
  return { options, updated: new Date(Date.now() - ms).toISOString() };
}

function notRefreshed(cause: string): string {
  return `tasma-daemon: the options of claude are not refreshed: ${cause}\n`;
}

type Setup = {
  script?: Script;
  adapters?: AgentAdapter[];
  launch?: (adapter: AgentAdapter) => Promise<AgentLaunch | { failed: string }>;
  /** What `keep` resolves. */
  keeps?: boolean;
  workParent?: string;
  limitMs?: number;
};

/**
 * A refresh over the fake agent, whose `keep` records each list it gets, and
 * its stderr, its signal and its work parent.
 */
async function refreshing(setup: Setup = {}) {
  const agents = fakeAgent({ configOptions: OPTIONS, ...setup.script });
  const kept: { agent: ChatAgent; options: SessionConfigOption[] }[] = [];
  const launches: AgentAdapter[] = [];
  const errors: string[] = [];
  const stopping = new AbortController();
  const workParent = setup.workParent ?? join(await target(), "Caches");
  const launch = setup.launch ?? (async () => LAUNCH);
  const refresh = createOptionRefresh({
    adapters: setup.adapters ?? [fakeAdapter().adapter],
    launch: (adapter) => {
      launches.push(adapter);
      return launch(adapter);
    },
    spawn: agents.spawn,
    keep: async (agent, options) => {
      kept.push({ agent, options });
      return setup.keeps ?? true;
    },
    signal: stopping.signal,
    stderr: { write: (line: string) => errors.push(line) },
    workParent,
    limitMs: setup.limitMs,
  });
  onTestFinished(async () => {
    stopping.abort();
    await refresh.settled();
  });
  return { refresh, processes: agents.processes, kept, launches, errors, stopping, workParent };
}

/** A script whose `session/new` runs `before` and then opens the session. */
function opening(before: (cwd: string) => Promise<void>): Script {
  return {
    async newSession(params, fake) {
      await before(params.cwd);
      return { sessionId: SESSION, configOptions: fake.configOptions };
    },
  };
}

describe("a refresh of the options", () => {
  it("opens a session with no message in its work folder, keeps the options, ends the agent and removes the folder", async () => {
    let seen: { entries: string[]; mode: number } | undefined;
    const { refresh, processes, kept, errors, workParent } = await refreshing({
      script: opening(async (cwd) => {
        seen = { entries: await readdir(cwd), mode: (await stat(cwd)).mode & 0o777 };
      }),
    });

    refresh.ask("claude", undefined);
    await refresh.settled();

    const folder = join(await realpath(workParent), WORK_FOLDER);
    expect(processes).toHaveLength(1);
    expect(processes[0]?.launch).toBe(LAUNCH);
    expect(processes[0]?.folder).toBe(folder);
    expect(processes[0]?.newSession).toEqual({ cwd: folder, mcpServers: [], _meta: OPTIONS_META });
    expect(processes[0]?.prompts).toEqual([]);
    expect(processes[0]?.endCalls).toBeGreaterThan(0);
    expect(seen).toEqual({ entries: [], mode: 0o700 });
    expect(kept).toEqual([{ agent: "claude", options: OPTIONS }]);
    expect(existsSync(folder)).toBe(false);
    expect((await stat(workParent)).mode & 0o777).toBe(0o700);
    expect(errors).toEqual([]);
  });

  it.each([
    ["a list of now", storedAgo(0)],
    ["a list of 1 minute less than 7 days ago", storedAgo(MAX_AGE_MS - 60_000)],
  ])("starts nothing for %s", async (_name, entry: AgentOptionsEntry) => {
    const { refresh, processes, launches } = await refreshing();

    refresh.ask("claude", entry);
    await refresh.settled();

    expect(processes).toEqual([]);
    expect(launches).toEqual([]);
  });

  it.each([
    ["a list of 7 days and 1 ms ago", storedAgo(MAX_AGE_MS + 1)],
    ["a time that does not parse", { options: OPTIONS, updated: "yesterday" }],
    ["a time 8 days in the future", storedAgo(-8 * DAY_MS)],
    ["a list of now with no options", storedAgo(0, [])],
  ])("starts one refresh for %s", async (_name, entry: AgentOptionsEntry) => {
    const { refresh, processes, launches } = await refreshing();

    refresh.ask("claude", entry);
    await refresh.settled();

    expect(processes).toHaveLength(1);
    expect(launches).toHaveLength(1);
  });

  it("replaces a folder that an earlier run left at the path of the work folder, and removes it at the end", async () => {
    const workParent = join(await target(), "Caches");
    const left = join(workParent, WORK_FOLDER);
    await mkdir(join(left, "old"), { recursive: true });
    await writeFile(join(left, "old", "file"), "");
    let entries: string[] | undefined;
    const { refresh, kept } = await refreshing({
      workParent,
      script: opening(async (cwd) => {
        entries = await readdir(cwd);
      }),
    });

    refresh.ask("claude", undefined);
    await refresh.settled();

    expect(entries).toEqual([]);
    expect(kept).toHaveLength(1);
    expect(existsSync(left)).toBe(false);
  });

  it("starts one agent for the asks that come while it runs, and a new one for an ask after it", async () => {
    const opened = gate();
    const { refresh, processes, kept } = await refreshing({ script: opening(() => opened.opened) });

    refresh.ask("claude", undefined);
    await until(() => processes[0]?.newSession !== undefined, "the agent opens a session");
    refresh.ask("claude", undefined);
    refresh.ask("claude", storedAgo(MAX_AGE_MS + 1));
    opened.open();
    await refresh.settled();

    expect(processes).toHaveLength(1);
    expect(kept).toHaveLength(1);

    refresh.ask("claude", undefined);
    await refresh.settled();

    expect(processes).toHaveLength(2);
  });

  it("answers a permission request and a question of the agent at once with cancel, and ignores its updates", async () => {
    const answers: unknown[] = [];
    const { refresh, kept, errors } = await refreshing({
      script: {
        async newSession(_params, fake) {
          await fake.update(text("Loading"));
          answers.push(await fake.permission(), await fake.question());
          return { sessionId: SESSION, configOptions: fake.configOptions };
        },
      },
    });

    refresh.ask("claude", undefined);
    await refresh.settled();

    expect(answers).toEqual([{ outcome: { outcome: "cancelled" } }, { action: "cancel" }]);
    expect(kept).toEqual([{ agent: "claude", options: OPTIONS }]);
    expect(errors).toEqual([]);
  });

  it("starts nothing for an agent with no adapter, nor for an adapter with no options meta", async () => {
    const plain: AgentAdapter = { ...fakeAdapter().adapter, agent: "codex", optionsSessionMeta: undefined };
    const { refresh, processes, launches, errors } = await refreshing({ adapters: [plain] });

    refresh.ask("codex", undefined);
    refresh.ask("claude", undefined);
    await refresh.settled();

    expect(launches).toEqual([]);
    expect(processes).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("a failed refresh", () => {
  it.each<[string, Setup, string]>([
    ["a launch that fails", { launch: async () => ({ failed: "Claude Code is not installed" }) }, "Claude Code is not installed"],
    [
      "an agent that refuses the session with auth_required",
      { script: { newSession: () => Promise.reject(RequestError.authRequired()) } },
      "Log in to the agent first",
    ],
    [
      "an agent that refuses the session with another error",
      { script: { newSession: () => Promise.reject(RequestError.internalError(undefined, "the models are not loaded")) } },
      "Internal error: the models are not loaded",
    ],
    [
      "an agent that fails the session with an error of its own",
      { script: { newSession: () => Promise.reject(RequestError.internalError({ details: "the CLI exited with code 1" })) } },
      "the CLI exited with code 1",
    ],
    [
      "an agent that ends before it opens a session",
      {
        script: {
          newSession(_params, fake) {
            fake.exit({ code: 1, signal: null });
            return forever();
          },
        },
      },
      "the agent ended before it opened a session",
    ],
    ["a session with no options", { script: { configOptions: [] } }, "the agent opened a session with no options"],
    [
      "a session that does not open in the limit",
      { script: { newSession: () => forever() }, limitMs: 50 },
      "the agent did not open a session in 0.05 seconds",
    ],
  ])("writes one line for %s, keeps nothing, ends the agent and removes the folder", async (_name, setup, cause) => {
    const { refresh, processes, kept, errors, workParent } = await refreshing(setup);

    refresh.ask("claude", undefined);
    await refresh.settled();

    expect(errors).toEqual([notRefreshed(cause)]);
    expect(kept).toEqual([]);
    expect(processes.every((fake) => fake.endCalls > 0)).toBe(true);
    expect(existsSync(join(workParent, WORK_FOLDER))).toBe(false);
  });

  it("writes one line and starts no agent when another process takes the name of the work folder before it is made", async () => {
    const { refresh, processes, errors, workParent } = await refreshing();
    making.before = (path) => {
      if (path.endsWith(WORK_FOLDER)) mkdirSync(path);
    };
    onTestFinished(() => (making.before = undefined));

    refresh.ask("claude", undefined);
    await refresh.settled();

    const folder = join(await realpath(workParent), WORK_FOLDER);
    expect(errors).toEqual([notRefreshed(`EEXIST: file already exists, mkdir '${folder}'`)]);
    expect(processes).toEqual([]);
    expect(existsSync(folder)).toBe(false);
  });

  it.each([
    ["its group can write to", async () => {
      const folder = await target();
      await chmod(folder, 0o770);
      return folder;
    }],
    ["cannot be made", async () => {
      const file = join(await target(), "file");
      await writeFile(file, "");
      return join(file, "Caches");
    }],
  ])("writes one line and starts no agent for a work parent that %s", async (_name, folderOf: () => Promise<string>) => {
    const workParent = await folderOf();
    const { refresh, processes, errors } = await refreshing({ workParent });

    refresh.ask("claude", undefined);
    await refresh.settled();

    expect(errors).toEqual([
      notRefreshed(
        `${workParent} is not a safe folder: it cannot be made, or another account can write to it or to a folder above it`,
      ),
    ]);
    expect(processes).toEqual([]);
    expect(existsSync(join(workParent, WORK_FOLDER))).toBe(false);
  });

  it("pauses the refreshes of the agent for 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    onTestFinished(() => void vi.useRealTimers());
    const { refresh, processes, errors } = await refreshing({ script: { configOptions: [] } });

    refresh.ask("claude", undefined);
    await refresh.settled();
    vi.advanceTimersByTime(PAUSE_MS - 1);
    refresh.ask("claude", undefined);
    await refresh.settled();

    expect(processes).toHaveLength(1);

    vi.advanceTimersByTime(1);
    refresh.ask("claude", undefined);
    await refresh.settled();

    expect(processes).toHaveLength(2);
    expect(errors).toHaveLength(2);
  });

  it("writes no line of its own when the write of the list fails, and pauses", async () => {
    const { refresh, processes, kept, errors } = await refreshing({ keeps: false });

    refresh.ask("claude", undefined);
    await refresh.settled();
    refresh.ask("claude", undefined);
    await refresh.settled();

    expect(kept).toHaveLength(1);
    expect(processes).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

describe("the stop of a refresh", () => {
  it("ends the agent and removes the folder before settled() resolves, writes nothing, and starts no refresh after it", async () => {
    const script: Script = { newSession: () => forever() };
    const { refresh, processes, kept, errors, stopping } = await refreshing({ script });
    refresh.ask("claude", undefined);
    await until(() => processes[0]?.newSession !== undefined, "the agent opens a session");

    stopping.abort();
    await refresh.settled();

    expect(processes[0]?.endCalls).toBeGreaterThan(0);
    expect(existsSync(processes[0]!.folder)).toBe(false);
    expect(kept).toEqual([]);
    expect(errors).toEqual([]);

    refresh.ask("claude", undefined);
    await refresh.settled();

    expect(processes).toHaveLength(1);
  });

  it.each<[string, AgentLaunch | { failed: string }]>([
    ["a launch that fails", { failed: "Tasma could not read the environment of your login shell (zsh): stopped" }],
    ["a launch", LAUNCH],
  ])("during the launch writes no line for %s, and makes no work folder", async (_name, result) => {
    const launched = gate();
    const { refresh, processes, errors, stopping, workParent } = await refreshing({
      launch: async () => {
        await launched.opened;
        return result;
      },
    });

    refresh.ask("claude", undefined);
    stopping.abort();
    launched.open();
    await refresh.settled();

    expect(errors).toEqual([]);
    expect(processes).toEqual([]);
    expect(existsSync(join(workParent, WORK_FOLDER))).toBe(false);
  });

  it("after the work folder is made starts no agent, and removes the folder", async () => {
    const { refresh, processes, errors, stopping, workParent } = await refreshing();
    making.after = (path) => {
      if (path.endsWith(WORK_FOLDER)) stopping.abort();
    };
    onTestFinished(() => (making.after = undefined));

    refresh.ask("claude", undefined);
    await refresh.settled();

    expect(stopping.signal.aborted).toBe(true);
    expect(processes).toEqual([]);
    expect(errors).toEqual([]);
    expect(existsSync(join(workParent, WORK_FOLDER))).toBe(false);
  });
});
