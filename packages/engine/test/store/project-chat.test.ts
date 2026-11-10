import { chmod, link, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  type ChatChange,
  createChat,
  createProjectChat,
  listAllTaskChats,
  listChats,
  listProjectChats,
  type ProjectChatInput,
  projectChatPath,
  projectChatRecordPath,
  readListedProjectChat,
  readProjectChat,
  removeProject,
  updateProjectChat,
} from "@tasma/engine";
import {
  CHAT_INPUT,
  chatsDir,
  plant,
  project,
  PROJECT,
  PROJECT_CHAT_INPUT,
  projectChatDir,
  projectChatsDir,
  projectDir,
  read,
  storeError,
  storeFault,
  tempRoot,
} from "./helpers.js";

function options(root: string) {
  return { project: PROJECT, root };
}

/** A tree holding one project with task `SAGA-1`. */
async function withTask(): Promise<string> {
  const root = await tempRoot();
  await project(root).createTask({ title: "First" });
  return root;
}

/** The record file of one project chat. */
function recordFile(root: string, chat: number): string {
  return join(projectChatDir(root, chat), "chat.json");
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("createProjectChat", () => {
  it("numbers the chats 1 and 2 under chats/project/, each with an empty event log", async () => {
    const root = await tempRoot();

    const first = await createProjectChat(options(root), PROJECT_CHAT_INPUT);
    const second = await createProjectChat(options(root), PROJECT_CHAT_INPUT);

    expect([first.chat, second.chat]).toEqual([1, 2]);
    expect(first).toEqual({ chat: 1, ...PROJECT_CHAT_INPUT, created: expect.any(String) as string });
    await expect(readdir(projectChatsDir(root))).resolves.toEqual(expect.arrayContaining(["1", "2"]));
    for (const chat of [1, 2]) {
      await expect(read(join(projectChatDir(root, chat), "events.jsonl"))).resolves.toBe("");
    }
    expect(JSON.parse(await read(recordFile(root, 1)))).toEqual({ ...PROJECT_CHAT_INPUT, created: first.created });
  });

  it("gives two concurrent creates the numbers 1 and 2", async () => {
    const root = await tempRoot();

    const created = await Promise.all([
      createProjectChat(options(root), PROJECT_CHAT_INPUT),
      createProjectChat(options(root), PROJECT_CHAT_INPUT),
    ]);

    expect(created.map((record) => record.chat).toSorted()).toEqual([1, 2]);
  });

  it("creates in a project with no task, and counts apart from a task chat of the same number", async () => {
    const root = await tempRoot();

    await expect(createProjectChat(options(root), PROJECT_CHAT_INPUT)).resolves.toMatchObject({ chat: 1 });

    await project(root).createTask({ title: "First" });
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await expect(createProjectChat(options(root), PROJECT_CHAT_INPUT)).resolves.toMatchObject({ chat: 2 });
    await expect(createChat(options(root), "SAGA-1", CHAT_INPUT)).resolves.toMatchObject({ chat: 3 });
  });

  it("keeps the text of the title as it is given", async () => {
    const root = await tempRoot();
    const title = `  ${"Долгий план ".repeat(200)}`;

    await createProjectChat(options(root), { ...PROJECT_CHAT_INPUT, title });

    await expect(readProjectChat(options(root), 1)).resolves.toMatchObject({ title });
  });

  it("creates the files and the directories for their owner alone", async () => {
    const root = await tempRoot();

    await createProjectChat(options(root), PROJECT_CHAT_INPUT);

    expect(await mode(chatsDir(root))).toBe(0o700);
    expect(await mode(projectChatsDir(root))).toBe(0o700);
    expect(await mode(projectChatDir(root, 1))).toBe(0o700);
    expect(await mode(recordFile(root, 1))).toBe(0o600);
    expect(await mode(join(projectChatDir(root, 1), "events.jsonl"))).toBe(0o600);
  });

  it.each([
    ["no title", { agent: "claude", folder: "/srv/saga" }],
    ["an empty title", { ...PROJECT_CHAT_INPUT, title: "" }],
    ["a title that is no text", { ...PROJECT_CHAT_INPUT, title: 7 }],
    ["an empty folder", { ...PROJECT_CHAT_INPUT, folder: "" }],
    ["an agent it does not know", { ...PROJECT_CHAT_INPUT, agent: "other" }],
  ])("refuses %s and writes nothing", async (_name, input) => {
    const root = await tempRoot();

    const refusal = await storeError(createProjectChat(options(root), input as unknown as ProjectChatInput));

    expect(refusal.code).toBe("field-required");
    await expect(readdir(projectDir(root))).resolves.not.toContain("chats");
  });

  it("refuses a project that does not exist", async () => {
    const root = await tempRoot();

    expect((await storeError(createProjectChat({ project: "OTHER", root }, PROJECT_CHAT_INPUT))).code).toBe("project-not-found");
  });
});

describe("readProjectChat, listProjectChats and updateProjectChat", () => {
  it("give the record that the create wrote", async () => {
    const root = await tempRoot();
    const created = await createProjectChat(options(root), PROJECT_CHAT_INPUT);
    await createProjectChat(options(root), { ...PROJECT_CHAT_INPUT, title: "Sort the inbox" });

    const listed = await listProjectChats(options(root));

    await expect(readProjectChat(options(root), 1)).resolves.toEqual(created);
    expect(listed.chats[0]).toEqual(created);
    expect(listed.chats.map((record) => record.title)).toEqual([PROJECT_CHAT_INPUT.title, "Sort the inbox"]);
    expect(listed.diagnostics).toEqual([]);
    await expect(readListedProjectChat(options(root), 2)).resolves.toEqual(listed.chats[1]);
  });

  it("list in chat number order", async () => {
    const root = await tempRoot();
    for (let count = 0; count < 10; count += 1) await createProjectChat(options(root), PROJECT_CHAT_INPUT);

    const listed = await listProjectChats(options(root));

    expect(listed.chats.map((record) => record.chat)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("update the session, the options and seen, and keep every key the update does not know", async () => {
    const root = await tempRoot();
    const created = await createProjectChat(options(root), PROJECT_CHAT_INPUT);
    const stored = JSON.parse(await read(recordFile(root, 1))) as Record<string, unknown>;
    await writeFile(recordFile(root, 1), JSON.stringify({ ...stored, later: { kept: true } }));

    await updateProjectChat(options(root), 1, { session: "a session" });
    await updateProjectChat(options(root), 1, { options: { mode: "auto", depth: 3 } as unknown as Record<string, string> });
    const updated = await updateProjectChat(options(root), 1, { seen: 4 });

    const expected = { ...created, session: "a session", options: { mode: "auto" }, seen: 4 };
    expect(updated).toEqual(expected);
    await expect(readProjectChat(options(root), 1)).resolves.toEqual(expected);
    expect((await listProjectChats(options(root))).chats).toEqual([expected]);
    expect(JSON.parse(await read(recordFile(root, 1)))).toEqual({
      ...stored,
      later: { kept: true },
      session: "a session",
      options: { mode: "auto" },
      seen: 4,
    });
  });

  it("update inactive, and keep it when another field changes", async () => {
    const root = await tempRoot();
    const created = await createProjectChat(options(root), PROJECT_CHAT_INPUT);

    await updateProjectChat(options(root), 1, { inactive: 3 });
    const updated = await updateProjectChat(options(root), 1, { seen: 2 });

    const expected = { ...created, seen: 2, inactive: 3 };
    expect(updated).toEqual(expected);
    await expect(readProjectChat(options(root), 1)).resolves.toEqual(expected);
    expect((await listProjectChats(options(root))).chats).toEqual([expected]);
  });

  it.each([
    ["an empty session", { session: "" }],
    ["options that are a list", { options: ["auto"] }],
    ["a negative seen", { seen: -1 }],
    ["a negative inactive", { inactive: -1 }],
  ])("refuse an update with %s and write nothing", async (_name, change) => {
    const root = await tempRoot();
    await createProjectChat(options(root), PROJECT_CHAT_INPUT);
    const before = await read(recordFile(root, 1));

    expect((await storeError(updateProjectChat(options(root), 1, change as unknown as ChatChange))).code).toBe("field-required");
    await expect(read(recordFile(root, 1))).resolves.toBe(before);
  });

  it("refuse a chat that does not exist", async () => {
    const root = await tempRoot();

    expect((await storeError(readProjectChat(options(root), 1))).code).toBe("chat-not-found");
    expect((await storeError(readListedProjectChat(options(root), 1))).code).toBe("chat-not-found");
    expect((await storeError(updateProjectChat(options(root), 1, { session: "a" }))).code).toBe("chat-not-found");
  });

  it.each([0, -1, 1.5])("refuse %s as no chat number", async (chat) => {
    const root = await tempRoot();
    await createProjectChat(options(root), PROJECT_CHAT_INPUT);

    expect((await storeError(readProjectChat(options(root), chat))).code).toBe("chat-not-found");
  });
});

describe("a project chat record with a bad title", () => {
  it.each([
    ["no title", (stored: Record<string, unknown>) => ({ ...stored, title: undefined })],
    ["an empty title", (stored: Record<string, unknown>) => ({ ...stored, title: "" })],
    ["a title that is no text", (stored: Record<string, unknown>) => ({ ...stored, title: ["a"] })],
  ])("with %s is refused by a read and an update, and is a finding in a list beside the other chats", async (_name, broken) => {
    const root = await tempRoot();
    await createProjectChat(options(root), PROJECT_CHAT_INPUT);
    await createProjectChat(options(root), PROJECT_CHAT_INPUT);
    const stored = JSON.parse(await read(recordFile(root, 1))) as Record<string, unknown>;
    await writeFile(recordFile(root, 1), JSON.stringify(broken(stored)));

    expect(await storeError(readProjectChat(options(root), 1))).toMatchObject({
      code: "chat-unreadable",
      path: recordFile(root, 1),
    });
    expect((await storeError(updateProjectChat(options(root), 1, { seen: 1 }))).code).toBe("chat-unreadable");
    const listed = await listProjectChats(options(root));
    expect(listed.chats.map((record) => record.chat)).toEqual([2]);
    expect(listed.diagnostics).toEqual([
      { code: "chat-file-unreadable", message: '"title" must be a non-empty string', path: recordFile(root, 1) },
    ]);
  });

  it("holding a step and no title is refused, because a task chat record is no project chat record", async () => {
    const root = await tempRoot();
    await plant(recordFile(root, 1), JSON.stringify({ ...CHAT_INPUT, created: "2026-01-01T00:00:00+03:00" }));
    await plant(join(projectChatDir(root, 1), "events.jsonl"), "");

    expect((await storeError(readProjectChat(options(root), 1))).code).toBe("chat-unreadable");
  });
});

describe("readListedProjectChat", () => {
  it.each([
    ["no event log", "chat-unreadable", (chat: string) => rm(join(chat, "events.jsonl"))],
    ["an event log with a second name", "chat-unreadable", (chat: string) => link(join(chat, "events.jsonl"), join(chat, "copy.jsonl"))],
    ["a broken record", "chat-unreadable", (chat: string) => writeFile(join(chat, "chat.json"), "{")],
    ["no record", "chat-not-found", (chat: string) => rm(join(chat, "chat.json"))],
  ])("refuses a chat with %s as the finding of listProjectChats states it", async (_name, code, build) => {
    const root = await tempRoot();
    await createProjectChat(options(root), PROJECT_CHAT_INPUT);
    await build(projectChatDir(root, 1));

    const refusal = await storeError(readListedProjectChat(options(root), 1));

    const [finding] = (await listProjectChats(options(root))).diagnostics;
    expect(refusal).toMatchObject({ code, description: finding!.message, path: finding!.path });
  });
});

describe("listProjectChats", () => {
  it("lists nothing and reports nothing for a project with no chats/project/", async () => {
    const root = await withTask();

    await expect(listProjectChats(options(root))).resolves.toEqual({ chats: [], diagnostics: [] });
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await expect(listProjectChats(options(root))).resolves.toEqual({ chats: [], diagnostics: [] });
  });

  it("passes over a name that is no chat number", async () => {
    const root = await tempRoot();
    await createProjectChat(options(root), PROJECT_CHAT_INPUT);
    await mkdir(join(projectChatsDir(root), "01"));
    await mkdir(join(projectChatsDir(root), "9".repeat(20)));
    await plant(join(projectChatsDir(root), "notes.txt"), "not a chat");

    const listed = await listProjectChats(options(root));

    expect(listed.chats.map((record) => record.chat)).toEqual([1]);
    expect(listed.diagnostics).toEqual([]);
  });

  it("gives no task chat", async () => {
    const root = await withTask();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await createProjectChat(options(root), PROJECT_CHAT_INPUT);

    const listed = await listProjectChats(options(root));

    expect(listed.chats).toEqual([expect.objectContaining({ chat: 1, title: PROJECT_CHAT_INPUT.title })]);
    expect(listed.chats[0]).not.toHaveProperty("task");
  });

  it("lists chats/project/ the filesystem refuses to read as an empty list and a finding", async () => {
    const root = await tempRoot();
    await createProjectChat(options(root), PROJECT_CHAT_INPUT);
    await chmod(projectChatsDir(root), 0o000);
    onTestFinished(() => chmod(projectChatsDir(root), 0o700));

    await expect(listProjectChats(options(root))).resolves.toEqual({
      chats: [],
      diagnostics: [
        {
          code: "chat-file-unreadable",
          message: expect.stringMatching(/^the project chats of this project cannot be read: .*EACCES/) as string,
          path: projectChatsDir(root),
        },
      ],
    });
  });

  it.each([
    ["a file", (root: string) => plant(chatsDir(root), "no directory")],
    ["a symbolic link", async (root: string) => {
      await mkdir(join(root, "outside", "project"), { recursive: true });
      await symlink(join(root, "outside"), chatsDir(root));
    }],
  ])("refuses a chats/ that is %s", async (_name, build) => {
    const root = await tempRoot();
    await build(root);

    expect((await storeError(listProjectChats(options(root)))).code).toBe("project-invalid");
  });

  it("refuses a project that does not exist", async () => {
    const root = await tempRoot();

    expect((await storeError(listProjectChats({ project: "OTHER", root }))).code).toBe("project-not-found");
  });
});

describe("a symbolic link or a file in the place of chats/project", () => {
  it.each([
    ["a symbolic link", (root: string) => symlink(join(root, "outside"), projectChatsDir(root))],
    ["a file", (root: string) => plant(projectChatsDir(root), "no directory")],
  ])("that is %s refuses a create, a read and an update, is a finding in a list, and nothing outside changes", async (_name, build) => {
    const root = await tempRoot();
    await plant(join(root, "outside", "1", "chat.json"), JSON.stringify({ ...PROJECT_CHAT_INPUT, created: "2026-01-01T00:00:00+03:00" }));
    await plant(join(root, "outside", "1", "events.jsonl"), "");
    await mkdir(chatsDir(root));
    await build(root);

    expect((await storeError(createProjectChat(options(root), PROJECT_CHAT_INPUT))).code).toBe("project-invalid");
    expect((await storeError(readProjectChat(options(root), 1))).code).toBe("project-invalid");
    expect((await storeError(readListedProjectChat(options(root), 1))).code).toBe("project-invalid");
    expect((await storeError(updateProjectChat(options(root), 1, { seen: 1 }))).code).toBe("project-invalid");
    await expect(listProjectChats(options(root))).resolves.toEqual({
      chats: [],
      diagnostics: [
        {
          code: "chat-file-unreadable",
          message: "the name of the project chats of this project holds no directory",
          path: projectChatsDir(root),
        },
      ],
    });
    await expect(readdir(join(root, "outside"))).resolves.toEqual(["1"]);
    await expect(readdir(join(root, "outside", "1"))).resolves.toEqual(["chat.json", "events.jsonl"]);
  });

  it("names the project chats in the refusal", async () => {
    const root = await tempRoot();
    await plant(projectChatsDir(root), "no directory");

    expect(await storeError(readProjectChat(options(root), 1))).toMatchObject({
      code: "project-invalid",
      description: "the project chats directory of this project is not a directory",
      path: projectChatsDir(root),
    });
  });
});

describe("projectChatPath and projectChatRecordPath", () => {
  it("name the directory and the record file of one project chat", async () => {
    const root = await tempRoot();

    expect(projectChatPath(options(root), 2)).toBe(projectChatDir(root, 2));
    expect(projectChatRecordPath(options(root), 2)).toBe(recordFile(root, 2));
  });

  it("read no disk, so they name a chat of a project that does not exist", () => {
    expect(projectChatPath({ project: "OTHER", root: "/tmp/tree" }, 1)).toBe("/tmp/tree/projects/OTHER/chats/project/1");
  });

  it.each([0, -1, 1.5])("refuse %s as no chat number", (chat) => {
    expect(storeFault(() => projectChatPath(options("/tmp/tree"), chat)).code).toBe("chat-not-found");
    expect(storeFault(() => projectChatRecordPath(options("/tmp/tree"), chat)).code).toBe("chat-not-found");
  });
});

describe("the project chats beside the chats of the tasks", () => {
  it("stay when a task is deleted", async () => {
    const root = await withTask();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await createProjectChat(options(root), PROJECT_CHAT_INPUT);

    await project(root).deleteTask("SAGA-1");

    await expect(readdir(chatsDir(root))).resolves.toEqual(["project"]);
    expect((await listProjectChats(options(root))).chats).toHaveLength(1);
  });

  it("go with a removed project", async () => {
    const root = await tempRoot();
    await createProjectChat(options(root), PROJECT_CHAT_INPUT);

    await removeProject(options(root));

    await expect(readdir(join(root, "projects"))).resolves.toEqual([]);
  });

  it("are not shown by listChats and listAllTaskChats, which give no finding for them", async () => {
    const root = await withTask();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await createProjectChat(options(root), PROJECT_CHAT_INPUT);
    await createProjectChat(options(root), PROJECT_CHAT_INPUT);

    const all = await listAllTaskChats(options(root));

    expect(all.chats).toEqual([expect.objectContaining({ task: "SAGA-1", chat: 1 })]);
    expect(all.diagnostics).toEqual([]);
    await expect(listChats(options(root), "SAGA-1")).resolves.toEqual({
      chats: [expect.objectContaining({ task: "SAGA-1", chat: 1 })],
      diagnostics: [],
    });
  });
});
