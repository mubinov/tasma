import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { Chat, ChatEntry, ChatEvent, ChatEventsReply } from "@tasma/protocol";
import type { AgentAdapter } from "../../src/agents/adapter.js";
import { createChatRegistry } from "../../src/chats/registry.js";
import type { ChatRegistry, LiveChat } from "../../src/chats/registry.js";
import { chatRoutes } from "../../src/chats/routes.js";
import { createChatRunner } from "../../src/chats/runner.js";
import type { ChatRunner } from "../../src/chats/runner.js";
import { createProjectHost } from "../../src/projects/host.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { taskRoutes } from "../../src/tasks/routes.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import { fakeAgent, forever } from "../agents/fake-agent.js";
import type { Script } from "../agents/fake-agent.js";
import {
  chatFolder,
  failure,
  get,
  logFile,
  logOf,
  logUntil,
  plant,
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

const ADAPTER: AgentAdapter = {
  agent: "claude",
  launch: () => ({ command: "fake-agent", args: [], env: {} }),
  notLoggedIn: "Log in to the agent first",
  filterUpdate: (update) => update,
};

type World = { chats: ChatRegistry; runner: ChatRunner; server: TestServer };

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
async function world(root: string, options: { holdMs?: number; script?: Script } = {}): Promise<World> {
  const host = createProjectHost({ root });
  const writes = new WriteQueue();
  const chats = createChatRegistry({ root, host, writes, holdMs: options.holdMs ?? LONG_HOLD_MS });
  const { spawn } = fakeAgent(options.script);
  const runner = createChatRunner({ root, chats, adapters: [ADAPTER], env: {}, spawn });
  onTestFinished(async () => {
    await runner.close();
    chats.close();
    await host.close();
  });
  const server = await startTestServer([
    ...projectRoutes(host, writes, chats),
    ...taskRoutes(host, { writes, chats }),
    ...chatRoutes(chats, runner),
  ]);
  return { chats, runner, server };
}

/** A daemon whose project ALPHA has a folder, with chat 1 of ALPHA-1 started through the runner. */
async function running(script?: Script): Promise<World & { live: LiveChat }> {
  const root = await tree();
  await plant(projectConfig(root, "ALPHA"), `path: ${await target()}\n`);
  const started = await world(root, { script });
  const live = await started.runner.start({ tag: "ALPHA", task: "ALPHA-1", step: "dev:build", agent: "claude", ...MESSAGE });
  return { ...started, live };
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

describe("GET …/chats/{chat}", () => {
  it("gives one chat with the findings of its log, which a read of the log leaves out", async () => {
    const root = await tree();
    const live = await (await world(root)).chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const log = logFile(root, "ALPHA", "1", 1);
    await appendFile(log, "not an entry\n");
    const { server } = await world(root);

    const { data, diagnostics } = await success(await get(server, `${CHATS}/1`));
    const read = await success(await get(server, `${CHATS}/1/events?after=0`));

    expect(data).toEqual(live.chat);
    expect(diagnostics).toMatchObject([{ code: "chat-file-unreadable", path: log, line: 2 }]);
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

  const LONG_CLIENT = "c".repeat(101);

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
    const { live, server, chats } = await running({ prompt: forever });
    await until(() => live.chat.seq === 1 && live.chat.state === "working", "the turn runs");
    const idle = await chats.create("ALPHA", "ALPHA-2", INPUT, MESSAGE);

    const refusals = [
      [await send(server, "POST", `${CHATS}/1/messages`, MESSAGE), "turn-running", 409],
      [await send(server, "POST", `/projects/ALPHA/tasks/ALPHA-2/chats/${idle.chat.chat}/messages`, MESSAGE), "chat-not-running", 409],
      [await send(server, "POST", `${CHATS}/1/permissions/unknown`, { optionId: "allow", client: "web" }), "already-answered", 409],
      [await send(server, "POST", `${CHATS}/7/cancel`, { client: "web" }), "chat-not-found", 404],
    ] as const;

    for (const [response, code, status] of refusals) {
      expect(response.status).toBe(status);
      await expect(failure(response)).resolves.toMatchObject({ code });
    }
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
