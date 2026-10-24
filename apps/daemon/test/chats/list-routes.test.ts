import { Buffer } from "node:buffer";
import { chmod, link, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { TaskStoreError } from "@tasma/engine";
import type { ChatEvent, ChatListItem, ChatListPage, Diagnostic, FeedEvent } from "@tasma/protocol";
import { chatListRoutes } from "../../src/chats/list-routes.js";
import { createChatRegistry } from "../../src/chats/registry.js";
import type { ChatRegistry } from "../../src/chats/registry.js";
import { createProjectHost } from "../../src/projects/host.js";
import type { ProjectHost } from "../../src/projects/host.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import {
  chatFolder,
  failure,
  get,
  logFile,
  plant,
  plantChat,
  projectConfig,
  projectDir,
  projectsRoot,
  startTestServer,
  success,
  taskFile,
  tasksDir,
  taskText,
  until,
} from "../helpers.js";
import type { TestServer } from "../helpers.js";

const USER: ChatEvent = { kind: "user", text: "Build the parser", client: "app" };

const TURN_END: ChatEvent = { kind: "turn-end", stopReason: "end_turn" };

type World = { server: TestServer; chats: ChatRegistry; events: FeedEvent[] };

async function plantTask(root: string, id: string, title?: string, status?: string): Promise<void> {
  await plant(taskFile(root, id.slice(0, id.indexOf("-")), id), taskText(id, title, status));
}

/** The place of one chat of a task, by the task id as written. */
function at(task: string, chat: number): { tag: string; digits: string; chat: number } {
  const dash = task.indexOf("-");
  return { tag: task.slice(0, dash), digits: task.slice(dash + 1), chat };
}

/** A daemon with the list routes over a tree. What `open` gives takes the place of the open of the host. */
async function world(root: string, open?: (host: ProjectHost) => ProjectHost["open"]): Promise<World> {
  const events: FeedEvent[] = [];
  const host = createProjectHost({ root, publish: (event) => events.push(event) });
  const chats = createChatRegistry({ root, host, writes: new WriteQueue() });
  onTestFinished(async () => {
    chats.close();
    await host.close();
  });
  const served = open === undefined ? host : { ...host, open: open(host) };
  const server = await startTestServer(chatListRoutes({ root, host: served, chats }));
  return { server, chats, events };
}

async function page(server: TestServer, query = ""): Promise<{ data: ChatListPage; diagnostics: Diagnostic[] }> {
  const response = await get(server, `/chats${query}`);
  expect(response.status).toBe(200);
  return success<ChatListPage>(response);
}

async function item(server: TestServer, path: string): Promise<{ data: ChatListItem; diagnostics: Diagnostic[] }> {
  const response = await get(server, path);
  expect(response.status).toBe(200);
  return success<ChatListItem>(response);
}

function places(items: ChatListItem[]): string[] {
  return items.map((listed) => `${listed.task}/${listed.chat}`);
}

async function allPages(server: TestServer): Promise<ChatListPage[]> {
  const pages = [(await page(server)).data];
  while (pages.at(-1)!.next !== undefined) {
    pages.push((await page(server, `?after=${pages.at(-1)!.next}`)).data);
  }
  return pages;
}

/** ALPHA-1, ALPHA-2 and BETA-1, each with one chat, at three different times. */
async function threeTasks(): Promise<string> {
  const root = await projectsRoot("ALPHA", "BETA");
  await plantTask(root, "ALPHA-1", "Parse the tree");
  await plantTask(root, "ALPHA-2", "Draw the board");
  await plantTask(root, "BETA-1", "Parse the board");
  await plantChat(root, at("ALPHA-1", 1), { created: "2026-01-01T10:00:00+03:00" });
  await plantChat(root, at("ALPHA-2", 1), { step: "dev:review", created: "2026-01-01T09:00:00+00:00" });
  await plantChat(root, at("BETA-1", 1), { created: "2026-01-01T08:00:00+00:00" });
  return root;
}

/** ALPHA-1 with 60 chats, one minute apart. */
async function sixtyChats(): Promise<string> {
  const root = await projectsRoot("ALPHA");
  await plantTask(root, "ALPHA-1");
  for (let chat = 1; chat <= 60; chat += 1) {
    await plantChat(root, at("ALPHA-1", chat), { created: `2026-01-01T00:${String(chat - 1).padStart(2, "0")}:00Z` });
  }
  return root;
}

describe("GET /chats", () => {
  it("lists the chats of all projects newest first, each with its task, step, agent, time and state", async () => {
    const { server } = await world(await threeTasks());

    const { data, diagnostics } = await page(server);

    expect(data).toEqual({
      items: [
        { tag: "ALPHA", task: "ALPHA-2", title: "Draw the board", chat: 1, step: "dev:review", agent: "claude", created: "2026-01-01T09:00:00+00:00", status: { state: "needs-you" } },
        { tag: "BETA", task: "BETA-1", title: "Parse the board", chat: 1, step: "dev:build", agent: "claude", created: "2026-01-01T08:00:00+00:00", status: { state: "needs-you" } },
        { tag: "ALPHA", task: "ALPHA-1", title: "Parse the tree", chat: 1, step: "dev:build", agent: "claude", created: "2026-01-01T10:00:00+03:00", status: { state: "needs-you" } },
      ],
      total: 3,
    });
    expect(diagnostics).toEqual([]);
  });

  it("orders chats of one time by the tag, the task number high first, the task id, and the chat number high first", async () => {
    const root = await projectsRoot("ALPHA", "BETA");
    const times = ["2026-01-01T00:00:00+03:00", "2025-12-31T21:00:00Z", "2026-01-01T01:00:00+04:00"];
    const chats: [string, number][] = [["BETA-1", 1], ["ALPHA-7", 1], ["ALPHA-7", 2], ["ALPHA-007", 1], ["ALPHA-12", 1]];
    for (const [position, [task, chat]] of chats.entries()) {
      await plantTask(root, task);
      await plantChat(root, at(task, chat), { created: times[position % times.length] });
    }
    const { server } = await world(root);

    const { data } = await page(server);

    expect(places(data.items)).toEqual(["ALPHA-12/1", "ALPHA-007/1", "ALPHA-7/2", "ALPHA-7/1", "BETA-1/1"]);
  });

  it("serves the list in pages of 50, each chat in exactly one page", async () => {
    const root = await projectsRoot("ALPHA");
    const planted: string[] = [];
    for (const task of ["ALPHA-1", "ALPHA-2", "ALPHA-3"]) {
      await plantTask(root, task);
      for (let chat = 1; chat <= 40; chat += 1) {
        const minute = String(planted.length % 60).padStart(2, "0");
        const hour = String(Math.floor(planted.length / 60)).padStart(2, "0");
        await plantChat(root, at(task, chat), { created: `2026-01-01T${hour}:${minute}:00Z` });
        planted.push(`${task}/${chat}`);
      }
    }
    const { server } = await world(root);

    const pages = await allPages(server);

    expect(pages.map((one) => [one.items.length, one.total, one.next !== undefined])).toEqual([
      [50, 120, true],
      [50, 120, true],
      [20, 120, false],
    ]);
    expect(pages.flatMap((one) => places(one.items))).toEqual(planted.toReversed());
  });

  it("starts a page after the cursor also when the chat of the cursor is gone", async () => {
    const root = await sixtyChats();
    const { server } = await world(root);
    const first = (await page(server)).data;
    const second = (await page(server, `?after=${first.next}`)).data;

    await rm(chatFolder(root, "ALPHA", "1", first.items.at(-1)!.chat), { recursive: true });

    const again = await page(server, `?after=${first.next}`);
    expect(places(again.data.items)).toEqual(places(second.items));
    expect(again.data.total).toBe(59);
  });

  it("answers an empty last page for a cursor that no chat comes after", async () => {
    const root = await sixtyChats();
    const { server } = await world(root);
    const first = (await page(server)).data;

    for (let chat = 1; chat <= 10; chat += 1) await rm(chatFolder(root, "ALPHA", "1", chat), { recursive: true });

    await expect(page(server, `?after=${first.next}`)).resolves.toEqual({ data: { items: [], total: 50 }, diagnostics: [] });
  });

  it.each([
    ["no base64url JSON", "not-a-cursor"],
    ["a JSON value of another shape", Buffer.from(JSON.stringify([1, "ALPHA"])).toString("base64url")],
    ["a key with a time that is no number", Buffer.from(JSON.stringify(["x", "ALPHA", 1, "ALPHA-1", 1])).toString("base64url")],
  ])("refuses a cursor that holds %s with malformed-request", async (_name, cursor) => {
    const { server } = await world(await threeTasks());

    const response = await get(server, `/chats?after=${cursor}`);

    expect(response.status).toBe(400);
    expect(await failure(response)).toMatchObject({ code: "malformed-request" });
  });

  it.each([
    ["a key it does not declare", "?status=Done"],
    ["a key stated twice", "?q=parse&q=tree"],
  ])("refuses %s with malformed-request", async (_name, query) => {
    const { server } = await world(await threeTasks());

    const response = await get(server, `/chats${query}`);

    expect(response.status).toBe(400);
    expect(await failure(response)).toMatchObject({ code: "malformed-request" });
  });

  it("keeps the chats of the project that project names", async () => {
    const { server } = await world(await threeTasks());

    const { data } = await page(server, "?project=ALPHA");

    expect(places(data.items)).toEqual(["ALPHA-2/1", "ALPHA-1/1"]);
    expect(data.total).toBe(2);
  });

  it("refuses a project the tree does not hold with project-not-found", async () => {
    const { server } = await world(await threeTasks());

    const response = await get(server, "/chats?project=GAMMA");

    expect(response.status).toBe(404);
    expect(await failure(response)).toMatchObject({ code: "project-not-found" });
  });

  it.each([
    ["the task id", "beta-1", ["BETA-1/1"]],
    ["the title, in any case", "TREE", ["ALPHA-1/1"]],
    ["the step", "review", ["ALPHA-2/1"]],
    ["two words in any order", "board%20parse", ["BETA-1/1"]],
    ["only spaces", "%20%20", ["ALPHA-2/1", "BETA-1/1", "ALPHA-1/1"]],
    ["no text across two fields", "1parse", []],
  ])("matches q against %s", async (_name, q, expected) => {
    const { server } = await world(await threeTasks());

    const { data } = await page(server, `?q=${q}`);

    expect(places(data.items)).toEqual(expected);
    expect(data.total).toBe(expected.length);
  });

  it("narrows by project and q together", async () => {
    const { server } = await world(await threeTasks());

    const { data } = await page(server, "?project=ALPHA&q=parse");

    expect(places(data.items)).toEqual(["ALPHA-1/1"]);
    expect(data.total).toBe(1);
  });

  it("gives a state to the latest chat of a task alone, the state the registry folds", async () => {
    const root = await projectsRoot("ALPHA");
    await plantTask(root, "ALPHA-1");
    await plantTask(root, "ALPHA-2");
    await plantChat(root, at("ALPHA-1", 1), { created: "2026-01-01T00:01:00Z" }, [USER, TURN_END]);
    await plantChat(root, at("ALPHA-1", 2), { created: "2026-01-01T00:02:00Z" }, [USER]);
    await plantChat(root, at("ALPHA-2", 1), { created: "2026-01-01T00:03:00Z" }, [USER, { kind: "continued-outside", where: "vscode" }]);
    const { server, chats } = await world(root);

    const { data } = await page(server);

    expect(data.items.map((listed) => [listed.task, listed.chat, listed.status])).toEqual([
      ["ALPHA-2", 1, { state: "continued-outside", where: "vscode" }],
      ["ALPHA-1", 2, { state: "needs-you" }],
      ["ALPHA-1", 1, undefined],
    ]);
    expect(data.items[1]!.status).toEqual((await chats.get("ALPHA", "ALPHA-1", 2)).fold.status);
  });

  it.each(["Done", "dOnE"])("gives no state to the chats of a task whose status is %s", async (status) => {
    const root = await projectsRoot("ALPHA");
    await plantTask(root, "ALPHA-1", "Planted", status);
    await plantChat(root, at("ALPHA-1", 1), {}, [USER]);
    const { server } = await world(root);

    const { data } = await page(server);

    expect(data.items).toHaveLength(1);
    expect(data.items[0]!.status).toBeUndefined();
  });

  it("gives no state to an older chat that q keeps when the latest chat does not match", async () => {
    const root = await projectsRoot("ALPHA");
    await plantTask(root, "ALPHA-1");
    await plantChat(root, at("ALPHA-1", 1), { step: "dev:review", created: "2026-01-01T00:01:00Z" });
    await plantChat(root, at("ALPHA-1", 2), { step: "dev:build", created: "2026-01-01T00:02:00Z" });
    const { server } = await world(root);

    const { data } = await page(server, "?q=review");

    expect(data.items.map((listed) => [listed.chat, listed.status])).toEqual([[1, undefined]]);
  });

  it("takes the chat before a broken latest chat as the latest, and reports the broken one", async () => {
    const root = await projectsRoot("ALPHA");
    await plantTask(root, "ALPHA-1");
    await plantChat(root, at("ALPHA-1", 1), {}, [USER]);
    await plant(join(chatFolder(root, "ALPHA", "1", 2), "chat.json"), "{");
    const { server } = await world(root);

    const { data, diagnostics } = await page(server);

    expect(data.items.map((listed) => [listed.chat, listed.status])).toEqual([[1, { state: "needs-you" }]]);
    expect(diagnostics).toMatchObject([{ code: "chat-file-unreadable", path: join(chatFolder(root, "ALPHA", "1", 2), "chat.json") }]);
  });

  it("gives no state, and the finding, for a latest chat whose log does not open", async () => {
    const root = await projectsRoot("ALPHA");
    await plantTask(root, "ALPHA-1");
    await plantChat(root, at("ALPHA-1", 1), {}, [USER]);
    await chmod(logFile(root, "ALPHA", "1", 1), 0o000);
    onTestFinished(() => chmod(logFile(root, "ALPHA", "1", 1), 0o600));
    const { server } = await world(root);

    const { data, diagnostics } = await page(server);

    expect(data.items).toHaveLength(1);
    expect(data.items[0]!.status).toBeUndefined();
    expect(diagnostics).toMatchObject([{ code: "chat-file-unreadable" }]);
  });

  it("leaves out a chat whose task has no entry, with no finding", async () => {
    const root = await threeTasks();
    await plantChat(root, at("ALPHA-9", 1));
    const { server } = await world(root);

    const { data, diagnostics } = await page(server);

    expect(data.total).toBe(3);
    expect(diagnostics).toEqual([]);
  });

  it.each([
    ["whose index does not open", async (root: string) => {
      await chmod(tasksDir(root, "BETA"), 0o000);
      onTestFinished(() => chmod(tasksDir(root, "BETA"), 0o700));
    }],
    ["whose configuration cannot be read", (root: string) => plant(projectConfig(root, "BETA"), "path: [")],
    ["whose chats directory is a file", async (root: string) => {
      await rm(join(projectDir(root, "BETA"), "chats"), { recursive: true });
      await writeFile(join(projectDir(root, "BETA"), "chats"), "no directory");
    }],
  ])("leaves out a project %s with project-unreadable, and lists the others", async (_name, build) => {
    const root = await threeTasks();
    await build(root);
    const { server } = await world(root);

    const { data, diagnostics } = await page(server);

    expect(places(data.items)).toEqual(["ALPHA-2/1", "ALPHA-1/1"]);
    expect(diagnostics).toEqual([{ code: "project-unreadable", message: expect.any(String) as string, path: projectDir(root, "BETA") }]);
  });

  it("answers an empty page with project-unreadable when project names a project it leaves out", async () => {
    const root = await threeTasks();
    await rm(join(projectDir(root, "BETA"), "chats"), { recursive: true });
    await writeFile(join(projectDir(root, "BETA"), "chats"), "no directory");
    const { server } = await world(root);

    const { data, diagnostics } = await page(server, "?project=BETA");

    expect(data).toEqual({ items: [], total: 0 });
    expect(diagnostics).toMatchObject([{ code: "project-unreadable", path: projectDir(root, "BETA") }]);
  });

  it.each(["project-not-found", "index-closed"] as const)(
    "leaves out a project whose index open answers %s, with no finding of it or of its chats",
    async (code) => {
      const root = await threeTasks();
      await plant(join(chatFolder(root, "ALPHA", "1", 2), "chat.json"), "{");
      const gone = async (): Promise<never> => {
        throw new TaskStoreError(code, "this project went away");
      };
      const { server } = await world(root, () => gone);

      await expect(page(server)).resolves.toEqual({ data: { items: [], total: 0 }, diagnostics: [] });
    },
  );

  it("opens no index for a project with no chats", async () => {
    const root = await threeTasks();
    await plantTask(root, "GAMMA-1");
    const opened: string[] = [];
    const { server } = await world(root, (host) => (tag) => {
      opened.push(tag);
      return host.open(tag);
    });

    const { data } = await page(server);

    expect(data.total).toBe(3);
    expect(opened.toSorted()).toEqual(["ALPHA", "BETA"]);
  });

  it("opens the index of a project with chats, so an edit of one of its tasks reaches the feed", async () => {
    const root = await threeTasks();
    const { server, events } = await world(root);

    await page(server);

    await until(
      () => events.some((event) => event.kind === "task" && event.tag === "BETA" && event.id === "BETA-1"),
      "a task event of BETA-1",
      () => plantTask(root, "BETA-1", `Parse the board ${Date.now()}`),
    );
  });
});

describe("GET /chats/{id}/{chat}", () => {
  /** ALPHA-1 with chat 1 ended and chat 2 running. */
  async function twoChats(): Promise<World> {
    const root = await projectsRoot("ALPHA");
    await plantTask(root, "ALPHA-1", "Parse the tree");
    await plantChat(root, at("ALPHA-1", 1), { created: "2026-01-01T00:01:00Z" }, [USER, TURN_END]);
    await plantChat(root, at("ALPHA-1", 2), { created: "2026-01-01T00:02:00Z" }, [USER]);
    return world(root);
  }

  it.each([1, 2])("gives chat %d as the list gives it", async (chat) => {
    const { server } = await twoChats();
    const listed = (await page(server)).data.items.find((one) => one.chat === chat);

    const { data, diagnostics } = await item(server, `/chats/ALPHA-1/${chat}`);

    expect(data).toEqual(listed);
    expect(data.status === undefined).toBe(chat === 1);
    expect(diagnostics).toEqual([]);
  });

  it("gives no state to the latest chat of a task in a final status", async () => {
    const root = await projectsRoot("ALPHA");
    await plantTask(root, "ALPHA-1", "Planted", "Done");
    await plantChat(root, at("ALPHA-1", 1), {}, [USER]);
    const { server } = await world(root);

    const { data } = await item(server, "/chats/ALPHA-1/1");

    expect(data.status).toBeUndefined();
  });

  it("takes the chat before a broken latest chat as the latest, and reports the broken one", async () => {
    const root = await projectsRoot("ALPHA");
    await plantTask(root, "ALPHA-1");
    await plantChat(root, at("ALPHA-1", 1), {}, [USER]);
    await plant(join(chatFolder(root, "ALPHA", "1", 2), "chat.json"), "{");
    const { server } = await world(root);

    const { data, diagnostics } = await item(server, "/chats/ALPHA-1/1");

    expect(data.status).toEqual({ state: "needs-you" });
    expect(diagnostics).toMatchObject([{ code: "chat-file-unreadable" }]);
  });

  it.each([
    ["an unknown project", "/chats/GAMMA-1/1", 404, "project-not-found"],
    ["a task the index does not hold", "/chats/ALPHA-9/1", 404, "task-not-found"],
    ["an id with no dash", "/chats/ALPHA/1", 404, "task-not-found"],
    ["a chat that does not exist", "/chats/ALPHA-1/5", 404, "chat-not-found"],
    ["a query", "/chats/ALPHA-1/1?full=true", 400, "malformed-request"],
  ])("refuses %s", async (_name, path, status, code) => {
    const { server } = await twoChats();

    const response = await get(server, path);

    expect(response.status).toBe(status);
    expect(await failure(response)).toMatchObject({ code });
  });

  it.each([
    ["of 0", "0"],
    ["with a leading zero", "01"],
    ["that is a word", "last"],
  ])("refuses a chat number %s with chat-not-found, as the chat routes of one task do", async (_name, chat) => {
    const { server } = await twoChats();

    const response = await get(server, `/chats/ALPHA-1/${chat}`);

    expect(response.status).toBe(404);
    expect(await failure(response)).toEqual({ kind: "store", code: "chat-not-found", message: "this is not a chat number" });
  });

  it.each([
    ["a broken record", (chat: string) => plant(join(chat, "chat.json"), "{")],
    ["no event log", (chat: string) => rm(join(chat, "events.jsonl"))],
    ["an event log with a second name", (chat: string) => link(join(chat, "events.jsonl"), join(chat, "copy.jsonl"))],
  ])("refuses a chat with %s, which the list leaves out, with chat-unreadable", async (_name, build) => {
    const root = await projectsRoot("ALPHA");
    await plantTask(root, "ALPHA-1");
    await plantChat(root, at("ALPHA-1", 1));
    await build(chatFolder(root, "ALPHA", "1", 1));
    const { server } = await world(root);

    const response = await get(server, "/chats/ALPHA-1/1");

    expect(response.status).toBe(422);
    expect(await failure(response)).toMatchObject({ code: "chat-unreadable" });
    expect((await page(server)).data.items).toEqual([]);
  });
});
