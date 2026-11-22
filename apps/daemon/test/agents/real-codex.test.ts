// A chat with the user's real `codex`, through the real adapter. It runs only
// with TASMA_REAL_CODEX=1, and needs TASMA_REAL_CODEX_HOME, the absolute path
// of a Codex home with a login: the HOME of each test file is a new temporary
// directory. The threads of the tests stay in that Codex home. The case of the
// compiled agent mode also needs TASMA_COMPILED_DAEMON, the path of a daemon
// that `scripts/app-binaries.sh` compiled.

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { openAgentDefaults, openAgentOptions } from "@tasma/engine";
import type { ChatEvent } from "@tasma/protocol";
import type { AgentAdapter, AgentEnv, LaunchResult } from "../../src/agents/adapter.js";
import { codexAdapter } from "../../src/agents/codex.js";
import type { IdleLimit } from "../../src/chats/idle.js";
import { createChatRegistry } from "../../src/chats/registry.js";
import type { ChatRegistry, LiveChat } from "../../src/chats/registry.js";
import { createChatRunner } from "../../src/chats/runner.js";
import type { ChatRunner } from "../../src/chats/runner.js";
import { createProjectHost } from "../../src/projects/host.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import { logOf, plant, plantChat, projectConfig, projectsRoot, target, taskFile, taskText } from "../helpers.js";
import { answerText, lastNonUpdate, TURN_MS, turnsEnded, within } from "./real-chat.js";

const WORD = `lantern-${String(Math.floor(Math.random() * 1_000_000))}`;

function env(): AgentEnv {
  const home = process.env.TASMA_REAL_CODEX_HOME;
  if (home === undefined || !isAbsolute(home)) throw new Error("set TASMA_REAL_CODEX_HOME to the absolute path of a Codex home with a login");
  return { ...process.env, CODEX_HOME: home };
}

/** A runner over project ALPHA with the task ALPHA-1. */
async function world(
  adapter: AgentAdapter,
  { idleLimit }: { idleLimit?: IdleLimit } = {},
): Promise<{ runner: ChatRunner; chats: ChatRegistry; root: string; folder: string }> {
  const root = await projectsRoot("ALPHA");
  const folder = await target();
  await plant(projectConfig(root, "ALPHA"), `path: ${folder}\n`);
  await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskText("ALPHA-1"));
  const host = createProjectHost({ root });
  onTestFinished(() => host.close());
  const chats = createChatRegistry({ root, host, writes: new WriteQueue() });
  const runner = createChatRunner({
    root,
    chats,
    adapters: [adapter],
    env: env(),
    idleLimit,
    defaults: openAgentDefaults(root),
    agentOptions: openAgentOptions(root),
  });
  onTestFinished(() => runner.close());
  return { runner, chats, root, folder };
}

function start(runner: ChatRunner, text: string): Promise<LiveChat> {
  return runner.start({ tag: "ALPHA", task: "ALPHA-1", step: "dev:build", agent: "codex", text, client: "test" });
}

/** Checks that the first turn ended with an answer of the agent. */
async function answered(live: LiveChat): Promise<ChatEvent[]> {
  const log = await turnsEnded(live, 1);
  expect(lastNonUpdate(log)).toMatchObject({ kind: "turn-end" });
  expect(answerText(log)).not.toBe("");
  return log;
}

describe.skipIf(process.env.TASMA_REAL_CODEX !== "1")("a chat with the real Codex", () => {
  it("answers a first message", async () => {
    const { runner } = await world(codexAdapter);

    const live = await start(runner, "Reply with the single word: pong");

    expect(answerText(await answered(live)).toLowerCase()).toContain("pong");
    expect(live.chat.session).toBeDefined();
  }, 2 * TURN_MS);

  it("resumes the conversation after the idle stop, with the context of the first turn", async () => {
    const limitMs = 5000;
    const { runner } = await world(codexAdapter, { idleLimit: async () => limitMs });
    const live = await start(runner, `Remember the word "${WORD}", and reply with the single word: ok`);
    const first = await answered(live);

    expect(await within(limitMs + 30_000, () => runner.running(live) === undefined)).toBe(true);

    await runner.message(live, { text: "Which word did I ask you to remember? Reply with that word alone.", client: "test" });
    const second = (await turnsEnded(live, 2)).slice(first.length);
    expect(lastNonUpdate(second)).toMatchObject({ kind: "turn-end" });
    expect(answerText(second)).toContain(WORD);
  }, 3 * TURN_MS);

  it("fails with the text of a lost session when Codex does not have the session of the chat", async () => {
    const { runner, chats, root, folder } = await world(codexAdapter);
    await plantChat(
      root,
      { tag: "ALPHA", digits: "1", chat: 1 },
      { agent: "codex", folder, session: randomUUID() },
      [{ kind: "user", text: "Reply with the single word: pong", client: "test" }, { kind: "turn-end", stopReason: "end_turn" }],
    );
    const live = (await chats.list("ALPHA", "ALPHA-1")).chats[0]!;

    await runner.message(live, { text: "Reply with the single word: pong", client: "test" });

    expect(await within(TURN_MS, async () => (await logOf(live)).at(-1)?.kind === "failed")).toBe(true);
    expect((await logOf(live)).at(-1)).toEqual({ kind: "failed", reason: codexAdapter.sessionGone });
  }, 2 * TURN_MS);

  it.skipIf(!process.env.TASMA_COMPILED_DAEMON)("answers through the agent mode of the compiled daemon", async () => {
    const compiled = process.env.TASMA_COMPILED_DAEMON ?? "";
    const adapter: AgentAdapter = {
      ...codexAdapter,
      launch(launchEnv): LaunchResult {
        const launch = codexAdapter.launch(launchEnv);
        return "command" in launch ? { ...launch, command: compiled, args: ["--agent", "codex"] } : launch;
      },
    };
    const { runner } = await world(adapter);

    await answered(await start(runner, "Reply with the single word: pong"));
  }, 2 * TURN_MS);
});
