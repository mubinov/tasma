// A chat with the user's real `claude`, through the real adapter. It runs only
// with TASMA_REAL_CLAUDE=1, and needs CLAUDE_CODE_OAUTH_TOKEN: the HOME of each
// test file is a new temporary directory, which holds no login. The case of
// the compiled agent mode also needs TASMA_COMPILED_DAEMON, the path of a
// daemon that `scripts/app-binaries.sh` compiled.

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import { openAgentDefaults } from "@tasma/engine";
import type { ChatEvent } from "@tasma/protocol";
import type { AgentAdapter, AgentEnv, AgentLaunch, LaunchResult } from "../../src/agents/adapter.js";
import { claudeAdapter } from "../../src/agents/claude.js";
import { createChatRegistry } from "../../src/chats/registry.js";
import type { LiveChat } from "../../src/chats/registry.js";
import { createChatRunner } from "../../src/chats/runner.js";
import type { ChatRunner } from "../../src/chats/runner.js";
import { createProjectHost } from "../../src/projects/host.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import { logOf, plant, projectConfig, projectsRoot, target, taskFile, taskText } from "../helpers.js";

const TURN_MS = 120_000;

const PING = "Reply with the single word: pong";

function token(): string {
  const value = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!value) throw new Error("set CLAUDE_CODE_OAUTH_TOKEN to a token from `claude setup-token`");
  return value;
}

function launched(launch: LaunchResult): AgentLaunch {
  if (!("command" in launch)) throw new Error(JSON.stringify(launch));
  return launch;
}

/** A runner over project ALPHA with the task ALPHA-1, and the folder of the project. */
async function world(
  adapter: AgentAdapter,
  env: AgentEnv,
): Promise<{ runner: ChatRunner; folder: string; root: string }> {
  const root = await projectsRoot("ALPHA");
  const folder = await target();
  await plant(projectConfig(root, "ALPHA"), `path: ${folder}\n`);
  await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskText("ALPHA-1"));
  const host = createProjectHost({ root });
  onTestFinished(() => host.close());
  const chats = createChatRegistry({ root, host, writes: new WriteQueue() });
  const runner = createChatRunner({ root, chats, adapters: [adapter], env, defaults: openAgentDefaults(root) });
  onTestFinished(() => runner.close());
  return { runner, folder, root };
}

function start(runner: ChatRunner): Promise<LiveChat> {
  return runner.start({ tag: "ALPHA", task: "ALPHA-1", step: "dev:build", agent: "claude", text: PING, client: "test" });
}

/** Waits until the log holds `turns` turn ends, or a failure, and gives the log. */
async function turnsEnded(live: LiveChat, turns: number): Promise<ChatEvent[]> {
  let log: ChatEvent[] = [];
  const ended = () => log.filter((event) => event.kind === "turn-end").length >= turns;
  const deadline = Date.now() + TURN_MS;
  while (!ended() && log.at(-1)?.kind !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    log = await logOf(live);
  }
  return log;
}

/** As `turnsEnded`, and allows each permission request with its first option of an allow kind. */
async function turnsEndedAllowing(runner: ChatRunner, live: LiveChat, turns: number): Promise<ChatEvent[]> {
  let log: ChatEvent[] = [];
  const ended = () => log.filter((event) => event.kind === "turn-end").length >= turns;
  const deadline = Date.now() + TURN_MS;
  while (!ended() && log.at(-1)?.kind !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    log = await logOf(live);
    for (const request of live.fold.open) {
      const asked = log.find((event) => event.kind === "permission" && event.request === request);
      if (asked?.kind !== "permission") continue;
      const options = asked.permission.options as { optionId: string; kind: string }[];
      const allow = options.find((option) => option.kind.startsWith("allow"));
      if (allow !== undefined) await runner.answerPermission(live, request, { optionId: allow.optionId, client: "test" });
    }
  }
  return log;
}

/**
 * The last event of `log` that is not an update. After the first turn the
 * adapter sends the title of the session, so an update can follow `turn-end`.
 */
function lastNonUpdate(log: ChatEvent[]): ChatEvent | undefined {
  return log.findLast((event) => event.kind !== "update");
}

/** The text of the answers of the agent in `log`. */
function answerText(log: ChatEvent[]): string {
  return log.flatMap((event) => {
    if (event.kind !== "update" || event.update.sessionUpdate !== "agent_message_chunk") return [];
    const content = event.update.content as { type?: string; text?: string };
    return content.type === "text" ? [content.text ?? ""] : [];
  }).join("");
}

/** Whether a process whose command line holds `text` runs. */
async function runs(text: string): Promise<boolean> {
  try {
    await promisify(execFile)("pgrep", ["-f", text]);
    return true;
  } catch {
    return false;
  }
}

/** Checks that the first turn ended with an answer of the agent. */
async function answered(live: LiveChat): Promise<ChatEvent[]> {
  const log = await turnsEnded(live, 1);
  expect(lastNonUpdate(log)).toMatchObject({ kind: "turn-end" });
  expect(log.some((event) => event.kind === "update" && event.update.sessionUpdate === "agent_message_chunk"))
    .toBe(true);
  return log;
}

describe.skipIf(process.env.TASMA_REAL_CLAUDE !== "1")("a chat with the real Claude", () => {
  it("answers two messages in one conversation, and claude --resume continues it", async () => {
    const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token() };
    const { runner, folder } = await world(claudeAdapter, env);

    const live = await start(runner);
    const log = await answered(live);
    const session = live.chat.session;
    expect(session).toBeDefined();

    await runner.message(live, { text: "Which word did you reply with?", client: "test" });
    const second = (await turnsEnded(live, 2)).slice(log.length);
    expect(lastNonUpdate(second)).toMatchObject({ kind: "turn-end" });
    expect(answerText(second).toLowerCase()).toContain("pong");

    const launch = launched(claudeAdapter.launch(env));
    const { stdout } = await promisify(execFile)(
      launch.env.CLAUDE_CODE_EXECUTABLE ?? "claude",
      ["-p", "--resume", session ?? "", "Which word did you reply with?"],
      { cwd: folder, env: launch.env, timeout: TURN_MS },
    );
    expect(stdout.toLowerCase()).toContain("pong");
  }, 3 * TURN_MS);

  it("stops a background command with the agent, and keeps the conversation at the next message", async () => {
    const { runner } = await world(claudeAdapter, { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token() });
    const background = `sleep ${String(4000 + Math.floor(Math.random() * 5000))}`;
    const live = await runner.start({
      tag: "ALPHA",
      task: "ALPHA-1",
      step: "dev:build",
      agent: "claude",
      text: `Remember the word "lantern". Then run \`sh -c '${background}; echo done'\` with the Bash tool in the background, and end your turn without waiting for it.`,
      client: "test",
    });

    const first = await turnsEndedAllowing(runner, live, 1);
    expect(lastNonUpdate(first)).toMatchObject({ kind: "turn-end" });
    expect(await runs(background)).toBe(true);

    await runner.stop(live);
    let left = await runs(background);
    for (let tries = 0; left && tries < 10; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      left = await runs(background);
    }
    expect(left).toBe(false);

    await runner.message(live, { text: "Which word did I ask you to remember?", client: "test" });
    const second = (await turnsEndedAllowing(runner, live, 2)).slice(first.length);
    expect(lastNonUpdate(second)).toMatchObject({ kind: "turn-end" });
    expect(answerText(second).toLowerCase()).toContain("lantern");
  }, 3 * TURN_MS);

  it("starts a new chat in the mode that the defaults of the agent hold", async () => {
    const { runner, root } = await world(claudeAdapter, { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token() });
    await writeFile(join(root, "agent-defaults.json"), JSON.stringify({ claude: { mode: "acceptEdits" } }));

    const log = await answered(await start(runner));

    const lists = log.flatMap((event) =>
      event.kind === "update" && event.update.sessionUpdate === "config_option_update"
        ? [event.update.configOptions as { id: string; currentValue: unknown }[]]
        : []);
    expect(lists.at(-1)?.find((option) => option.id === "mode")?.currentValue).toBe("acceptEdits");
  }, 2 * TURN_MS);

  it.skipIf(!process.env.TASMA_COMPILED_DAEMON)("answers through the agent mode of the compiled daemon", async () => {
    const compiled = process.env.TASMA_COMPILED_DAEMON ?? "";
    const adapter: AgentAdapter = {
      ...claudeAdapter,
      launch: (env) => ({ ...launched(claudeAdapter.launch(env)), command: compiled, args: ["--agent", "claude"] }),
    };
    const { runner } = await world(adapter, { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token() });

    await answered(await start(runner));
  }, 2 * TURN_MS);

  it("answers when the daemon has the PATH of launchd, through the environment of the login shell", async () => {
    // pnpm puts node_modules/.bin folders on the PATH of vitest, so node is taken from this process.
    const claudeDir = dirname(launched(claudeAdapter.launch(process.env)).env.CLAUDE_CODE_EXECUTABLE ?? "");
    const nodeDir = dirname(process.execPath);
    // Real init files build PATH from $HOME, which is a temporary folder here.
    const zdotdir = await target();
    await writeFile(join(zdotdir, ".zshrc"), `export PATH='${claudeDir}${delimiter}${nodeDir}'${delimiter}"$PATH"\n`);
    const launches: LaunchResult[] = [];
    const adapter: AgentAdapter = {
      ...claudeAdapter,
      launch(env) {
        const launch = claudeAdapter.launch(env);
        launches.push(launch);
        return launch;
      },
    };
    const { runner } = await world(adapter, {
      HOME: await target(),
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ZDOTDIR: zdotdir,
      CLAUDE_CODE_OAUTH_TOKEN: token(),
    });

    await answered(await start(runner));

    expect(launches[0]).toEqual({ missing: "Claude Code is not installed" });
    expect(launched(launches[1]!).env.PATH?.split(delimiter)).toContain(claudeDir);
  }, 2 * TURN_MS);
});
