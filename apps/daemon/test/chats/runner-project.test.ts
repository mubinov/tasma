import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ChatEvent, FeedEvent } from "@tasma/protocol";
import type { AgentAdapter } from "../../src/agents/adapter.js";
import { ChatStartRefusal } from "../../src/chats/runner.js";
import { logOf, logUntil, projectChatFolder, send, target, until } from "../helpers.js";
import { forever, modeOption, PERMISSION, QUESTION, SESSION, text } from "../agents/fake-agent.js";
import {
  endedByRunner,
  fakeAdapter,
  filtered,
  heldTurns,
  NEXT,
  PICK,
  promptText,
  requestOf,
  world,
} from "./runner-world.js";

const PROJECT_START = { tag: "ALPHA", title: "Plan the release", agent: "claude", text: "Build the parser", client: "app" } as const;

const USER_MESSAGE = { text: PROJECT_START.text, client: PROJECT_START.client } as const;

const USER_EVENT: ChatEvent = { kind: "user", ...USER_MESSAGE };

function projectChatEvents(feed: FeedEvent[]): FeedEvent[] {
  return feed.filter((event) => event.kind === "project-chat");
}

async function refusal(start: Promise<unknown>): Promise<ChatStartRefusal> {
  try {
    await start;
  } catch (error) {
    if (error instanceof ChatStartRefusal) return error;
    throw error;
  }
  throw new Error("the start was not refused");
}

describe("createChatRunner.startProjectChat", () => {
  it("makes chat 1 of the project in its folder, and gives the agent the text as its first prompt", async () => {
    const { runner, root, folder, processes, feed } = await world();

    const live = await runner.startProjectChat(PROJECT_START);
    const log = await logUntil(live, "turn-end");

    expect(live.chat).toMatchObject({ chat: 1, title: PROJECT_START.title, agent: "claude", folder, session: SESSION });
    const stored: unknown = JSON.parse(await readFile(join(projectChatFolder(root, "ALPHA", 1), "chat.json"), "utf8"));
    expect(stored).toMatchObject({ title: PROJECT_START.title, agent: "claude", folder });
    expect(processes[0]?.folder).toBe(folder);
    expect(processes[0]?.prompts.map(promptText)).toEqual([PROJECT_START.text]);
    expect(log).toEqual([USER_EVENT, { kind: "turn-end", stopReason: "end_turn" }]);
    expect(projectChatEvents(feed)).toEqual([
      { kind: "project-chat", tag: "ALPHA", chat: 1, state: "working" },
      { kind: "project-chat", tag: "ALPHA", chat: 1, state: "needs-you" },
    ]);
  });

  it("refuses an agent with no adapter and a project with no folder before it makes a chat", async () => {
    const supported = await world();
    expect(await refusal(supported.runner.startProjectChat({ ...PROJECT_START, agent: "codex" })))
      .toMatchObject({ code: "agent-not-supported" });
    await expect(supported.chats.getProjectChat("ALPHA", 1)).rejects.toMatchObject({ code: "chat-not-found" });

    const homeless = await world({ config: () => "name: Alpha\n" });
    expect(await refusal(homeless.runner.startProjectChat(PROJECT_START))).toMatchObject({ code: "project-has-no-folder" });
    await expect(homeless.chats.getProjectChat("ALPHA", 1)).rejects.toMatchObject({ code: "chat-not-found" });
  });

  it("writes the failure of the launch into the chat, and starts no agent", async () => {
    const { runner, processes } = await world({ adapter: fakeAdapter({ failed: "No agent here" }).adapter });

    const live = await runner.startProjectChat(PROJECT_START);

    expect(await logOf(live)).toEqual([USER_EVENT, { kind: "failed", reason: "No agent here" }]);
    expect(processes).toEqual([]);
  });
});

describe("the commands of the runner on a project chat", () => {
  it("sends a message as the next turn", async () => {
    const { runner, processes } = await world();
    const live = await runner.startProjectChat(PROJECT_START);
    await logUntil(live, "turn-end");

    await runner.message(live, NEXT);
    await until(() => processes[0]?.prompts.length === 2, "the agent got the message");

    expect(processes[0]?.prompts.map(promptText)).toEqual([PROJECT_START.text, NEXT.text]);
  });

  it("cancels the turn that runs", async () => {
    const { script } = heldTurns();
    const { runner, processes } = await world({ script });
    const live = await runner.startProjectChat(PROJECT_START);
    await until(() => processes[0]?.prompts.length === 1, "the turn runs");

    await runner.cancel(live, { client: "web" });

    expect((await logUntil(live, "turn-end")).at(-1)).toEqual({ kind: "turn-end", stopReason: "cancelled" });
  });

  it("gives the answers of a permission request and of a question to the agent", async () => {
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
    const live = await runner.startProjectChat(PROJECT_START);

    const permission = requestOf(await logUntil(live, "permission"));
    await runner.answerPermission(live, permission, { optionId: "allow", client: "web" });
    const question = requestOf((await logUntil(live, "question")).filter((event) => event.kind === "question"));
    await runner.answerQuestion(live, question, { action: "decline", client: "web" });

    expect(await logUntil(live, "turn-end")).toEqual([
      USER_EVENT,
      { kind: "permission", request: permission, permission: PERMISSION },
      { kind: "permission-resolved", request: permission, outcome: { outcome: "selected", optionId: "allow" }, client: "web" },
      { kind: "question", request: question, question: QUESTION },
      { kind: "question-resolved", request: question, answer: { action: "decline" }, client: "web" },
      { kind: "turn-end", stopReason: "end_turn" },
    ]);
    expect(answers).toEqual([{ outcome: { outcome: "selected", optionId: "allow" } }, { action: "decline" }]);
  });

  it("sets a picked option and saves it in the record of the project chat", async () => {
    const { runner, root } = await world({ script: { configOptions: [modeOption()] } });
    const live = await runner.startProjectChat(PROJECT_START);
    await logUntil(live, "turn-end");

    await expect(runner.setOption(live, PICK)).resolves.toEqual([]);

    const stored: unknown = JSON.parse(await readFile(join(projectChatFolder(root, "ALPHA", 1), "chat.json"), "utf8"));
    expect(stored).toMatchObject({ options: { mode: "acceptEdits" } });
  });

  it("names the record of the project chat in the diagnostic of a pick it could not save", async () => {
    const { runner, root } = await world({ script: { configOptions: [modeOption()] } });
    const live = await runner.startProjectChat(PROJECT_START);
    await logUntil(live, "turn-end");
    vi.spyOn(live, "setOptions").mockRejectedValue(new Error("the disk is full"));

    await expect(runner.setOption(live, PICK)).resolves.toEqual([{
      code: "option-not-saved",
      message: 'the value "acceptEdits" of "mode" is not saved in this chat: the disk is full',
      path: join(projectChatFolder(root, "ALPHA", 1), "chat.json"),
    }]);
  });

  it("names the chat with its project in a refusal", async () => {
    const { runner } = await world({ script: { prompt: () => forever() } });
    const live = await runner.startProjectChat(PROJECT_START);

    await expect(runner.answerPermission(live, "r-9", { optionId: "allow", client: "web" }))
      .rejects.toMatchObject({ code: "already-answered", message: "request r-9 of chat 1 of project ALPHA is not open" });
    await expect(runner.stop(live))
      .rejects.toMatchObject({ code: "turn-running", message: "a turn of chat 1 of project ALPHA is running" });
  });

  it("interrupts a project chat in a turn at close", async () => {
    const { script } = heldTurns();
    const { runner, processes } = await world({ script });
    const live = await runner.startProjectChat(PROJECT_START);
    await until(() => processes[0]?.prompts.length === 1, "the turn runs");

    await runner.close();

    expect((await logOf(live)).at(-1)).toEqual({ kind: "interrupted" });
  });
});

describe("the idle stop of a project chat", () => {
  it("ends the agent after the limit of a project chat, and resumes the stored session at the next message", async () => {
    const idleLimit = vi.fn(async () => 60_000);
    const { runner, processes } = await world({ idleLimit, projectIdleMs: 30 });
    const live = await runner.startProjectChat(PROJECT_START);
    await logUntil(live, "turn-end");

    await endedByRunner(processes[0]);
    await until(() => runner.running(live) === undefined, "the chat stopped running");
    await runner.message(live, NEXT);
    await until(() => processes[1]?.prompts.length === 1, "the agent got the message");

    expect(processes[1]?.resumes.map((resume) => resume.sessionId)).toEqual([SESSION]);
    expect(processes[1]?.prompts.map(promptText)).toEqual([NEXT.text]);
    expect(idleLimit).not.toHaveBeenCalled();
  });
});

describe("a project chat fails", () => {
  it("when the agent lost a session it answered in, with the project chat text of the adapter", async () => {
    const { runner } = await world({
      script: {
        async prompt(_params, agent) {
          await agent.update(text("Done"));
          return { stopReason: "end_turn" };
        },
        resume: () => Promise.reject(RequestError.resourceNotFound(SESSION)),
      },
    });
    const live = await runner.startProjectChat(PROJECT_START);
    await logUntil(live, "turn-end");
    await runner.stop(live);

    await runner.message(live, NEXT);

    expect((await logUntil(live, "failed")).slice(-2)).toEqual([
      { kind: "user", ...NEXT },
      { kind: "failed", reason: "The agent lost the project chat" },
    ]);
  });

  it("when its folder is gone at a relaunch, with no mention of a step", async () => {
    const { runner, chats, processes } = await world();
    const gone = join(await target(), "moved");
    const live = await chats.createProjectChat("ALPHA", { title: PROJECT_START.title, agent: "claude", folder: gone }, USER_MESSAGE);

    await runner.message(live, NEXT);

    expect((await logUntil(live, "failed")).at(-1)).toEqual({
      kind: "failed",
      reason: `The folder of this chat no longer exists: ${gone}. Start a new chat.`,
    });
    expect(processes).toEqual([]);
  });
});

describe("the session meta of a project chat", () => {
  const metaOf = (tag: string) => ({ systemPrompt: { append: `The project is ${tag}.` } });

  function withProjectMeta(): AgentAdapter {
    return { ...fakeAdapter().adapter, sessionMeta: { systemPrompt: { append: "A step chat." } }, projectSessionMeta: metaOf };
  }

  it("opens the session with the meta of the tag, and resumes it with the same meta in the next process", async () => {
    const { runner, processes, folder } = await world({ adapter: withProjectMeta() });
    const live = await runner.startProjectChat(PROJECT_START);
    await logUntil(live, "turn-end");

    await runner.stop(live);
    await runner.message(live, NEXT);
    await until(() => processes[1]?.prompts.length === 1, "the agent got the message");

    expect(processes[0]?.newSession).toEqual({ cwd: folder, mcpServers: [], _meta: metaOf("ALPHA") });
    expect(processes[1]?.resumes).toEqual([{ sessionId: SESSION, cwd: folder, mcpServers: [], _meta: metaOf("ALPHA") }]);
  });

  it("resumes with the new tag after a rename of the project", async () => {
    const { runner, processes, folder, server } = await world({ adapter: withProjectMeta() });
    const live = await runner.startProjectChat(PROJECT_START);
    await logUntil(live, "turn-end");

    await runner.stop(live);
    expect((await send(server, "POST", "/projects/ALPHA/rename", { tag: "BETA" })).status).toBe(200);
    await runner.message(live, NEXT);
    await until(() => processes[1]?.prompts.length === 1, "the agent got the message");

    expect(processes[1]?.resumes).toEqual([{ sessionId: SESSION, cwd: folder, mcpServers: [], _meta: metaOf("BETA") }]);
  });

  it("opens the session with no meta when the adapter has no meta of a project chat", async () => {
    const { runner, processes, folder } = await world({
      adapter: { ...fakeAdapter().adapter, sessionMeta: { systemPrompt: { append: "A step chat." } } },
    });
    const live = await runner.startProjectChat(PROJECT_START);
    await logUntil(live, "turn-end");

    expect(processes[0]?.newSession).toEqual({ cwd: folder, mcpServers: [] });
  });
});

describe("a rename of the project of a running project chat", () => {
  it("keeps the run on the same handle, which answers a message and publishes with the new tag", async () => {
    const { runner, processes, feed, server } = await world({
      script: {
        async prompt(_params, agent) {
          await agent.update(text("Done"));
          return { stopReason: "end_turn" };
        },
      },
    });
    const live = await runner.startProjectChat(PROJECT_START);
    await logUntil(live, "turn-end");

    expect((await send(server, "POST", "/projects/ALPHA/rename", { tag: "BETA" })).status).toBe(200);
    await runner.message(live, NEXT);
    const log = await logUntil(live, "turn-end");

    expect(live.tag).toBe("BETA");
    expect(log.slice(-3)).toEqual([{ kind: "user", ...NEXT }, filtered(text("Done")), { kind: "turn-end", stopReason: "end_turn" }]);
    expect(processes).toHaveLength(1);
    expect(projectChatEvents(feed).slice(-2)).toEqual([
      { kind: "project-chat", tag: "BETA", chat: 1, state: "working" },
      { kind: "project-chat", tag: "BETA", chat: 1, state: "needs-you" },
    ]);
  });
});
