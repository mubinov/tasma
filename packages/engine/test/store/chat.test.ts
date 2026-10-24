import { chmod, link, mkdir, open as openFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  type ChatInput,
  chatPath,
  type ChatRecord,
  createChat,
  listChats,
  listProjectChats,
  readChat,
  readListedChat,
  removeProject,
  updateChat,
} from "@tasma/engine";
import { claimChat } from "../../src/store/chat.js";
import {
  CHAT_INPUT,
  chatDir,
  chatsDir,
  codes,
  plant,
  project,
  PROJECT,
  projectDir,
  read,
  storeError,
  tasksDir,
  taskFile,
  taskText,
  tempRoot,
} from "./helpers.js";

/** A tree holding one project with `count` tasks, `SAGA-1` and up. */
async function withTasks(count = 1): Promise<string> {
  const root = await tempRoot();
  for (let number = 1; number <= count; number += 1) await project(root).createTask({ title: `Task ${number}` });
  return root;
}

function options(root: string) {
  return { project: PROJECT, root };
}

/** The permission bits of one path. */
async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("createChat", () => {
  it("numbers the chats of a task 1, 2, 3, and starts another task at 1", async () => {
    const root = await withTasks(2);

    const first = await createChat(options(root), "SAGA-1", CHAT_INPUT);
    const second = await createChat(options(root), "SAGA-1", CHAT_INPUT);
    const third = await createChat(options(root), "SAGA-1", CHAT_INPUT);
    const other = await createChat(options(root), "SAGA-2", CHAT_INPUT);

    expect([first.chat, second.chat, third.chat, other.chat]).toEqual([1, 2, 3, 1]);
    expect(other.task).toBe("SAGA-2");
  });

  it("answers the record it wrote, and writes an empty event log beside it", async () => {
    const root = await withTasks();

    const record = await createChat(options(root), "SAGA-1", CHAT_INPUT);

    expect(record).toEqual({ task: "SAGA-1", chat: 1, ...CHAT_INPUT, created: expect.any(String) as string });
    const directory = chatDir(root, "1", 1);
    expect(JSON.parse(await read(join(directory, "chat.json")))).toEqual({ ...CHAT_INPUT, created: record.created });
    await expect(read(join(directory, "chat.json"))).resolves.toMatch(/^\{\n {2}"step": "build",\n[^]*\}\n$/);
    await expect(read(join(directory, "events.jsonl"))).resolves.toBe("");
  });

  it("keeps the chats of SAGA-007 and SAGA-7 apart", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-7"), taskText("SAGA-7"));
    await plant(taskFile(root, "SAGA-007"), taskText("SAGA-007"));

    await createChat(options(root), "SAGA-7", CHAT_INPUT);
    const padded = await createChat(options(root), "SAGA-007", CHAT_INPUT);

    expect(padded.chat).toBe(1);
    await expect(readdir(chatsDir(root))).resolves.toEqual(expect.arrayContaining(["7", "007"]));
  });

  it("creates the files and the directories for their owner alone", async () => {
    const root = await withTasks();

    await createChat(options(root), "SAGA-1", CHAT_INPUT);

    expect(await mode(chatsDir(root))).toBe(0o700);
    expect(await mode(join(chatsDir(root), "1"))).toBe(0o700);
    expect(await mode(chatDir(root, "1", 1))).toBe(0o700);
    expect(await mode(join(chatDir(root, "1", 1), "chat.json"))).toBe(0o600);
    expect(await mode(join(chatDir(root, "1", 1), "events.jsonl"))).toBe(0o600);
  });

  it("takes the number after a directory an interrupted create left, and counts no other name", async () => {
    const root = await withTasks();
    await mkdir(chatDir(root, "1", 4), { recursive: true });
    await plant(join(chatsDir(root), "1", "notes.txt"), "not a chat");
    await mkdir(join(chatsDir(root), "1", "9".repeat(20)));

    await expect(createChat(options(root), "SAGA-1", CHAT_INPUT)).resolves.toMatchObject({ chat: 5 });
  });

  it.each([
    ["a task that does not exist", "SAGA-2"],
    ["an id of another project", "OTHER-1"],
  ])("refuses %s", async (_name, task) => {
    const root = await withTasks();

    expect((await storeError(createChat(options(root), task, CHAT_INPUT))).code).toBe("task-not-found");
  });

  it.each([
    ["a directory", (root: string) => mkdir(taskFile(root, "SAGA-1"), { recursive: true })],
    ["a symbolic link", async (root: string) => {
      await plant(join(root, "outside.md"), taskText("SAGA-1"));
      await mkdir(tasksDir(root));
      await symlink(join(root, "outside.md"), taskFile(root, "SAGA-1"));
    }],
  ])("refuses a task whose name holds %s, and creates nothing", async (_name, build) => {
    const root = await tempRoot();
    await build(root);

    expect((await storeError(createChat(options(root), "SAGA-1", CHAT_INPUT))).code).toBe("task-not-found");
    await expect(readdir(projectDir(root))).resolves.not.toContain("chats");
  });

  it.each([
    ["an empty step", { ...CHAT_INPUT, step: "" }],
    ["an empty folder", { ...CHAT_INPUT, folder: "" }],
    ["an agent it does not know", { ...CHAT_INPUT, agent: "other" as ChatInput["agent"] }],
  ])("refuses %s and creates nothing", async (_name, input) => {
    const root = await withTasks();

    expect((await storeError(createChat(options(root), "SAGA-1", input))).code).toBe("field-required");
    await expect(readdir(projectDir(root))).resolves.not.toContain("chats");
  });
});

describe("claimChat", () => {
  it("reads again once when another writer took the number", async () => {
    const root = await tempRoot();
    const taskChats = join(root, "chats");
    await mkdir(join(taskChats, "1"), { recursive: true });
    const stale = [0];

    const chat = await claimChat(taskChats, async () => stale.shift() ?? 1);

    expect(chat).toBe(2);
  });

  it("passes a second collision on", async () => {
    const root = await tempRoot();
    const taskChats = join(root, "chats");
    await mkdir(join(taskChats, "1"), { recursive: true });

    await expect(claimChat(taskChats, async () => 0)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("passes on a fault that is no name taken", async () => {
    const root = await tempRoot();

    await expect(claimChat(join(root, "missing"), async () => 0)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("readChat and listChats", () => {
  it("read back what the create wrote, in chat number order", async () => {
    const root = await withTasks();
    for (let count = 0; count < 10; count += 1) await createChat(options(root), "SAGA-1", CHAT_INPUT);

    const listed = await listChats(options(root), "SAGA-1");

    expect(listed.chats.map((record) => record.chat)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(listed.diagnostics).toEqual([]);
    await expect(readChat(options(root), "SAGA-1", 10)).resolves.toEqual(listed.chats[9]);
  });

  it("list nothing for a task with no chats", async () => {
    const root = await withTasks();

    await expect(listChats(options(root), "SAGA-1")).resolves.toEqual({ chats: [], diagnostics: [] });
  });

  it("pass over a name that is no chat number", async () => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await mkdir(join(chatsDir(root), "1", "01"));
    await mkdir(join(chatsDir(root), "1", "9".repeat(20)));
    await plant(join(chatsDir(root), "1", "notes.txt"), "not a chat");

    const listed = await listChats(options(root), "SAGA-1");

    expect(listed.chats.map((record) => record.chat)).toEqual([1]);
    expect(listed.diagnostics).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 53])("refuse %s as no chat number", async (chat) => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);

    expect((await storeError(readChat(options(root), "SAGA-1", chat))).code).toBe("chat-not-found");
  });

  it("refuse a chat that does not exist", async () => {
    const root = await withTasks();

    expect((await storeError(readChat(options(root), "SAGA-1", 1))).code).toBe("chat-not-found");
  });

  it("refuse a directory with no record, and list it as a finding", async () => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await mkdir(chatDir(root, "1", 2));

    expect((await storeError(readChat(options(root), "SAGA-1", 2))).code).toBe("chat-not-found");
    const listed = await listChats(options(root), "SAGA-1");
    expect(listed.chats.map((record) => record.chat)).toEqual([1]);
    expect(listed.diagnostics).toEqual([
      { code: "chat-file-unreadable", message: expect.any(String) as string, path: join(chatDir(root, "1", 2), "chat.json") },
    ]);
    await expect(createChat(options(root), "SAGA-1", CHAT_INPUT)).resolves.toMatchObject({ chat: 3 });
  });

  it.each([
    ["not JSON", "{"],
    ["not a JSON object", "[]"],
    ["missing its step", JSON.stringify({ agent: "claude", folder: "/srv", created: "2026-01-01T00:00:00+03:00" })],
    ["holding an agent it does not know", JSON.stringify({ ...CHAT_INPUT, agent: "other", created: "2026-01-01T00:00:00+03:00" })],
    ["holding an empty folder", JSON.stringify({ ...CHAT_INPUT, folder: "", created: "2026-01-01T00:00:00+03:00" })],
    ["holding no timestamp", JSON.stringify({ ...CHAT_INPUT, created: "yesterday" })],
    ["holding a session that is no text", JSON.stringify({ ...CHAT_INPUT, created: "2026-01-01T00:00:00+03:00", session: 7 })],
  ])("refuse a record %s, and list it as a finding", async (_name, text) => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    const record = join(chatDir(root, "1", 1), "chat.json");
    await writeFile(record, text);

    const refusal = await storeError(readChat(options(root), "SAGA-1", 1));

    expect(refusal).toMatchObject({ code: "chat-unreadable", path: record });
    const listed = await listChats(options(root), "SAGA-1");
    expect(listed.chats).toEqual([]);
    expect(codes(listed.diagnostics)).toEqual(["chat-file-unreadable"]);
  });

  it("refuse a record that is a symbolic link, and read nothing it points at", async () => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    const record = join(chatDir(root, "1", 1), "chat.json");
    await plant(join(root, "outside.json"), await read(record));
    await rm(record);
    await symlink(join(root, "outside.json"), record);

    expect((await storeError(readChat(options(root), "SAGA-1", 1))).code).toBe("chat-unreadable");
  });

  it.each([
    ["a symbolic link", async (root: string) => symlink(join(root, "outside"), chatDir(root, "1", 1))],
    ["a file", async (root: string) => plant(chatDir(root, "1", 1), "no directory")],
  ])("refuse a chat whose name holds %s, and list it as a finding", async (_name, build) => {
    const root = await withTasks();
    await mkdir(join(root, "outside"));
    await mkdir(join(chatsDir(root), "1"), { recursive: true });
    await build(root);

    expect((await storeError(readChat(options(root), "SAGA-1", 1))).code).toBe("chat-unreadable");
    expect(codes((await listChats(options(root), "SAGA-1")).diagnostics)).toEqual(["chat-file-unreadable"]);
  });

  it("list a record with no event log as a finding", async () => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await rm(join(chatDir(root, "1", 1), "events.jsonl"));

    const listed = await listChats(options(root), "SAGA-1");

    expect(listed.chats).toEqual([]);
    expect(listed.diagnostics).toEqual([
      {
        code: "chat-file-unreadable",
        message: expect.any(String) as string,
        path: join(chatDir(root, "1", 1), "events.jsonl"),
      },
    ]);
  });

  it("list a chat whose event log has a second name as a finding", async () => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await link(join(chatDir(root, "1", 1), "events.jsonl"), join(root, "outside.jsonl"));

    const listed = await listChats(options(root), "SAGA-1");

    expect(listed.chats).toEqual([]);
    expect(listed.diagnostics).toEqual([
      {
        code: "chat-file-unreadable",
        message: expect.any(String) as string,
        path: join(chatDir(root, "1", 1), "events.jsonl"),
      },
    ]);
  });

  it("list a chat the filesystem refuses to read as a finding, and the other chats", async () => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await chmod(chatDir(root, "1", 2), 0o000);
    onTestFinished(() => chmod(chatDir(root, "1", 2), 0o700));

    const listed = await listChats(options(root), "SAGA-1");

    expect(listed.chats.map((record) => record.chat)).toEqual([1]);
    expect(listed.diagnostics).toEqual([
      {
        code: "chat-file-unreadable",
        message: expect.stringMatching(/^this chat cannot be read: .*EACCES/) as string,
        path: join(chatDir(root, "1", 2), "chat.json"),
      },
    ]);
  });

  it("name the chat directory in the finding for a fault that names no path", async () => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    const probe = await openFile(join(chatDir(root, "1", 1), "chat.json"));
    const handles = Object.getPrototypeOf(probe) as { readFile: () => Promise<string> };
    await probe.close();
    const fault = Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    const readFile = vi.spyOn(handles, "readFile").mockRejectedValue(fault);
    onTestFinished(() => readFile.mockRestore());

    const listed = await listChats(options(root), "SAGA-1");

    expect(listed).toEqual({
      chats: [],
      diagnostics: [
        { code: "chat-file-unreadable", message: "this chat cannot be read: EIO: i/o error, read", path: chatDir(root, "1", 1) },
      ],
    });
  });

  it("refuse a task that does not exist", async () => {
    const root = await withTasks();

    expect((await storeError(listChats(options(root), "SAGA-2"))).code).toBe("task-not-found");
    expect((await storeError(readChat(options(root), "SAGA-2", 1))).code).toBe("task-not-found");
  });
});

describe("readListedChat", () => {
  it("reads the record that listChats lists", async () => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await createChat(options(root), "SAGA-1", CHAT_INPUT);

    const listed = await listChats(options(root), "SAGA-1");

    await expect(readListedChat(options(root), "SAGA-1", 2)).resolves.toEqual(listed.chats[1]);
  });

  it.each([
    ["no event log", "chat-unreadable", (chat: string) => rm(join(chat, "events.jsonl"))],
    ["an event log with a second name", "chat-unreadable", (chat: string) => link(join(chat, "events.jsonl"), join(chat, "copy.jsonl"))],
    ["an event log that is a directory", "chat-unreadable", async (chat: string) => {
      await rm(join(chat, "events.jsonl"));
      await mkdir(join(chat, "events.jsonl"));
    }],
    ["a broken record", "chat-unreadable", (chat: string) => writeFile(join(chat, "chat.json"), "{")],
    ["no record", "chat-not-found", (chat: string) => rm(join(chat, "chat.json"))],
  ])("refuses a chat with %s as the finding of listChats states it", async (_name, code, build) => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await build(chatDir(root, "1", 1));

    const refusal = await storeError(readListedChat(options(root), "SAGA-1", 1));

    const [finding] = (await listChats(options(root), "SAGA-1")).diagnostics;
    expect(refusal).toMatchObject({ code, description: finding!.message, path: finding!.path });
  });

  it.each([0, 3])("refuses chat %d, which the task does not hold", async (chat) => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);

    expect((await storeError(readListedChat(options(root), "SAGA-1", chat))).code).toBe("chat-not-found");
  });
});

describe("listProjectChats", () => {
  /** The records in one order, because the tasks of a project come in no fixed order. */
  function sorted(records: ChatRecord[]): ChatRecord[] {
    return records.toSorted((a, b) => (a.task === b.task ? a.chat - b.chat : a.task < b.task ? -1 : 1));
  }

  it("lists every chat of every task, each record as the list of its task gives it", async () => {
    const root = await withTasks(2);
    await plant(taskFile(root, "SAGA-007"), taskText("SAGA-007"));
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await createChat(options(root), "SAGA-1", { ...CHAT_INPUT, step: "review" });
    await createChat(options(root), "SAGA-2", CHAT_INPUT);
    await createChat(options(root), "SAGA-007", CHAT_INPUT);

    const listed = await listProjectChats(options(root));

    const expected = [];
    for (const task of ["SAGA-007", "SAGA-1", "SAGA-2"]) expected.push(...(await listChats(options(root), task)).chats);
    expect(sorted(listed.chats)).toEqual(expected);
    expect(listed.chats.map((record) => record.task).toSorted()).toEqual(["SAGA-007", "SAGA-1", "SAGA-1", "SAGA-2"]);
    expect(listed.diagnostics).toEqual([]);
  });

  it("lists the chats of a task whose file is gone", async () => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await rm(taskFile(root, "SAGA-1"));

    expect((await listProjectChats(options(root))).chats).toMatchObject([{ task: "SAGA-1", chat: 1 }]);
  });

  it("lists nothing for a project with no chats directory", async () => {
    const root = await withTasks();

    await expect(listProjectChats(options(root))).resolves.toEqual({ chats: [], diagnostics: [] });
  });

  it("passes over a name that is no task number or no chat number", async () => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await mkdir(join(chatsDir(root), "notes"));
    await mkdir(join(chatsDir(root), "1a"));
    await mkdir(join(chatsDir(root), "9".repeat(20)));
    await plant(join(chatsDir(root), "notes.txt"), "not a task");
    await mkdir(join(chatsDir(root), "1", "01"));
    await plant(join(chatsDir(root), "1", "notes.txt"), "not a chat");

    await expect(listProjectChats(options(root))).resolves.toEqual({
      chats: [expect.objectContaining({ task: "SAGA-1", chat: 1 })],
      diagnostics: [],
    });
  });

  it("lists a broken record and a record with no event log as findings, and the other chats", async () => {
    const root = await withTasks(2);
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await createChat(options(root), "SAGA-2", CHAT_INPUT);
    await writeFile(join(chatDir(root, "1", 2), "chat.json"), "{");
    await rm(join(chatDir(root, "2", 1), "events.jsonl"));

    const listed = await listProjectChats(options(root));

    expect(listed.chats).toMatchObject([{ task: "SAGA-1", chat: 1 }]);
    expect(listed.diagnostics.toSorted((a, b) => (a.path! < b.path! ? -1 : 1))).toEqual([
      { code: "chat-file-unreadable", message: expect.any(String) as string, path: join(chatDir(root, "1", 2), "chat.json") },
      { code: "chat-file-unreadable", message: expect.any(String) as string, path: join(chatDir(root, "2", 1), "events.jsonl") },
    ]);
  });

  it.each([
    ["the chats of a task", "a file", async (root: string) => plant(join(chatsDir(root), "2"), "no directory"), ["2"]],
    ["the chats of a task", "a symbolic link", async (root: string) => symlink(join(root, "outside"), join(chatsDir(root), "2")), ["2"]],
    ["one chat", "a file", async (root: string) => {
      await mkdir(join(chatsDir(root), "2"));
      await plant(chatDir(root, "2", 1), "no directory");
    }, ["2", "1"]],
    ["one chat", "a symbolic link", async (root: string) => {
      await mkdir(join(chatsDir(root), "2"));
      await symlink(join(root, "outside"), chatDir(root, "2", 1));
    }, ["2", "1"]],
  ])("lists %s whose name holds %s as a finding, and the other tasks", async (_what, _name, build, segments) => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await mkdir(join(root, "outside", "1"), { recursive: true });
    await build(root);

    const listed = await listProjectChats(options(root));

    expect(listed.chats).toMatchObject([{ task: "SAGA-1", chat: 1 }]);
    expect(listed.diagnostics).toEqual([
      { code: "chat-file-unreadable", message: expect.any(String) as string, path: join(chatsDir(root), ...segments) },
    ]);
  });

  it("lists the chats of a task the filesystem refuses to read as a finding, and the other tasks", async () => {
    const root = await withTasks(2);
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    await createChat(options(root), "SAGA-2", CHAT_INPUT);
    await chmod(join(chatsDir(root), "2"), 0o000);
    onTestFinished(() => chmod(join(chatsDir(root), "2"), 0o700));

    const listed = await listProjectChats(options(root));

    expect(listed.chats).toMatchObject([{ task: "SAGA-1", chat: 1 }]);
    expect(listed.diagnostics).toEqual([
      {
        code: "chat-file-unreadable",
        message: expect.stringMatching(/^the chats of this task cannot be read: .*EACCES/) as string,
        path: join(chatsDir(root), "2"),
      },
    ]);
  });

  it.each([
    ["a file", (root: string) => plant(chatsDir(root), "no directory")],
    ["a symbolic link", async (root: string) => {
      await mkdir(join(root, "outside"));
      await symlink(join(root, "outside"), chatsDir(root));
    }],
  ])("refuses a chats directory that is %s", async (_name, build) => {
    const root = await withTasks();
    await build(root);

    expect((await storeError(listProjectChats(options(root)))).code).toBe("project-invalid");
  });

  it("refuses a project that does not exist", async () => {
    const root = await withTasks();

    expect((await storeError(listProjectChats({ project: "OTHER", root }))).code).toBe("project-not-found");
  });
});

describe("chatPath", () => {
  it("names the directory of one chat by the digits of the task id as written", async () => {
    const root = await tempRoot();

    expect(chatPath(options(root), "SAGA-007", 2)).toBe(chatDir(root, "007", 2));
  });
});

describe("updateChat", () => {
  it("sets the session and answers the record", async () => {
    const root = await withTasks();
    const created = await createChat(options(root), "SAGA-1", CHAT_INPUT);

    const updated = await updateChat(options(root), "SAGA-1", 1, { session: "a session" });

    expect(updated).toEqual({ ...created, session: "a session" });
    await expect(readChat(options(root), "SAGA-1", 1)).resolves.toEqual(updated);
  });

  it("writes back every key it does not know", async () => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    const record = join(chatDir(root, "1", 1), "chat.json");
    const stored = JSON.parse(await read(record)) as Record<string, unknown>;
    await writeFile(record, JSON.stringify({ ...stored, later: { kept: true } }));

    await updateChat(options(root), "SAGA-1", 1, { session: "a session" });

    expect(JSON.parse(await read(record))).toEqual({ ...stored, later: { kept: true }, session: "a session" });
  });

  it("refuses an empty session and writes nothing", async () => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);
    const record = join(chatDir(root, "1", 1), "chat.json");
    const before = await read(record);

    expect((await storeError(updateChat(options(root), "SAGA-1", 1, { session: "" }))).code).toBe("field-required");
    await expect(read(record)).resolves.toBe(before);
  });

  it("refuses a chat that does not exist", async () => {
    const root = await withTasks();

    expect((await storeError(updateChat(options(root), "SAGA-1", 1, { session: "a" }))).code).toBe("chat-not-found");
  });
});

describe("a symbolic link in the place of a chats directory", () => {
  it.each([
    ["chats/", (root: string) => [projectDir(root), chatsDir(root), join(root, "outside")]],
    ["chats/<n>/", (root: string) => [chatsDir(root), join(chatsDir(root), "1"), join(root, "outside", "1")]],
  ])("at %s is refused by a create, a list and a task delete, and nothing outside changes", async (_name, at) => {
    const root = await withTasks();
    const outside = join(root, "outside");
    await mkdir(join(outside, "1"), { recursive: true });
    const [parent, link, target] = at(root) as [string, string, string];
    await mkdir(parent, { recursive: true });
    await symlink(target, link);

    expect((await storeError(createChat(options(root), "SAGA-1", CHAT_INPUT))).code).toBe("project-invalid");
    expect((await storeError(listChats(options(root), "SAGA-1"))).code).toBe("project-invalid");
    expect((await storeError(project(root).deleteTask("SAGA-1"))).code).toBe("project-invalid");
    await expect(readdir(outside)).resolves.toEqual(["1"]);
    await expect(readdir(join(outside, "1"))).resolves.toEqual([]);
    await expect(read(taskFile(root, "SAGA-1"))).resolves.toContain("id: SAGA-1");
  });

  it("refuses a chats directory that is a file", async () => {
    const root = await withTasks();
    await plant(chatsDir(root), "no directory");

    expect((await storeError(createChat(options(root), "SAGA-1", CHAT_INPUT))).code).toBe("project-invalid");
  });
});

describe("removeProject", () => {
  it("removes the chats with the project", async () => {
    const root = await withTasks();
    await createChat(options(root), "SAGA-1", CHAT_INPUT);

    await removeProject(options(root));

    await expect(readdir(join(root, "projects"))).resolves.toEqual([]);
  });
});
