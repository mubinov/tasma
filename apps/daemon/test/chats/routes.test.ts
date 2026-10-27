import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { openAgentDefaults } from "@tasma/engine";
import type { Chat, ChatEntry, ChatEvent, ChatEventsReply, ChatStart, FeedEvent } from "@tasma/protocol";
import type { AgentAdapter } from "../../src/agents/adapter.js";
import { createChatRegistry } from "../../src/chats/registry.js";
import type { ChatRegistry, LiveChat } from "../../src/chats/registry.js";
import { chatRoutes } from "../../src/chats/routes.js";
import { createChatRunner } from "../../src/chats/runner.js";
import type { ChatRunner } from "../../src/chats/runner.js";
import { createStepChats } from "../../src/chats/start.js";
import { createProjectHost } from "../../src/projects/host.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { taskRoutes } from "../../src/tasks/routes.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import { fakeAgent, forever, modeOption } from "../agents/fake-agent.js";
import type { Script } from "../agents/fake-agent.js";
import {
  bearer,
  chatFolder,
  failure,
  get,
  logFile,
  logOf,
  logUntil,
  onWorkflow,
  plant,
  plantSteps,
  projectConfig,
  projectsRoot,
  requestsOf,
  send,
  startTestServer,
  stillPending,
  success,
  target,
  taskFile,
  taskText,
  until,
  userConfig,
} from "../helpers.js";
import type { TestServer } from "../helpers.js";

/** A hold no test outlasts, for a read that an append has to end. */
const LONG_HOLD_MS = 10_000;

/** A hold a test waits out, to see that no entry follows. */
const SHORT_HOLD_MS = 300;

const CAP = 1024 * 1024;

const INPUT = { step: "dev:build", agent: "claude", folder: "/srv/alpha" } as const;

const MESSAGE = { text: "Build the parser", client: "app" };

const UPDATE: ChatEvent = { kind: "update", update: { sessionUpdate: "agent_message_chunk" } };

const TURN_END: ChatEvent = { kind: "turn-end", stopReason: "end_turn" };

const CHATS = "/projects/ALPHA/tasks/ALPHA-1/chats";

const LONG_CLIENT = "c".repeat(101);

const ADAPTER: AgentAdapter = {
  agent: "claude",
  launch: () => ({ command: "fake-agent", args: [], env: {} }),
  notLoggedIn: "Log in to the agent first",
  sessionGone: "The agent lost the chat",
  filterUpdate: (update) => update,
};

type World = { chats: ChatRegistry; runner: ChatRunner; server: TestServer; events: FeedEvent[] };

/** A tree holding project ALPHA with the tasks ALPHA-1 and ALPHA-2. */
async function tree(): Promise<string> {
  const root = await projectsRoot("ALPHA");
  await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskText("ALPHA-1"));
  await plant(taskFile(root, "ALPHA", "ALPHA-2"), taskText("ALPHA-2"));
  return root;
}

/**
 * A daemon over a tree with the chat routes, whose agents are fake agents that
 * run `script`. A second call over the same tree is a restart.
 */
async function world(
  root: string,
  options: { holdMs?: number; script?: Script; adapters?: AgentAdapter[] } = {},
): Promise<World> {
  const host = createProjectHost({ root });
  const writes = new WriteQueue();
  const events: FeedEvent[] = [];
  const publish = (event: FeedEvent) => events.push(event);
  const chats = createChatRegistry({ root, host, writes, publish, holdMs: options.holdMs ?? LONG_HOLD_MS });
  const { spawn } = fakeAgent(options.script);
  const runner = createChatRunner({
    root,
    chats,
    adapters: options.adapters ?? [ADAPTER],
    env: {},
    spawn,
    defaults: openAgentDefaults(root),
  });
  onTestFinished(async () => {
    await runner.close();
    chats.close();
    await host.close();
  });
  const server = await startTestServer([
    ...projectRoutes(host, writes, chats),
    ...taskRoutes(host, { writes, chats }),
    ...chatRoutes(chats, runner, createStepChats({ root, host, chats, runner })),
  ]);
  return { chats, runner, server, events };
}

/** A daemon whose project ALPHA has a folder, with chat 1 of ALPHA-1 started through the runner. */
async function running(script?: Script): Promise<World & { live: LiveChat; root: string }> {
  const root = await tree();
  await plant(projectConfig(root, "ALPHA"), `path: ${await target()}\n`);
  const started = await world(root, { script });
  const live = await started.runner.start({ tag: "ALPHA", task: "ALPHA-1", step: "dev:build", agent: "claude", ...MESSAGE });
  return { ...started, live, root };
}

/** A turn that asks a permission request and a question, and stays open until a cancel ends it. */
function asking(): Script {
  let stop: ((result: PromptResponse) => void) | undefined;
  return {
    prompt(_params, agent) {
      void agent.permission().catch(() => undefined);
      void agent.question().catch(() => undefined);
      return new Promise((resolve) => (stop = resolve));
    },
    cancel: () => stop?.({ stopReason: "cancelled" }),
  };
}

/** One read of a chat log, which has to succeed. */
async function readLog(server: TestServer, after?: number | string, path = `${CHATS}/1/events`): Promise<ChatEventsReply> {
  const response = await get(server, after === undefined ? path : `${path}?after=${after}`);
  expect(response.status).toBe(200);
  return (await success<ChatEventsReply>(response)).data;
}

/** The entries of a reply that is no `reset`. */
function entriesOf(reply: ChatEventsReply): ChatEntry[] {
  if ("reset" in reply) throw new Error("the chat log answered reset");
  return reply.entries;
}

describe("GET …/chats", () => {
  it("gives the chats of a task in number order with their seq and state", async () => {
    const { chats, server } = await world(await tree());
    const first = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    await first.append(TURN_END);
    const second = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    const response = await get(server, CHATS);

    expect(response.status).toBe(200);
    const { data, diagnostics } = await success(response);
    expect(data).toEqual([first.chat, second.chat]);
    expect(data).toMatchObject([{ chat: 1, seq: 2, state: "needs-you" }, { chat: 2, seq: 1, state: "working" }]);
    expect(diagnostics).toEqual([]);
  });

  it("reports a chat folder that has no record", async () => {
    const root = await tree();
    const { chats, server } = await world(root);
    await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    await mkdir(chatFolder(root, "ALPHA", "1", 2));

    const { data, diagnostics } = await success<unknown[]>(await get(server, CHATS));

    expect(data).toHaveLength(1);
    expect(diagnostics).toMatchObject([{ code: "chat-file-unreadable", path: join(chatFolder(root, "ALPHA", "1", 2), "chat.json") }]);
  });

  it("gives an empty list for a task with no chat", async () => {
    const { server } = await world(await tree());

    await expect(success(await get(server, "/projects/ALPHA/tasks/ALPHA-2/chats"))).resolves.toEqual({
      data: [],
      diagnostics: [],
    });
  });
});

describe("POST …/chats", () => {
  /**
   * The tree of `tree()`, where ALPHA declares the workflow "flow" and has a
   * folder unless `folder` is false. ALPHA-3 is at the step "build" of "flow",
   * and ALPHA-4 at the step "ship", which "flow" does not have.
   */
  async function stepTree(options: { folder?: boolean } = {}): Promise<string> {
    const root = await tree();
    await plantSteps(root, "flow", "plan", "build");
    const path = options.folder === false ? "" : `path: ${await target()}\n`;
    await plant(projectConfig(root, "ALPHA"), `${path}workflows: [flow]\n`);
    await plant(taskFile(root, "ALPHA", "ALPHA-3"), onWorkflow("ALPHA-3", "flow", "build"));
    await plant(taskFile(root, "ALPHA", "ALPHA-4"), onWorkflow("ALPHA-4", "flow", "ship"));
    return root;
  }

  const START = "/projects/ALPHA/tasks/ALPHA-3/chats";

  it("starts the chat of the step, and gives it back to the next start", async () => {
    const root = await stepTree();
    await plant(userConfig(root), "colour: blue\n");
    const { server } = await world(root);

    const first = await send(server, "POST", START, { client: "cli" });
    const second = await send(server, "POST", START, { client: "app" });

    expect([first.status, second.status]).toEqual([200, 200]);
    const started = await success<ChatStart>(first);
    expect(started.data).toMatchObject({ started: true, chat: { task: "ALPHA-3", chat: 1, step: "build", agent: "claude" } });
    expect(started.diagnostics).toMatchObject([{ code: "config-key-unknown", path: userConfig(root) }]);
    const again = await success<ChatStart>(second);
    expect(again.data).toMatchObject({ started: false, chat: { chat: 1, step: "build" } });
  });

  it.each([
    ["a body that is not an object", ["cli"]],
    ["no body", undefined],
    ["a missing client", {}],
    ["an empty client", { client: "" }],
    ["a client of 101 characters", { client: LONG_CLIENT }],
    ["a client that is not a string", { client: 7 }],
    ["an extra key", { client: "cli", step: "build" }],
    ["a replaces with no client", { replaces: 1 }],
    ["a replaces with an extra key", { client: "cli", replaces: 1, step: "build" }],
  ])("refuses %s with 400 before it reads the task", async (_case, body) => {
    const { server } = await world(await stepTree());

    const response = await send(server, "POST", "/projects/ALPHA/tasks/ALPHA-9/chats", body);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });

  it("replaces the chat that replaces names with a new chat of the step", async () => {
    const { server } = await world(await stepTree());
    await send(server, "POST", START, { client: "cli" });

    const response = await send(server, "POST", START, { client: "app", replaces: 1 });

    expect(response.status).toBe(200);
    const { data } = await success<ChatStart>(response);
    expect(data).toMatchObject({ started: true, chat: { task: "ALPHA-3", chat: 2, step: "build" } });
  });

  it.each([0, -1, 2.5, 2 ** 53, "3", null, true])("refuses a replaces of %j with 400 before it reads the task", async (replaces) => {
    const { server } = await world(await stepTree());

    const response = await send(server, "POST", "/projects/ALPHA/tasks/ALPHA-9/chats", { client: "cli", replaces });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toEqual({
      kind: "daemon",
      code: "malformed-request",
      message: '"replaces" takes a chat number: a whole number of 1 or more',
    });
  });

  it.each([
    ["an older chat", 1, "chat 1 of ALPHA-3 is not the latest chat of the task: chat 2 is"],
    ["a number with no chat", 5, "ALPHA-3 has no chat 5"],
  ])("refuses a replaces of %s with 409 chat-not-current", async (_case, replaces, message) => {
    const { server } = await world(await stepTree());
    await send(server, "POST", START, { client: "cli" });
    await send(server, "POST", START, { client: "app", replaces: 1 });

    const response = await send(server, "POST", START, { client: "app", replaces });

    expect(response.status).toBe(409);
    await expect(failure(response)).resolves.toEqual({ kind: "daemon", code: "chat-not-current", message });
  });

  it("refuses a query with 400", async () => {
    const { server } = await world(await stepTree());

    const response = await send(server, "POST", `${START}?step=build`, { client: "cli" });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });

  it("refuses a body that is not JSON with 415", async () => {
    const { server } = await world(await stepTree());

    const response = await fetch(`${server.url}${START}`, {
      method: "POST",
      headers: { "content-type": "text/plain", ...bearer(server.token) },
      body: JSON.stringify({ client: "cli" }),
    });

    expect(response.status).toBe(415);
  });

  it("refuses a start without the token with 401", async () => {
    const { server } = await world(await stepTree());

    const response = await fetch(`${server.url}${START}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: "cli" }),
    });

    expect(response.status).toBe(401);
  });

  it.each([
    ["an unknown task", 404, "task-not-found", "/projects/ALPHA/tasks/ALPHA-9/chats"],
    ["an unknown project", 404, "project-not-found", "/projects/BETA/tasks/BETA-1/chats"],
    ["a task with no workflow", 409, "task-has-no-workflow", "/projects/ALPHA/tasks/ALPHA-1/chats"],
    ["a step that the workflow does not have", 409, "step-stale", "/projects/ALPHA/tasks/ALPHA-4/chats"],
  ])("refuses %s with %i %s", async (_case, status, code, path) => {
    const { server } = await world(await stepTree());

    const response = await send(server, "POST", path, { client: "cli" });

    expect(response.status).toBe(status);
    await expect(failure(response)).resolves.toMatchObject({ code });
  });

  it("refuses a workflow that the project does not declare with 400", async () => {
    const root = await stepTree();
    await plantSteps(root, "other", "draft");
    await plant(taskFile(root, "ALPHA", "ALPHA-5"), onWorkflow("ALPHA-5", "other", "draft"));
    const { server } = await world(root);

    const response = await send(server, "POST", "/projects/ALPHA/tasks/ALPHA-5/chats", { client: "cli" });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "workflow-unknown" });
  });

  it("refuses a project with no folder with 409", async () => {
    const { server } = await world(await stepTree({ folder: false }));

    const response = await send(server, "POST", START, { client: "cli" });

    expect(response.status).toBe(409);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "project-has-no-folder" });
  });

  it("refuses an agent that Tasma cannot run with 409", async () => {
    const { server } = await world(await stepTree(), { adapters: [] });

    const response = await send(server, "POST", START, { client: "cli" });

    expect(response.status).toBe(409);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "agent-not-supported" });
  });
});

describe("GET …/chats/{chat}", () => {
  it("gives one chat with the findings of its log, which a read of the log leaves out", async () => {
    const root = await tree();
    const live = await (await world(root)).chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    await live.append(TURN_END);
    const log = logFile(root, "ALPHA", "1", 1);
    await appendFile(log, "not an entry\n");
    const { server } = await world(root);

    const { data, diagnostics } = await success(await get(server, `${CHATS}/1`));
    const read = await success(await get(server, `${CHATS}/1/events?after=0`));

    expect(data).toEqual(live.chat);
    expect(diagnostics).toMatchObject([{ code: "chat-file-unreadable", path: log, line: 3 }]);
    expect(read.diagnostics).toEqual([]);
  });
});

describe("a chat that is not there", () => {
  it.each([
    ["an unknown project", "/projects/OMEGA/tasks/OMEGA-1/chats", "project-not-found"],
    ["an unknown project and a malformed chat number", "/projects/OMEGA/tasks/OMEGA-1/chats/x/events", "project-not-found"],
    ["a missing task", "/projects/ALPHA/tasks/ALPHA-9/chats", "task-not-found"],
    ["a missing task and a chat", "/projects/ALPHA/tasks/ALPHA-9/chats/1", "task-not-found"],
    ["a missing chat", `${CHATS}/7`, "chat-not-found"],
    ["a missing chat in a read of its log", `${CHATS}/7/events`, "chat-not-found"],
    ["chat 0", `${CHATS}/0`, "chat-not-found"],
    ["a chat number with a leading zero", `${CHATS}/01`, "chat-not-found"],
    ["a chat number that is a word", `${CHATS}/x/events`, "chat-not-found"],
    ["a chat number with a fraction", `${CHATS}/1.0`, "chat-not-found"],
    ["a chat number above the safe-integer limit", `${CHATS}/9007199254740993`, "chat-not-found"],
    ["a missing task and a malformed chat number", "/projects/ALPHA/tasks/ALPHA-9/chats/x", "chat-not-found"],
  ])("gives 404 for %s", async (_case, path, code) => {
    const { chats, server } = await world(await tree());
    await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    const response = await get(server, path);

    expect(response.status).toBe(404);
    await expect(failure(response)).resolves.toMatchObject({ code });
  });
});

describe("GET …/chats/{chat}/events", () => {
  it("replays every entry in order from 0, and gives a cursor only the newer ones", async () => {
    const { chats, server } = await world(await tree());
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    await live.append(UPDATE);
    await live.append(TURN_END);
    const all = await live.read(0);

    await expect(readLog(server, 0)).resolves.toEqual({ cursor: 3, entries: all });
    await expect(readLog(server)).resolves.toEqual({ cursor: 3, entries: all });
    await expect(readLog(server, "")).resolves.toEqual({ cursor: 3, entries: all });
    await expect(readLog(server, 1)).resolves.toEqual({ cursor: 3, entries: all.slice(1) });
    expect(all.map((entry) => entry.event.kind)).toEqual(["user", "update", "turn-end"]);
  });

  it("replays a long log over several reads, each under the cap, which together give every entry one time", async () => {
    const { chats, server } = await world(await tree());
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    for (let index = 0; index < 12; index += 1) {
      await live.append({ kind: "update", update: { sessionUpdate: "agent_message_chunk", text: "x".repeat(250_000) } });
    }

    const seen: number[] = [];
    let cursor = 0;
    let reads = 0;
    while (cursor < live.chat.seq) {
      const reply = await readLog(server, cursor);
      const entries = entriesOf(reply);
      reads += 1;
      const bytes = entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)), 0);
      expect(bytes).toBeLessThanOrEqual(CAP);
      seen.push(...entries.map((entry) => entry.seq));
      expect(reply.cursor).toBe(entries.at(-1)?.seq);
      cursor = reply.cursor;
    }

    expect(reads).toBeGreaterThan(1);
    expect(seen).toEqual(Array.from({ length: 13 }, (_value, index) => index + 1));
  });

  it("ends a held read at an append with exactly the new entry", async () => {
    const { chats, server } = await world(await tree());
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const held = readLog(server, 1);

    expect(await stillPending(held)).toBe(true);
    const entry = await live.append(UPDATE);

    await expect(held).resolves.toEqual({ cursor: 2, entries: [entry] });
  });

  it("ends a held read at the end of the hold with no entries and the same cursor", async () => {
    const { chats, server } = await world(await tree(), { holdMs: SHORT_HOLD_MS });
    await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    await expect(readLog(server, 1)).resolves.toEqual({ cursor: 1, entries: [] });
  });

  it("answers reset for an after above the last seq", async () => {
    const { chats, server } = await world(await tree());
    await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    await expect(readLog(server, 9)).resolves.toEqual({ reset: true, cursor: 0 });
  });

  it.each([
    ["a delete of the task", "/projects/ALPHA/tasks/ALPHA-1", "task-not-found"],
    ["a delete of the project", "/projects/ALPHA", "project-not-found"],
  ])("releases a held read at %s, which then gets 404", async (_case, path, code) => {
    const { chats, server } = await world(await tree());
    await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const held = get(server, `${CHATS}/1/events?after=1`);

    expect(await stillPending(held)).toBe(true);
    expect((await send(server, "DELETE", path)).status).toBe(200);

    const response = await held;
    expect(response.status).toBe(404);
    await expect(failure(response)).resolves.toMatchObject({ code });
  });

  it("releases a held read with the old tag at a rename, and holds a read with the new tag until an append", async () => {
    const { chats, server } = await world(await tree());
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const old = get(server, `${CHATS}/1/events?after=1`);

    expect(await stillPending(old)).toBe(true);
    expect((await send(server, "POST", "/projects/ALPHA/rename", { tag: "BETA" })).status).toBe(200);

    const response = await old;
    expect(response.status).toBe(404);
    await expect(failure(response)).resolves.toMatchObject({ code: "project-not-found" });

    const renamed = readLog(server, 1, "/projects/BETA/tasks/BETA-1/chats/1/events");
    expect(await stillPending(renamed)).toBe(true);
    const entry = await live.append(UPDATE);
    await expect(renamed).resolves.toEqual({ cursor: 2, entries: [entry] });
  });

  it("gives the same entries for the same cursors after a restart", async () => {
    const root = await tree();
    const first = await world(root);
    const live = await first.chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    await live.append(UPDATE);
    await live.append(TURN_END);
    const before = [await readLog(first.server, 0), await readLog(first.server, 2)];

    const { server } = await world(root);

    await expect(success(await get(server, `${CHATS}/1`))).resolves.toEqual({ data: live.chat, diagnostics: [] });
    expect([await readLog(server, 0), await readLog(server, 2)]).toEqual(before);
  });

  it.each([
    ["an after that is no number", `${CHATS}/1/events?after=last`],
    ["a negative after", `${CHATS}/1/events?after=-1`],
    ["an after above the safe-integer limit", `${CHATS}/1/events?after=9007199254740992`],
    ["the cursor stated twice", `${CHATS}/1/events?after=1&after=2`],
    ["a key the read of a log does not declare", `${CHATS}/1/events?since=1`],
    ["a query on the list", `${CHATS}?after=1`],
    ["a query on one chat", `${CHATS}/1?after=1`],
  ])("refuses %s with 400", async (_case, path) => {
    const { chats, server } = await world(await tree());
    await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    const response = await get(server, path);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });

  it("refuses a read without the token with 401", async () => {
    const { server } = await world(await tree());

    const response = await fetch(`${server.url}${CHATS}/1/events`);

    expect(response.status).toBe(401);
  });
});

describe("the chat commands", () => {
  it("answers a message with the chat, which is then working", async () => {
    const { live, server } = await running();
    await logUntil(live, "turn-end");

    const response = await send(server, "POST", `${CHATS}/1/messages`, { text: "Now the printer", client: "web" });

    expect(response.status).toBe(200);
    const { data, diagnostics } = await success<Chat>(response);
    expect(data).toMatchObject({ task: "ALPHA-1", chat: 1, state: "working", seq: 3 });
    expect(diagnostics).toEqual([]);
    expect((await logOf(live))[2]).toEqual({ kind: "user", text: "Now the printer", client: "web" });
  });

  it("answers a permission answer, a question answer and a cancel with the chat", async () => {
    const { live, server } = await running(asking());
    const [permission, question] = requestsOf(await logUntil(live, "question"));

    const answered = await send(server, "POST", `${CHATS}/1/permissions/${permission}`, { optionId: "allow", client: "web" });
    expect(answered.status).toBe(200);
    expect((await success<Chat>(answered)).data).toMatchObject({ chat: 1, state: "needs-you" });

    const replied = await send(server, "POST", `${CHATS}/1/questions/${question}`, {
      action: "accept",
      content: { parser: "peg", depth: 2, strict: true, tags: ["fast"] },
      client: "web",
    });
    expect(replied.status).toBe(200);
    expect((await success<Chat>(replied)).data).toMatchObject({ chat: 1, state: "working" });

    const cancelled = await send(server, "POST", `${CHATS}/1/cancel`, { client: "app" });
    expect(cancelled.status).toBe(200);
    expect((await success<Chat>(cancelled)).data).toMatchObject({ chat: 1 });
    expect((await logUntil(live, "turn-end")).slice(-3)).toEqual([
      { kind: "permission-resolved", request: permission, outcome: { outcome: "selected", optionId: "allow" }, client: "web" },
      {
        kind: "question-resolved",
        request: question,
        answer: { action: "accept", content: { parser: "peg", depth: 2, strict: true, tags: ["fast"] } },
        client: "web",
      },
      { kind: "turn-end", stopReason: "cancelled" },
    ]);
  });

  it("answers a decline of a question with the chat", async () => {
    const { live, server } = await running(asking());
    const [, question] = requestsOf(await logUntil(live, "question"));

    const response = await send(server, "POST", `${CHATS}/1/questions/${question}`, { action: "decline", client: "web" });

    expect(response.status).toBe(200);
    expect((await logOf(live)).at(-1)).toEqual({ kind: "question-resolved", request: question, answer: { action: "decline" }, client: "web" });
  });

  it.each([
    ["a body that is not an object", "messages", ["Build"]],
    ["a body that is null", "messages", null],
    ["no body", "messages", undefined],
    ["a missing key", "messages", { text: "Build" }],
    ["an extra key", "messages", { text: "Build", client: "web", step: "dev" }],
    ["an empty client", "messages", { text: "Build", client: "" }],
    ["a client of 101 characters", "messages", { text: "Build", client: LONG_CLIENT }],
    ["a client that is not a string", "messages", { text: "Build", client: 7 }],
    ["an empty text", "messages", { text: "", client: "web" }],
    ["a text of whitespace only", "messages", { text: " \n\t", client: "web" }],
    ["a text that is not a string", "messages", { text: ["Build"], client: "web" }],
    ["a cancel with no client", "cancel", {}],
    ["a cancel with an extra key", "cancel", { client: "web", text: "Stop" }],
    ["an empty optionId", "permissions/req-1", { optionId: "", client: "web" }],
    ["an optionId that is not a string", "permissions/req-1", { optionId: 1, client: "web" }],
    ["a permission answer with no optionId", "permissions/req-1", { client: "web" }],
    ["an accept with no content", "questions/req-1", { action: "accept", client: "web" }],
    ["a content value that is an object", "questions/req-1", { action: "accept", content: { parser: { name: "peg" } }, client: "web" }],
    ["a content value that is an array of numbers", "questions/req-1", { action: "accept", content: { sizes: [1] }, client: "web" }],
    ["a content that is an array", "questions/req-1", { action: "accept", content: ["peg"], client: "web" }],
    ["a decline with content", "questions/req-1", { action: "decline", content: {}, client: "web" }],
    ["another action", "questions/req-1", { action: "cancel", client: "web" }],
    ["an answer to a question with no client", "questions/req-1", { action: "decline" }],
    ["a pick with no value", "options", { configId: "mode", client: "web" }],
    ["a pick with an extra key", "options", { configId: "mode", value: "auto", client: "web", agent: "claude" }],
    ["a pick with an empty configId", "options", { configId: "", value: "auto", client: "web" }],
    ["a pick with a configId that is not a string", "options", { configId: 1, value: "auto", client: "web" }],
    ["a pick with an empty value", "options", { configId: "mode", value: "", client: "web" }],
    ["a pick with a value that is not a string", "options", { configId: "fast", value: true, client: "web" }],
    ["a pick with an empty client", "options", { configId: "mode", value: "auto", client: "" }],
    ["a seen with no seq", "seen", { client: "web" }],
    ["a seen with a negative seq", "seen", { seq: -1, client: "web" }],
    ["a seen with a fractional seq", "seen", { seq: 1.5, client: "web" }],
    ["a seen with a seq that is a string", "seen", { seq: "3", client: "web" }],
    ["a seen with a seq above the safe integers", "seen", { seq: 2 ** 53, client: "web" }],
    ["a seen with an extra key", "seen", { seq: 1, client: "web", chat: 1 }],
    ["a seen with no client", "seen", { seq: 1 }],
    ["a seen with an empty client", "seen", { seq: 1, client: "" }],
  ])("refuses %s with 400 before it reads the chat", async (_case, command, body) => {
    const { server } = await world(await tree());

    const response = await send(server, "POST", `${CHATS}/7/${command}`, body);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });

  it("refuses a query on a command with 400", async () => {
    const { server } = await world(await tree());

    const response = await send(server, "POST", `${CHATS}/1/cancel?now=1`, { client: "web" });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });

  it("sends turn-running, chat-not-running and already-answered with 409, and a missing chat with 404", async () => {
    const { live, server, chats, runner } = await running({ prompt: forever });
    await until(() => live.chat.seq === 1 && live.chat.state === "working", "the turn runs");
    const idle = await chats.create("ALPHA", "ALPHA-2", INPUT, MESSAGE);
    await idle.append(TURN_END);
    const turnRunning = await send(server, "POST", `${CHATS}/1/messages`, MESSAGE);
    runner.stopStarts();

    const refusals = [
      [turnRunning, "turn-running", 409],
      [await send(server, "POST", `/projects/ALPHA/tasks/ALPHA-2/chats/${idle.chat.chat}/messages`, MESSAGE), "chat-not-running", 409],
      [await send(server, "POST", `${CHATS}/1/permissions/unknown`, { optionId: "allow", client: "web" }), "already-answered", 409],
      [await send(server, "POST", `${CHATS}/7/cancel`, { client: "web" }), "chat-not-found", 404],
    ] as const;

    for (const [response, code, status] of refusals) {
      expect(response.status).toBe(status);
      await expect(failure(response)).resolves.toMatchObject({ code });
    }
  });

  it("answers a pick with the chat, which holds the pick", async () => {
    const { live, server } = await running({ configOptions: [modeOption()] });
    await logUntil(live, "turn-end");

    const response = await send(server, "POST", `${CHATS}/1/options`, { configId: "mode", value: "acceptEdits", client: "web" });

    expect(response.status).toBe(200);
    const { data, diagnostics } = await success<Chat>(response);
    expect(data).toMatchObject({ task: "ALPHA-1", chat: 1, state: "needs-you", options: { mode: "acceptEdits" } });
    expect(diagnostics).toEqual([]);
  });

  it.each([
    ["a hidden value", "mode", "plan", /offers no value "plan" for "mode"/],
    ["a value the session does not offer", "mode", "fast", /offers no value "fast" for "mode"/],
    ["an option named constructor", "constructor", "plan", /offers no value "plan" for "constructor"/],
    ["an option named toString", "toString", "plan", /offers no value "plan" for "toString"/],
    ["an option named __proto__", "__proto__", "plan", /offers no value "plan" for "__proto__"/],
    ["an option named hasOwnProperty", "hasOwnProperty", "plan", /offers no value "plan" for "hasOwnProperty"/],
  ])("refuses %s with option-refused and 422", async (_case, configId, value, message) => {
    const { live, server } = await running({ configOptions: [modeOption()] });
    await logUntil(live, "turn-end");

    const response = await send(server, "POST", `${CHATS}/1/options`, { configId, value, client: "web" });

    expect(response.status).toBe(422);
    const refused = await failure(response);
    expect(refused).toMatchObject({ kind: "daemon", code: "option-refused" });
    expect(refused.message).toMatch(message);
    expect(live.chat.options).toBeUndefined();
  });

  it("refuses a value the agent refuses with option-refused and the message of the agent", async () => {
    const { live, server } = await running({
      configOptions: [modeOption()],
      setConfigOption: () => Promise.reject(new Error("auto needs another model")),
    });
    await logUntil(live, "turn-end");

    const response = await send(server, "POST", `${CHATS}/1/options`, { configId: "mode", value: "auto", client: "web" });

    expect(response.status).toBe(422);
    await expect(failure(response)).resolves.toMatchObject({
      code: "option-refused",
      message: 'the agent of chat 1 of ALPHA-1 refused "auto" for "mode": auto needs another model',
    });
  });

  it("answers a pick with a diagnostic that names the file a write missed", async () => {
    const { live, server, root } = await running({ configOptions: [modeOption()] });
    await logUntil(live, "turn-end");
    await mkdir(join(root, "agent-defaults.json", "inside"), { recursive: true });

    const response = await send(server, "POST", `${CHATS}/1/options`, { configId: "mode", value: "auto", client: "web" });

    expect(response.status).toBe(200);
    const { data, diagnostics } = await success<Chat>(response);
    expect(data.options).toEqual({ mode: "auto" });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: "option-not-saved", path: join(root, "agent-defaults.json") });
    expect(diagnostics[0]?.message).toMatch(/^the value "auto" of "mode" is not saved as the default of claude: /);
  });

  it("names the rule of seq when it refuses a seen", async () => {
    const { server } = await world(await tree());

    const response = await send(server, "POST", `${CHATS}/7/seen`, { seq: -1, client: "web" });

    await expect(failure(response)).resolves.toMatchObject({ message: '"seq" takes a non-negative integer' });
  });

  it("answers a seen with the chat, which holds it, and publishes one chat event", async () => {
    const { chats, server, events } = await world(await tree());
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    await live.append(TURN_END);
    events.length = 0;

    const response = await send(server, "POST", `${CHATS}/1/seen`, { seq: 2, client: "web" });

    expect(response.status).toBe(200);
    const { data, diagnostics } = await success<Chat>(response);
    expect(data).toMatchObject({ task: "ALPHA-1", chat: 1, seq: 2, stateSeq: 2, seen: 2, state: "needs-you" });
    expect(diagnostics).toEqual([]);
    expect((await success<Chat>(await get(server, `${CHATS}/1`))).data.seen).toBe(2);
    expect(events).toEqual([{ kind: "chat", tag: "ALPHA", task: "ALPHA-1", chat: 1, step: INPUT.step, state: "needs-you" }]);
  });

  it("keeps the stored seen for a seq that is not above it, clamps a seq above the log, and publishes only a move", async () => {
    const { chats, server, events } = await world(await tree());
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    await live.append(UPDATE);
    await live.append(TURN_END);
    events.length = 0;
    const seen = async (seq: number) =>
      (await success<Chat>(await send(server, "POST", `${CHATS}/1/seen`, { seq, client: "web" }))).data.seen;

    await expect(seen(0)).resolves.toBeUndefined();
    await expect(seen(2)).resolves.toBe(2);
    await expect(seen(1)).resolves.toBe(2);
    await expect(seen(2)).resolves.toBe(2);
    await expect(seen(40)).resolves.toBe(3);
    await expect(seen(41)).resolves.toBe(3);

    expect(events).toHaveLength(2);
  });

  it("answers a seen of a chat that is not there with chat-not-found and 404", async () => {
    const { server } = await world(await tree());

    const response = await send(server, "POST", `${CHATS}/7/seen`, { seq: 1, client: "web" });

    expect(response.status).toBe(404);
    await expect(failure(response)).resolves.toMatchObject({ code: "chat-not-found" });
  });

  it("closes a permission request for both of two clients that answer it at once", async () => {
    const { live, server } = await running(asking());
    const [permission] = requestsOf(await logUntil(live, "question"));
    const path = `${CHATS}/1/permissions/${permission}`;

    const responses = await Promise.all(["web", "app"].map((client) => send(server, "POST", path, { optionId: "allow", client })));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = responses[0]?.status === 200 ? "web" : "app";
    await expect(failure(responses.find((response) => response.status === 409)!)).resolves.toMatchObject({ code: "already-answered" });
    expect((await logOf(live)).filter((event) => event.kind === "permission-resolved")).toEqual([
      { kind: "permission-resolved", request: permission, outcome: { outcome: "selected", optionId: "allow" }, client: winner },
    ]);
  });
});
