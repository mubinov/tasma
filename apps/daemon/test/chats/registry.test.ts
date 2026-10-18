import { appendFile, chmod, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { MockInstance } from "vitest";
import { createChat, TaskStoreError } from "@tasma/engine";
import type { ChatLogEntry } from "@tasma/engine";
import type { ChatEntry, ChatEvent, FeedEvent } from "@tasma/protocol";
import { createChatRegistry } from "../../src/chats/registry.js";
import type { ChatRegistry, LiveChat } from "../../src/chats/registry.js";
import { createProjectHost } from "../../src/projects/host.js";
import type { ProjectHost } from "../../src/projects/host.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { taskRoutes } from "../../src/tasks/routes.js";
import { taskKey, WriteQueue } from "../../src/tasks/serialize.js";
import { plant, projectDir, projectsRoot, send, startTestServer, taskFile, taskText, TIMESTAMP, until } from "../helpers.js";
import type { TestServer } from "../helpers.js";

/**
 * The engine chat logs as the tests see them: how many were opened, the fault
 * the next open fails with, what each append waits for before it writes, and
 * what the next append does in place of the write, which it gets to call.
 */
const engineLog = vi.hoisted(() => {
  const state: {
    opens: number;
    openFault?: unknown;
    appendsWait?: Promise<void>;
    nextAppend?: (write: () => Promise<ChatLogEntry>) => Promise<ChatLogEntry>;
  } = { opens: 0 };
  return state;
});

vi.mock("@tasma/engine", async (importActual) => {
  const actual = await importActual<typeof import("@tasma/engine")>();

  return {
    ...actual,
    async openChatLog(...args: Parameters<typeof actual.openChatLog>) {
      engineLog.opens += 1;
      const { openFault } = engineLog;
      if (openFault !== undefined) {
        engineLog.openFault = undefined;
        throw openFault;
      }
      const log = await actual.openChatLog(...args);
      const append = log.append.bind(log);
      log.append = async (event) => {
        await engineLog.appendsWait;
        const instead = engineLog.nextAppend;
        engineLog.nextAppend = undefined;
        return instead === undefined ? append(event) : instead(() => append(event));
      };
      return log;
    },
  };
});

afterEach(() => {
  engineLog.openFault = undefined;
  engineLog.appendsWait = undefined;
  engineLog.nextAppend = undefined;
});

const INPUT = { step: "dev:build", agent: "claude", folder: "/srv/alpha" } as const;

const MESSAGE = { text: "Build the parser", client: "app" };

const UPDATE: ChatEvent = { kind: "update", update: { sessionUpdate: "agent_message_chunk" } };

const TURN_END: ChatEvent = { kind: "turn-end", stopReason: "end_turn" };

type World = { chats: ChatRegistry; writes: WriteQueue; events: FeedEvent[]; server: TestServer };

/** A tree holding project ALPHA with the tasks ALPHA-1 and ALPHA-2. */
async function tree(): Promise<string> {
  const root = await projectsRoot("ALPHA");
  await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskText("ALPHA-1"));
  await plant(taskFile(root, "ALPHA", "ALPHA-2"), taskText("ALPHA-2"));
  return root;
}

/**
 * A daemon over a tree: the registry and the project and task routes, over one
 * host and one write queue. A second call over the same tree is a restart.
 */
async function world(root: string, wrap: (host: ProjectHost) => ProjectHost = (host) => host): Promise<World> {
  const inner = createProjectHost({ root });
  onTestFinished(() => inner.close());
  const host = wrap(inner);
  const writes = new WriteQueue();
  const events: FeedEvent[] = [];
  const chats = createChatRegistry({ root, host, writes, publish: (event) => events.push(event) });
  const server = await startTestServer([...projectRoutes(host, writes, chats), ...taskRoutes(host, { writes, chats })]);
  return { chats, writes, events, server };
}

function chatFolder(root: string, tag: string, digits: string, chat: number): string {
  return join(projectDir(root, tag), "chats", digits, String(chat));
}

function logFile(root: string, tag: string, digits: string, chat: number): string {
  return join(chatFolder(root, tag, digits, chat), "events.jsonl");
}

/** Makes the next append fail as the disk fails, before its line is written. */
function failNextAppend(): void {
  engineLog.nextAppend = () => Promise.reject(new Error("the disk is gone"));
}

async function logEntries(path: string): Promise<ChatEntry[]> {
  const text = await readFile(path, "utf8");
  return text.trimEnd().split("\n").map((line) => JSON.parse(line) as ChatEntry);
}

function chatEvent(chat: number, state: "working" | "needs-you"): FeedEvent {
  return { kind: "chat", tag: "ALPHA", task: "ALPHA-1", chat, step: INPUT.step, state };
}

/** A promise a test settles by hand. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * A host whose call of one method stops until the test releases it: before the
 * engine call, or after it and so before the hook of the route.
 */
function holding(method: "rename" | "remove", when: "before" | "after") {
  const reached = gate();
  const release = gate();
  async function stop(): Promise<void> {
    reached.open();
    await release.wait;
  }
  async function held<T>(call: () => Promise<T>): Promise<T> {
    if (when === "before") await stop();
    const answer = await call();
    if (when === "after") await stop();
    return answer;
  }
  const wrap = (inner: ProjectHost): ProjectHost => method === "rename"
    ? { ...inner, rename: (tag, rename) => held(() => inner.rename(tag, rename)) }
    : { ...inner, remove: (tag) => held(() => inner.remove(tag)) };
  return { wrap, reached: reached.wait, release: release.open };
}

/** The keys of each call that asks the queue for turns, from now on. */
function watchTurns(writes: WriteQueue): () => (readonly string[])[] {
  const run = vi.spyOn(writes, "runAll");
  return () => run.mock.calls.map(([keys]) => keys);
}

describe("creating a chat", () => {
  it("gives chat 1 in working with the user entry, and publishes one chat event", async () => {
    const { chats, events } = await world(await tree());

    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    expect(live.chat).toEqual({ task: "ALPHA-1", chat: 1, ...INPUT, created: live.chat.created, seq: 1, state: "working" });
    expect(live.fold).toEqual({ turn: true, open: [], status: { state: "working" } });
    expect(live.diagnostics).toEqual([]);
    await expect(live.read(0)).resolves.toMatchObject([{ seq: 1, event: { kind: "user", ...MESSAGE } }]);
    expect(events).toEqual([chatEvent(1, "working")]);
  });

  it("gives the next number to the next chat of the task", async () => {
    const { chats } = await world(await tree());

    await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const second = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    expect(second.chat.chat).toBe(2);
  });

  it("rejects with the fault of the first append, publishes nothing, and leaves the chat with an empty log", async () => {
    const { chats, events } = await world(await tree());

    // JSON.stringify refuses a bigint, so the line of the first entry is never written.
    const unwritable = { text: 1n as unknown as string, client: "app" };
    await expect(chats.create("ALPHA", "ALPHA-1", INPUT, unwritable)).rejects.toThrow(TypeError);

    expect(events).toEqual([]);
    const left = await chats.get("ALPHA", "ALPHA-1", 1);
    expect(left.chat).toMatchObject({ chat: 1, seq: 0, state: "needs-you" });
  });

  it("gives the chat in working when its first entry reached the log before the append failed", async () => {
    const { chats, events } = await world(await tree());
    engineLog.nextAppend = async (write) => {
      await write();
      throw new Error("the disk could not flush");
    };

    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    expect(live.chat).toMatchObject({ chat: 1, seq: 1, state: "working" });
    expect(events).toEqual([chatEvent(1, "working")]);
    await expect(chats.get("ALPHA", "ALPHA-1", 1)).resolves.toBe(live);
    await expect(live.append(TURN_END)).resolves.toMatchObject({ seq: 2 });
  });

  it("rejects with the fault of the first append when the log cannot be opened again", async () => {
    const { chats, events } = await world(await tree());
    engineLog.nextAppend = async (write) => {
      await write();
      engineLog.openFault = new Error("the disk is gone");
      throw new Error("the disk could not flush");
    };

    await expect(chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE)).rejects.toThrow("the disk could not flush");

    expect(events).toEqual([]);
  });

  it("rejects with a refusal of the engine at the first append, and opens the log no second time", async () => {
    const { chats, events } = await world(await tree());
    const opened = engineLog.opens;
    const refusal = new TaskStoreError("chat-unreadable", "the event log of this chat is not a regular file", "/srv/alpha/log");
    engineLog.nextAppend = () => Promise.reject(refusal);

    await expect(chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE)).rejects.toBe(refusal);

    expect(engineLog.opens - opened).toBe(1);
    expect(events).toEqual([]);
  });
});

describe("a tag or a task that does not exist", () => {
  it("refuses a tag of no project with project-not-found, and a task of none with task-not-found", async () => {
    const { chats } = await world(await tree());

    await expect(chats.create("NOPE", "NOPE-1", INPUT, MESSAGE)).rejects.toMatchObject({ code: "project-not-found" });
    await expect(chats.get("NOPE", "NOPE-1", 1)).rejects.toMatchObject({ code: "project-not-found" });
    await expect(chats.list("NOPE", "NOPE-1")).rejects.toMatchObject({ code: "project-not-found" });
    await expect(chats.create("ALPHA", "ALPHA-9", INPUT, MESSAGE)).rejects.toMatchObject({ code: "task-not-found" });
    await expect(chats.get("ALPHA", "ALPHA-9", 1)).rejects.toMatchObject({ code: "task-not-found" });
    await expect(chats.list("ALPHA", "ALPHA-9")).rejects.toMatchObject({ code: "task-not-found" });
  });
});

describe("appending to a chat", () => {
  it("publishes one chat event for a change of status, and none for an append that keeps it", async () => {
    const { chats, events } = await world(await tree());
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    await expect(live.append(UPDATE)).resolves.toMatchObject({ seq: 2, event: UPDATE });
    expect(events).toEqual([chatEvent(1, "working")]);

    await live.append(TURN_END);

    expect(events).toEqual([chatEvent(1, "working"), chatEvent(1, "needs-you")]);
    expect(live.chat).toMatchObject({ seq: 3, state: "needs-you" });
  });

  it("publishes a change of where a chat continues", async () => {
    const { chats, events } = await world(await tree());
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    await live.append({ kind: "continued-outside", where: "vscode" });
    await live.append({ kind: "continued-outside", where: "vscode" });
    await live.append({ kind: "continued-outside", where: "terminal" });

    expect(events.slice(1)).toEqual([
      { kind: "chat", tag: "ALPHA", task: "ALPHA-1", chat: 1, step: INPUT.step, state: "continued-outside", where: "vscode" },
      { kind: "chat", tag: "ALPHA", task: "ALPHA-1", chat: 1, step: INPUT.step, state: "continued-outside", where: "terminal" },
    ]);
  });

  it("gives the entries to a read in order, after a seq and up to a size", async () => {
    const { chats } = await world(await tree());
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    await live.append(UPDATE);
    await live.append(TURN_END);

    const all = await live.read(0);

    expect(all.map((entry) => [entry.seq, entry.event.kind])).toEqual([[1, "user"], [2, "update"], [3, "turn-end"]]);
    await expect(live.read(1)).resolves.toEqual(all.slice(1));
    await expect(live.read(0, 1)).resolves.toEqual(all.slice(0, 1));
  });

  it("changes nothing at a failed append, and opens the log again before the next one", async () => {
    const root = await tree();
    const { chats, events } = await world(root);
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const log = logFile(root, "ALPHA", "1", 1);

    await chmod(log, 0o400);
    await expect(live.append(UPDATE)).rejects.toMatchObject({ code: "EACCES" });
    await chmod(log, 0o600);

    expect(live.chat).toMatchObject({ seq: 1, state: "working" });
    // The line a failed append can still leave on disk, which only a new open reads.
    await appendFile(log, `${JSON.stringify({ seq: 2, at: TIMESTAMP, event: TURN_END })}\n`);

    await expect(live.append({ kind: "user", text: "Go on", client: "cli" })).resolves.toMatchObject({ seq: 3 });

    expect(events).toEqual([chatEvent(1, "working"), chatEvent(1, "needs-you"), chatEvent(1, "working")]);
    expect((await logEntries(log)).map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it("opens the log no second time after a refusal of the engine", async () => {
    const root = await tree();
    const { chats } = await world(root);
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const log = logFile(root, "ALPHA", "1", 1);
    const opened = engineLog.opens;

    await link(log, `${log}.second`);
    await expect(live.append(UPDATE)).rejects.toMatchObject({ code: "chat-unreadable" });
    await rm(`${log}.second`);

    await expect(live.append(UPDATE)).resolves.toMatchObject({ seq: 2 });
    expect(engineLog.opens).toBe(opened);
  });

  it("refuses for good once an append finds the chat gone, and leaves a new chat of that number its own log", async () => {
    const root = await tree();
    const { chats } = await world(root);
    const gone = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    await rm(chatFolder(root, "ALPHA", "1", 1), { recursive: true });

    await expect(gone.append(UPDATE)).rejects.toMatchObject({ code: "chat-not-found" });
    const next = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const opened = engineLog.opens;

    expect(next.chat.chat).toBe(1);
    await expect(gone.append(UPDATE)).rejects.toMatchObject({ code: "chat-not-found" });
    expect(engineLog.opens).toBe(opened);
    await expect(chats.get("ALPHA", "ALPHA-1", 1)).resolves.toBe(next);
    expect((await logEntries(logFile(root, "ALPHA", "1", 1))).map((entry) => entry.seq)).toEqual([1]);
  });

  it("makes a handle refuse once a create gives its chat number to a new chat", async () => {
    const root = await tree();
    const { chats } = await world(root);
    const gone = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    failNextAppend();
    await expect(gone.append(UPDATE)).rejects.toThrow("the disk is gone");
    await rm(chatFolder(root, "ALPHA", "1", 1), { recursive: true });

    const next = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    expect(next.chat.chat).toBe(1);
    await expect(gone.append(UPDATE)).rejects.toMatchObject({ code: "chat-not-found" });
    expect((await logEntries(logFile(root, "ALPHA", "1", 1))).map((entry) => entry.seq)).toEqual([1]);
  });

  it("makes the handle refuse once a new open of the log finds its task gone", async () => {
    const root = await tree();
    const { chats } = await world(root);
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    failNextAppend();
    await expect(live.append(UPDATE)).rejects.toThrow("the disk is gone");
    await rm(taskFile(root, "ALPHA", "ALPHA-1"));

    await expect(live.append(UPDATE)).rejects.toMatchObject({ code: "task-not-found" });

    await expect(live.read(0)).rejects.toMatchObject({ code: "chat-not-found" });
  });
});

describe("the session of a chat", () => {
  it("is written to the record, which a restart reads", async () => {
    const root = await tree();
    const { chats } = await world(root);
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    await live.setSession("session-7");

    expect(live.chat.session).toBe("session-7");
    const restarted = await world(root);
    await expect(restarted.chats.get("ALPHA", "ALPHA-1", 1)).resolves.toMatchObject({ chat: { session: "session-7" } });
  });

  it("is refused for a chat removed by hand, which the handle then stands for no more", async () => {
    const root = await tree();
    const { chats } = await world(root);
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    await rm(chatFolder(root, "ALPHA", "1", 1), { recursive: true });

    await expect(live.setSession("session-7")).rejects.toMatchObject({ code: "chat-not-found" });

    await expect(chats.get("ALPHA", "ALPHA-1", 1)).rejects.toMatchObject({ code: "chat-not-found" });
  });
});

describe("loading a chat", () => {
  it("gives the same chat, seq and status after a restart, through get and through list", async () => {
    const root = await tree();
    const first = await world(root);
    const live = await first.chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    await live.append(TURN_END);

    const byGet = await (await world(root)).chats.get("ALPHA", "ALPHA-1", 1);
    const byList = await (await world(root)).chats.list("ALPHA", "ALPHA-1");

    expect(byGet.chat).toEqual(live.chat);
    expect(byGet.fold).toEqual(live.fold);
    expect(byList.chats.map((listed) => listed.chat)).toEqual([live.chat]);
    expect(byList.diagnostics).toEqual([]);
  });

  it("opens the log one time for two gets of one chat", async () => {
    const root = await tree();
    await (await world(root)).chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const { chats } = await world(root);
    const before = engineLog.opens;

    const [one, two] = await Promise.all([chats.get("ALPHA", "ALPHA-1", 1), chats.get("ALPHA", "ALPHA-1", 1)]);

    expect(one).toBe(two);
    expect(engineLog.opens - before).toBe(1);
    await expect(chats.get("ALPHA", "ALPHA-1", 1)).resolves.toBe(one);
  });

  it("keeps nothing of a load that failed", async () => {
    const root = await tree();
    await (await world(root)).chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const { chats } = await world(root);
    const record = join(chatFolder(root, "ALPHA", "1", 1), "chat.json");
    const text = await readFile(record, "utf8");

    await writeFile(record, "{", "utf8");
    await expect(chats.get("ALPHA", "ALPHA-1", 1)).rejects.toMatchObject({ code: "chat-unreadable" });
    await writeFile(record, text, "utf8");

    await expect(chats.get("ALPHA", "ALPHA-1", 1)).resolves.toMatchObject({ chat: { seq: 1, state: "working" } });
  });

  it("reports the lines of a log that hold no entry", async () => {
    const root = await tree();
    await (await world(root)).chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const log = logFile(root, "ALPHA", "1", 1);
    await appendFile(log, "not an entry\n");
    const { chats } = await world(root);

    const live = await chats.get("ALPHA", "ALPHA-1", 1);

    expect(live.chat.seq).toBe(1);
    expect(live.diagnostics).toMatchObject([{ code: "chat-file-unreadable", path: log, line: 2 }]);
    await expect(chats.list("ALPHA", "ALPHA-1")).resolves.toMatchObject({
      diagnostics: [{ code: "chat-file-unreadable", path: log, line: 2 }],
    });
  });
});

describe("listing the chats of a task", () => {
  it("gives them in number order, and reports a chat folder that has no record", async () => {
    const root = await tree();
    const { chats } = await world(root);
    await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const folder = chatFolder(root, "ALPHA", "1", 3);
    await mkdir(folder);

    const { chats: listed, diagnostics } = await (await world(root)).chats.list("ALPHA", "ALPHA-1");

    expect(listed.map((live) => live.chat.chat)).toEqual([1, 2]);
    expect(diagnostics).toMatchObject([{ code: "chat-file-unreadable", path: join(folder, "chat.json") }]);
  });

  it("gives a loaded chat as its handle", async () => {
    const { chats } = await world(await tree());
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    const { chats: listed } = await chats.list("ALPHA", "ALPHA-1");

    expect(listed).toHaveLength(1);
    expect(listed[0]).toBe(live);
  });

  it("gives an empty list for a task with no chat", async () => {
    const { chats } = await world(await tree());

    await expect(chats.list("ALPHA", "ALPHA-2")).resolves.toEqual({ chats: [], diagnostics: [] });
  });

  it("leaves out and reports a chat whose log cannot be opened, by the chat folder for a fault that names no path", async () => {
    const root = await tree();
    const first = await world(root);
    await first.chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    await first.chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const { chats } = await world(root);

    engineLog.openFault = new TaskStoreError("chat-unreadable", "the event log changed under this chat", "/srv/alpha/log");
    const refused = await chats.list("ALPHA", "ALPHA-1");
    engineLog.openFault = new Error("the disk is gone");
    const faulted = await chats.list("ALPHA", "ALPHA-1");

    expect(refused.chats.map((live) => live.chat.chat)).toEqual([2]);
    expect(refused.diagnostics).toEqual([
      { code: "chat-file-unreadable", message: "the event log changed under this chat", path: "/srv/alpha/log" },
    ]);
    expect(faulted.chats.map((live) => live.chat.chat)).toEqual([2]);
    expect(faulted.diagnostics).toEqual([
      { code: "chat-file-unreadable", message: "this chat cannot be read: the disk is gone", path: chatFolder(root, "ALPHA", "1", 1) },
    ]);
  });
});

describe("a rename of the project of a live chat", () => {
  it("moves the handle to the new tag, which appends into the renamed project", async () => {
    const root = await tree();
    await plant(taskFile(root, "GAMMA", "GAMMA-1"), taskText("GAMMA-1"));
    const { chats, events, server } = await world(root);
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const other = await chats.create("GAMMA", "GAMMA-1", INPUT, MESSAGE);

    expect((await send(server, "POST", "/projects/ALPHA/rename", { tag: "BETA" })).status).toBe(200);
    await live.append(TURN_END);

    expect(live.chat).toMatchObject({ task: "BETA-1", chat: 1, seq: 2, state: "needs-you" });
    expect((await logEntries(logFile(root, "BETA", "1", 1))).map((entry) => entry.seq)).toEqual([1, 2]);
    expect(events.at(-1)).toEqual({ ...chatEvent(1, "needs-you"), tag: "BETA", task: "BETA-1" });
    await expect(chats.get("BETA", "BETA-1", 1)).resolves.toBe(live);
    await expect(chats.get("ALPHA", "ALPHA-1", 1)).rejects.toMatchObject({ code: "project-not-found" });
    expect(other.chat.task).toBe("GAMMA-1");
    await expect(chats.get("GAMMA", "GAMMA-1", 1)).resolves.toBe(other);
  });

  it("makes an append called after the engine rename wait, and land in the renamed project", async () => {
    const root = await tree();
    const held = holding("rename", "after");
    const { chats, server } = await world(root, held.wrap);
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    const renaming = send(server, "POST", "/projects/ALPHA/rename", { tag: "BETA" });
    await held.reached;
    const appending = live.append(TURN_END);
    held.release();

    expect((await renaming).status).toBe(200);
    await expect(appending).resolves.toMatchObject({ seq: 2 });
    expect((await logEntries(logFile(root, "BETA", "1", 1))).map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("makes a delete of the task right after the rename wait for an append that waited for the rename", async () => {
    const root = await tree();
    const held = holding("rename", "after");
    const { chats, writes, server } = await world(root, held.wrap);
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const asked = watchTurns(writes);
    const write = gate();
    engineLog.appendsWait = write.wait;

    const renaming = send(server, "POST", "/projects/ALPHA/rename", { tag: "BETA" });
    await held.reached;
    const appending = live.append(TURN_END);
    held.release();
    expect((await renaming).status).toBe(200);
    const deleting = send(server, "DELETE", "/projects/BETA/tasks/BETA-1");
    // The append asks for these turns again once the rename ends, and the delete asks for them after it.
    const deleteTurn = taskKey("BETA", "BETA-1");
    await until(() => asked().filter((keys) => keys.includes(deleteTurn)).length === 2, "the delete asked for its turns");
    write.open();

    await expect(appending).resolves.toMatchObject({ seq: 2 });
    expect((await deleting).status).toBe(200);
    await expect(live.append(UPDATE)).rejects.toMatchObject({ code: "chat-not-found" });
  });

  it("gives two appends called during the rename their seq in the order of the calls", async () => {
    const root = await tree();
    const held = holding("rename", "before");
    let second: Promise<ChatEntry> | undefined;
    // The rename reads its project back under the new tag after its hook, so the
    // second append comes for the new tag while the first one still waits for
    // the old tag.
    const wrap = (inner: ProjectHost): ProjectHost => {
      const host = held.wrap(inner);
      return {
        ...host,
        async open(tag) {
          if (tag === "BETA") second ??= live.append(TURN_END);
          return host.open(tag);
        },
      };
    };
    const { chats, server } = await world(root, wrap);
    const live: LiveChat = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    const renaming = send(server, "POST", "/projects/ALPHA/rename", { tag: "BETA" });
    await held.reached;
    const first = live.append(UPDATE);
    held.release();

    expect((await renaming).status).toBe(200);
    await expect(first).resolves.toMatchObject({ seq: 2, event: UPDATE });
    await expect(second).resolves.toMatchObject({ seq: 3, event: TURN_END });
    const entries = await logEntries(logFile(root, "BETA", "1", 1));
    expect(entries.map((entry) => entry.event.kind)).toEqual(["user", "update", "turn-end"]);
  });

  it("gives the moved handle to a get of the new tag that waited behind the rename", async () => {
    const root = await tree();
    const held = holding("rename", "after");
    const { chats, writes, server } = await world(root, held.wrap);
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const opened = engineLog.opens;
    const asked = watchTurns(writes);

    const renaming = send(server, "POST", "/projects/ALPHA/rename", { tag: "BETA" });
    await held.reached;
    const getting = chats.get("BETA", "BETA-1", 1);
    await until(() => asked().some((keys) => keys.includes(taskKey("BETA", "BETA-1"))), "the get asked for its turns");
    held.release();

    expect((await renaming).status).toBe(200);
    await expect(getting).resolves.toBe(live);
    expect(engineLog.opens).toBe(opened);
  });

  it("makes a handle refuse that a moved handle takes the place of", async () => {
    const root = await tree();
    await plant(taskFile(root, "BETA", "BETA-1"), taskText("BETA-1"));
    const { chats } = await world(root);
    const moved = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const replaced = await chats.create("BETA", "BETA-1", INPUT, MESSAGE);

    chats.projectRenamed("ALPHA", "BETA");

    await expect(replaced.append(UPDATE)).rejects.toMatchObject({ code: "chat-not-found" });
    await expect(chats.get("BETA", "BETA-1", 1)).resolves.toBe(moved);
  });
});

describe("a delete under a live chat", () => {
  it("makes the handle refuse with chat-not-found after a delete of its project", async () => {
    const { chats, server } = await world(await tree());
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);

    expect((await send(server, "DELETE", "/projects/ALPHA")).status).toBe(200);

    await expect(live.append(UPDATE)).rejects.toMatchObject({ code: "chat-not-found" });
    await expect(live.setSession("session-7")).rejects.toMatchObject({ code: "chat-not-found" });
    await expect(live.read(0)).rejects.toMatchObject({ code: "chat-not-found" });
  });

  it("makes the handles of the deleted task alone refuse after a delete of a task", async () => {
    const { chats, server } = await world(await tree());
    const deleted = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const kept = await chats.create("ALPHA", "ALPHA-2", INPUT, MESSAGE);

    expect((await send(server, "DELETE", "/projects/ALPHA/tasks/ALPHA-1")).status).toBe(200);

    await expect(deleted.append(UPDATE)).rejects.toMatchObject({ code: "chat-not-found" });
    await expect(kept.append(UPDATE)).resolves.toMatchObject({ seq: 2 });
    await expect(chats.get("ALPHA", "ALPHA-1", 1)).rejects.toMatchObject({ code: "task-not-found" });
  });

  it("makes a delete of a task under the new tag wait for the rename, and then removes the moved handle", async () => {
    const root = await tree();
    const held = holding("rename", "after");
    let deletes: MockInstance | undefined;
    const wrap = (inner: ProjectHost): ProjectHost => {
      const host = held.wrap(inner);
      return {
        ...host,
        async open(tag) {
          const opened = await host.open(tag);
          if (tag === "BETA") deletes ??= vi.spyOn(opened.index, "deleteTask");
          return opened;
        },
      };
    };
    const { chats, writes, server } = await world(root, wrap);
    const live = await chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const asked = watchTurns(writes);

    const renaming = send(server, "POST", "/projects/ALPHA/rename", { tag: "BETA" });
    await held.reached;
    const deleting = send(server, "DELETE", "/projects/BETA/tasks/BETA-1");
    await until(() => asked().some((keys) => keys.includes(taskKey("BETA", "BETA-1"))), "the delete asked for its turns");

    expect(deletes?.mock.calls).toEqual([]);
    held.release();
    expect((await renaming).status).toBe(200);
    expect((await deleting).status).toBe(200);
    await expect(chats.get("BETA", "BETA-1", 1)).rejects.toMatchObject({ code: "task-not-found" });
    await expect(live.append(UPDATE)).rejects.toMatchObject({ code: "chat-not-found" });
  });

  it("refuses a get that waited behind a delete of the project, and keeps nothing of it", async () => {
    const root = await tree();
    await (await world(root)).chats.create("ALPHA", "ALPHA-1", INPUT, MESSAGE);
    const held = holding("remove", "before");
    const { chats, writes, server } = await world(root, held.wrap);
    const asked = watchTurns(writes);

    const removing = send(server, "DELETE", "/projects/ALPHA");
    await held.reached;
    const getting = chats.get("ALPHA", "ALPHA-1", 1);
    await until(() => asked().some((keys) => keys.includes(taskKey("ALPHA", "ALPHA-1"))), "the get asked for its turns");
    held.release();

    await expect(getting).rejects.toMatchObject({ code: "project-not-found" });
    expect((await removing).status).toBe(200);
    // A project, a task and a chat under the same names again.
    await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskText("ALPHA-1"));
    await createChat({ project: "ALPHA", root }, "ALPHA-1", { ...INPUT, step: "dev:again" });
    await expect(chats.get("ALPHA", "ALPHA-1", 1)).resolves.toMatchObject({ chat: { step: "dev:again", seq: 0 } });
  });
});
