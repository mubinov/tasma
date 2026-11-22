// A chat with the user's real `codex`, through the real adapter. It runs only
// with TASMA_REAL_CODEX=1, and needs TASMA_REAL_CODEX_HOME, the absolute path
// of a Codex home with a login: the HOME of each test file is a new temporary
// directory. The threads of the tests stay in that Codex home. The case of the
// compiled agent mode also needs TASMA_COMPILED_DAEMON, the path of a daemon
// that `scripts/app-binaries.sh` compiled.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import { openAgentDefaults, openAgentOptions } from "@tasma/engine";
import type { ChatEvent } from "@tasma/protocol";
import { spawnAgent } from "../../src/agents/acp.js";
import type { AgentProcess } from "../../src/agents/acp.js";
import type { AgentAdapter, AgentEnv, AgentLaunch, LaunchResult } from "../../src/agents/adapter.js";
import { codexAdapter } from "../../src/agents/codex.js";
import type { IdleLimit } from "../../src/chats/idle.js";
import { createChatRegistry } from "../../src/chats/registry.js";
import type { ChatRegistry, LiveChat } from "../../src/chats/registry.js";
import { createChatRunner } from "../../src/chats/runner.js";
import type { ChatRunner } from "../../src/chats/runner.js";
import { createProjectHost } from "../../src/projects/host.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import { logOf, plant, plantChat, projectConfig, projectsRoot, target, taskFile, taskText } from "../helpers.js";
import { answerText, lastNonUpdate, runs, TURN_MS, turnsEnded, within } from "./real-chat.js";

const WORD = `lantern-${String(Math.floor(Math.random() * 1_000_000))}`;

const run = promisify(execFile);

function codexHome(): string {
  const home = process.env.TASMA_REAL_CODEX_HOME;
  if (home === undefined || !isAbsolute(home)) throw new Error("set TASMA_REAL_CODEX_HOME to the absolute path of a Codex home with a login");
  return home;
}

function env(): AgentEnv {
  return { ...process.env, CODEX_HOME: codexHome() };
}

type Tree = { root: string; folder: string };

/** A tree with project ALPHA, whose folder is a directory, and the task ALPHA-1. */
async function tree(): Promise<Tree> {
  const root = await projectsRoot("ALPHA");
  const folder = await target();
  await plant(projectConfig(root, "ALPHA"), `path: ${folder}\n`);
  await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskText("ALPHA-1"));
  return { root, folder };
}

type WorldOptions = {
  idleLimit?: IdleLimit;
  spawn?: (launch: AgentLaunch, folder: string) => AgentProcess;
  /** Without it, the runner works on a new tree. */
  tree?: Tree;
  optionsWorkParent?: string;
};

/** A runner over project ALPHA with the task ALPHA-1. */
async function world(
  adapter: AgentAdapter,
  options: WorldOptions = {},
): Promise<{ runner: ChatRunner; chats: ChatRegistry; root: string; folder: string }> {
  const { root, folder } = options.tree ?? await tree();
  const host = createProjectHost({ root });
  onTestFinished(() => host.close());
  const chats = createChatRegistry({ root, host, writes: new WriteQueue() });
  const runner = createChatRunner({
    root,
    chats,
    adapters: [adapter],
    env: env(),
    spawn: options.spawn,
    idleLimit: options.idleLimit,
    defaults: openAgentDefaults(root),
    agentOptions: openAgentOptions(root),
    optionsWorkParent: options.optionsWorkParent,
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

/** Waits for the first event of the log that `holds` takes, until the first turn ends, and gives it. */
async function firstEvent(live: LiveChat, holds: (event: ChatEvent) => boolean): Promise<ChatEvent | undefined> {
  let found: ChatEvent | undefined;
  await within(TURN_MS, async () => {
    const log = await logOf(live);
    found = log.find(holds);
    return found !== undefined || log.some((event) => event.kind === "turn-end" || event.kind === "failed");
  });
  return found;
}

function isToolCall(event: ChatEvent): boolean {
  return event.kind === "update" && event.update.sessionUpdate === "tool_call";
}

/** A `sleep` with a duration of about ten days that no other process has, and its end after the test. */
function sleepMarker(): string {
  const marker = `sleep ${String(860_000 + Math.floor(Math.random() * 10_000))}`;
  onTestFinished(() => run("pkill", ["-f", marker]).then(() => undefined, () => undefined));
  return marker;
}

function backgroundPrompt(marker: string): string {
  return [
    `Start the shell command \`${marker}\` with your command tool, as it is: no \`&\`, no \`nohup\`, no other wrapper.`,
    "Give the tool a short yield time, and do not wait for the command to finish:",
    "when the tool returns while the command still runs, leave it running and reply with the single word: started",
  ].join(" ");
}

/** Every file under `folder`, or none when it does not exist. */
async function filesUnder(folder: string): Promise<string[]> {
  if (!existsSync(folder)) return [];
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

/** A spawn of the real agent that counts the `session/prompt` requests that go to the stdin of each process. */
function countingPrompts(): { spawn: (launch: AgentLaunch, folder: string) => AgentProcess; prompts: () => number } {
  let prompts = 0;
  return {
    spawn(launch, folder) {
      const agentProcess = spawnAgent(launch, folder);
      const writer = agentProcess.stream.writable.getWriter();
      const writable = new WritableStream<AnyMessage>({
        async write(message) {
          if ("method" in message && message.method === "session/prompt") prompts += 1;
          await writer.write(message);
        },
        close: () => writer.close(),
        abort: (reason: unknown) => writer.abort(reason),
      });
      return { ...agentProcess, stream: { readable: agentProcess.stream.readable, writable } };
    },
    prompts: () => prompts,
  };
}

type Choice = { const: string };

type QuestionParams = {
  toolCallId?: string;
  requestedSchema: { properties: Record<string, { oneOf?: Choice[] }>; required?: string[] };
};

type PermissionParams = { options: { optionId: string; kind: string }[] };

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

  it("asks a blocking question in Default mode, and goes on with the answer", async () => {
    const { runner } = await world(codexAdapter);
    const live = await start(runner, [
      "Ask me one question with your blocking tool request_user_input, not with request_user_input_async:",
      '"Which color?", with the two choices "red" and "blue".',
      "After my answer, reply with the chosen color alone.",
    ].join(" "));

    const asked = await firstEvent(live, (event) => event.kind === "question");
    if (asked?.kind !== "question") throw new Error(`Codex asked no question: ${answerText(await logOf(live))}`);
    const question = asked.question as QuestionParams;
    expect(question.toolCallId).toEqual(expect.any(String));
    const [id] = question.requestedSchema.required ?? [];
    const blue = question.requestedSchema.properties[id ?? ""]?.oneOf?.find((choice) => /blue/i.test(choice.const));
    expect(blue).toBeDefined();
    await runner.answerQuestion(live, asked.request, { action: "accept", content: { [id ?? ""]: blue?.const ?? "" }, client: "test" });

    const log = await answered(live);
    expect(answerText(log).toLowerCase()).toContain("blue");
    expect(answerText(log)).not.toContain("Under-development features enabled");
  }, 2 * TURN_MS);

  it("asks for a permission in read-only mode, and runs the command after the allow", async () => {
    const { runner, folder } = await world(codexAdapter);
    const file = `note-${String(Math.floor(Math.random() * 1_000_000))}.txt`;
    const live = await start(runner, [
      `Create the file ${file} in the current folder with the shell command \`touch ${file}\`.`,
      "If the sandbox blocks it, ask for my approval to run it outside the sandbox. Then reply with the single word: done",
    ].join(" "));
    await runner.setOption(live, { configId: "mode", value: "read-only", client: "test" });

    const asked = await firstEvent(live, (event) => event.kind === "permission");
    if (asked?.kind !== "permission") throw new Error(`Codex asked for no permission: ${answerText(await logOf(live))}`);
    const allow = (asked.permission as PermissionParams).options.find((option) => option.kind === "allow_once");
    expect(allow).toBeDefined();
    await runner.answerPermission(live, asked.request, { optionId: allow?.optionId ?? "", client: "test" });

    await answered(live);
    expect(existsSync(join(folder, file))).toBe(true);
  }, 2 * TURN_MS);

  it("takes a message during a turn into that turn, with one prompt", async () => {
    const counting = countingPrompts();
    const { runner } = await world(codexAdapter, { spawn: counting.spawn });
    const live = await start(runner, "Run the shell command `sleep 15` and wait for it to finish. Then reply with the single word: finished");
    expect(await firstEvent(live, isToolCall)).toBeDefined();

    await runner.message(live, { text: `Add the word ${WORD} to your reply.`, client: "test" });

    const log = await answered(live);
    expect(answerText(log)).toContain(WORD);
    expect(counting.prompts()).toBe(1);
  }, 2 * TURN_MS);

  it("ends the turn as cancelled at a cancel", async () => {
    const { runner } = await world(codexAdapter);
    const live = await start(runner, "Run the shell command `sleep 120` and wait for it to finish. Then reply with the single word: finished");
    expect(await firstEvent(live, isToolCall)).toBeDefined();

    const cancelled = Date.now();
    await runner.cancel(live, { client: "test" });

    expect(lastNonUpdate(await turnsEnded(live, 1))).toEqual({ kind: "turn-end", stopReason: "cancelled" });
    expect(Date.now() - cancelled).toBeLessThan(30_000);
  }, 2 * TURN_MS);

  it("resumes the conversation after a daemon restart, with the context of the first turn", async () => {
    const first = await world(codexAdapter);
    await answered(await start(first.runner, `Remember the word "${WORD}", and reply with the single word: ok`));
    await first.runner.close();

    const { runner, chats } = await world(codexAdapter, { tree: first });
    const live = (await chats.list("ALPHA", "ALPHA-1")).chats[0]!;
    const before = (await logOf(live)).length;
    await runner.message(live, { text: "Which word did I ask you to remember? Reply with that word alone.", client: "test" });

    const second = (await turnsEnded(live, 2)).slice(before);
    expect(lastNonUpdate(second)).toMatchObject({ kind: "turn-end" });
    expect(answerText(second)).toContain(WORD);
  }, 3 * TURN_MS);

  it("ends a background terminal of the chat at the idle stop", async () => {
    const limitMs = 20_000;
    const marker = sleepMarker();
    const { runner } = await world(codexAdapter, { idleLimit: async () => limitMs });
    const live = await start(runner, backgroundPrompt(marker));
    await answered(live);

    expect(await runs(marker)).toBe(true);
    expect(await within(limitMs + 30_000, () => runner.running(live) === undefined)).toBe(true);

    expect(await within(10_000, async () => !(await runs(marker)))).toBe(true);
  }, 3 * TURN_MS);

  it("ends a background terminal of the chat at the daemon stop", async () => {
    const marker = sleepMarker();
    const { runner } = await world(codexAdapter);
    await answered(await start(runner, backgroundPrompt(marker)));

    expect(await runs(marker)).toBe(true);
    await runner.close();

    expect(await within(10_000, async () => !(await runs(marker)))).toBe(true);
  }, 2 * TURN_MS);

  it("refreshes the options of Codex, and leaves no thread on disk", async () => {
    const workRoot = await projectsRoot();
    const sessions = join(codexHome(), "sessions");
    const before = new Set(await filesUnder(sessions));
    const { runner, root } = await world(codexAdapter, { optionsWorkParent: join(workRoot, "Caches") });

    runner.refreshOptions("codex", undefined);

    const stored = async () => (await openAgentOptions(root).read()).lists.codex;
    expect(await within(TURN_MS, async () => (await stored()) !== undefined)).toBe(true);
    const mode = (await stored())?.options.find((option) => option.id === "mode") as { options?: { value: string }[] } | undefined;
    expect(mode?.options?.map((option) => option.value)).toContain("agent");
    await runner.close();
    const added = (await filesUnder(sessions)).filter((file) => !before.has(file));
    const texts = await Promise.all(added.map((file) => readFile(file, "utf8")));
    expect(texts.filter((text) => text.includes(basename(workRoot)))).toEqual([]);
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
