import { appendFile, chmod, link, open as openFile, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { type ChatLogEntry, createChat, openChatLog, renameProject } from "@tasma/engine";
import { isTimestamp } from "../../src/format/schema.js";
import {
  CHAT_INPUT,
  chatDir,
  chatsDir,
  codes,
  plant,
  project,
  PROJECT,
  read,
  storeError,
  tempRoot,
} from "./helpers.js";

/** A tree holding task `SAGA-1` with one chat, and the path of that chat's event log. */
async function withChat(): Promise<{ root: string; log: string }> {
  const root = await tempRoot();
  await project(root).createTask({ title: "First" });
  await createChat({ project: PROJECT, root }, "SAGA-1", CHAT_INPUT);
  return { root, log: join(chatDir(root, "1", 1), "events.jsonl") };
}

function open(root: string, onEntry?: (entry: ChatLogEntry) => void) {
  return openChatLog({ project: PROJECT, root }, "SAGA-1", 1, onEntry);
}

/** One line of an event log as an append writes it. */
function line(seq: number, event: Record<string, unknown> = { kind: "user", text: `text ${seq}` }): string {
  return JSON.stringify({ seq, at: "2026-01-01T00:00:00+03:00", event });
}

function seqs(entries: ChatLogEntry[]): number[] {
  return entries.map((entry) => entry.seq);
}

describe("appending to a chat's event log", () => {
  it("gives each entry the next seq and the time of the append", async () => {
    const { root, log } = await withChat();
    const opened = await open(root);

    const entries = [];
    for (const text of ["one", "two", "three"]) entries.push(await opened.append({ kind: "user", text }));

    expect(seqs(entries)).toEqual([1, 2, 3]);
    expect(entries.every((entry) => isTimestamp(entry.at))).toBe(true);
    expect(entries[2]?.event).toEqual({ kind: "user", text: "three" });
    expect(opened.last).toBe(3);
    const lines = (await read(log)).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    expect(JSON.parse(lines[0]!)).toEqual(entries[0]);
  });

  it("is replayed in order by a second open", async () => {
    const { root } = await withChat();
    const first = await open(root);
    for (const text of ["one", "two", "three"]) await first.append({ kind: "user", text });

    const seen: ChatLogEntry[] = [];
    const second = await open(root, (entry) => seen.push(entry));

    expect(second.last).toBe(3);
    expect(second.diagnostics).toEqual([]);
    expect(seen.map((entry) => entry.event.text)).toEqual(["one", "two", "three"]);
    await expect(second.read(0)).resolves.toEqual(seen);
  });

  it("writes appends called without waiting in the order of the calls", async () => {
    const { root, log } = await withChat();
    const opened = await open(root);

    const entries = await Promise.all(["one", "two", "three", "four"].map((text) => opened.append({ text })));

    expect(entries.map((entry) => [entry.seq, entry.event.text])).toEqual([[1, "one"], [2, "two"], [3, "three"], [4, "four"]]);
    const lines = (await read(log)).trimEnd().split("\n").map((text) => JSON.parse(text) as ChatLogEntry);
    expect(lines).toEqual(entries);
  });

  it.each([
    ["an array", [] as unknown as Record<string, unknown>],
    ["a value that is written as no object", { toJSON: () => 1 }],
  ])("refuses an event that is %s and writes nothing", async (_name, event) => {
    const { root, log } = await withChat();
    const opened = await open(root);

    expect((await storeError(opened.append(event))).code).toBe("field-required");

    await expect(read(log)).resolves.toBe("");
    await expect(opened.append({ text: "next" })).resolves.toMatchObject({ seq: 1 });
  });

  it("refuses every append after one that failed, and still reads what it kept", async () => {
    const { root, log } = await withChat();
    const opened = await open(root);
    await opened.append({ text: "one" });
    await chmod(log, 0o400);

    await expect(opened.append({ text: "two" })).rejects.toMatchObject({ code: "EACCES" });
    await chmod(log, 0o600);

    expect((await storeError(opened.append({ text: "three" }))).code).toBe("chat-unreadable");
    expect(seqs(await opened.read(0))).toEqual([1]);
  });

  it("refuses an append onto a log a symbolic link took the place of, and writes nothing through it", async () => {
    const { root, log } = await withChat();
    const opened = await open(root);
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, "");
    await rm(log);
    await symlink(outside, log);

    expect((await storeError(opened.append({ text: "one" }))).code).toBe("chat-unreadable");
    await expect(read(outside)).resolves.toBe("");
  });

  it("refuses an append onto a log that got a second name after the open, and writes nothing", async () => {
    const { root, log } = await withChat();
    const opened = await open(root);
    await link(log, join(root, "outside.jsonl"));

    expect((await storeError(opened.append({ text: "one" }))).code).toBe("chat-unreadable");
    await expect(read(join(root, "outside.jsonl"))).resolves.toBe("");
  });
});

describe("reading a chat's event log", () => {
  it("gives only the entries after a seq", async () => {
    const { root } = await withChat();
    const opened = await open(root);
    for (const text of ["one", "two", "three"]) await opened.append({ text });

    expect(seqs(await opened.read(1))).toEqual([2, 3]);
    expect(seqs(await opened.read(-5))).toEqual([1, 2, 3]);
    await expect(opened.read(3)).resolves.toEqual([]);
    await expect(opened.read(9)).resolves.toEqual([]);
  });

  it("gives nothing from an empty log", async () => {
    const { root } = await withChat();
    const opened = await open(root);

    expect(opened.last).toBe(0);
    await expect(opened.read(-1)).resolves.toEqual([]);
  });

  it("splits a long log over several reads, each giving at least one entry", async () => {
    const { root } = await withChat();
    const opened = await open(root);
    for (const text of ["one", "two", "three"]) await opened.append({ text });
    const size = Buffer.byteLength(line(1, { text: "one" }));

    expect(seqs(await opened.read(0, { maxBytes: 1 }))).toEqual([1]);
    expect(seqs(await opened.read(1, { maxBytes: 1 }))).toEqual([2]);
    expect(seqs(await opened.read(0, { maxBytes: size * 2 + 10 }))).toEqual([1, 2]);
  });

  it("gives more entries in one read than a call can take as arguments", async () => {
    const { root, log } = await withChat();
    const count = 200_000;
    await writeFile(log, Array.from({ length: count }, (_unused, index) => `${line(index + 1, {})}\n`).join(""));
    const opened = await open(root);

    const entries = await opened.read(0, { maxBytes: 64 * 1024 * 1024 });

    expect(entries).toHaveLength(count);
    expect(entries.at(-1)?.seq).toBe(count);
  });

  it("reads a log longer than one chunk of the open, and lines that cross a chunk", async () => {
    const { root } = await withChat();
    const opened = await open(root);
    const text = "д".repeat(9000);
    for (let count = 0; count < 20; count += 1) await opened.append({ text: `${count} ${text}` });

    const seen: number[] = [];
    const again = await open(root, (entry) => seen.push(entry.seq));

    expect(again.last).toBe(20);
    expect(seen).toHaveLength(20);
    expect(again.diagnostics).toEqual([]);
    const entries = await again.read(0);
    expect(entries.map((entry) => entry.event.text)).toEqual(
      Array.from({ length: 20 }, (_unused, count) => `${count} ${text}`),
    );
  });

  it("refuses a read once the log changed under it", async () => {
    const { root, log } = await withChat();
    const opened = await open(root);
    await opened.append({ text: "one" });
    await truncate(log, 0);

    expect((await storeError(opened.read(0))).code).toBe("chat-unreadable");
  });

  it("refuses a read of a log a symbolic link took the place of", async () => {
    const { root, log } = await withChat();
    const opened = await open(root);
    await opened.append({ text: "one" });
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, `${line(1)}\n`);
    await rm(log);
    await symlink(outside, log);

    expect((await storeError(opened.read(0))).code).toBe("chat-unreadable");
  });
});

describe("a log an append did not finish", () => {
  it("reports a torn last line that cuts a character, and appends after it on a line of its own", async () => {
    const { root, log } = await withChat();
    const first = await open(root);
    await first.append({ text: "Привет" });
    await first.append({ text: "мир" });
    const torn = Buffer.from(line(3, { text: "Привет" }));
    const cut = torn.subarray(0, torn.indexOf(Buffer.from("и")) + 1);
    await appendFile(log, cut);
    const before = await readFile(log);

    const second = await open(root);

    expect(second.last).toBe(2);
    expect(second.diagnostics).toEqual([
      { code: "chat-file-unreadable", message: expect.any(String) as string, path: log, line: 3 },
    ]);
    await expect(second.append({ text: "снова" })).resolves.toMatchObject({ seq: 3 });
    const after = await readFile(log);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    expect(after[before.length]).toBe(0x0a);
    expect((await second.read(0)).map((entry) => entry.event.text)).toEqual(["Привет", "мир", "снова"]);

    const third = await open(root);
    expect(third.last).toBe(3);
    expect(codes(third.diagnostics)).toEqual(["chat-file-unreadable"]);
    expect((await third.read(2)).map((entry) => entry.event.text)).toEqual(["снова"]);
  });

  it("counts a complete last line with no newline, and appends the next seq on a new line", async () => {
    const { root, log } = await withChat();
    await writeFile(log, `${line(1)}\n${line(2)}`);

    const opened = await open(root);

    expect(opened.last).toBe(2);
    expect(opened.diagnostics).toEqual([]);
    await expect(opened.append({ text: "three" })).resolves.toMatchObject({ seq: 3 });
    expect((await read(log)).split("\n").map((text) => text.slice(0, 8))).toEqual(['{"seq":1', '{"seq":2', '{"seq":3', ""]);
    expect(seqs(await opened.read(1))).toEqual([2, 3]);
  });
});

describe("an invalid line inside a log", () => {
  it.each([
    ["no JSON", "{"],
    ["empty", ""],
    ["no object", "[1]"],
    ["a seq that does not rise", line(1)],
    ["a seq that is no integer", line(1.5)],
    ["no time", JSON.stringify({ seq: 2, event: {} })],
    ["an event that is no object", JSON.stringify({ seq: 2, at: "now", event: "text" })],
  ])("is passed over with its line number when it holds %s", async (_name, invalid) => {
    const { root, log } = await withChat();
    await writeFile(log, `${line(1)}\n${invalid}\n${line(3)}\n`);

    const opened = await open(root);

    expect(opened.last).toBe(3);
    expect(opened.diagnostics).toEqual([
      { code: "chat-file-unreadable", message: expect.any(String) as string, path: log, line: 2 },
    ]);
    expect(seqs(await opened.read(0))).toEqual([1, 3]);
    expect(seqs(await opened.read(1))).toEqual([3]);
    expect(seqs(await opened.read(2))).toEqual([3]);
  });

  it("is never read again by a read of the entries around it", async () => {
    const { root, log } = await withChat();
    await writeFile(log, `${line(1)}\n${line(2)}\n${"x".repeat(100_000)}\n${line(4)}\n`);
    const opened = await open(root);
    const probe = await openFile(log);
    const reads = vi.spyOn(Object.getPrototypeOf(probe) as { read: () => unknown }, "read");
    await probe.close();
    onTestFinished(() => reads.mockRestore());

    expect(seqs(await opened.read(0))).toEqual([1, 2, 4]);

    const lengths = reads.mock.calls.map((call) => (call as unknown[])[2]);
    expect(lengths).toEqual([Buffer.byteLength(`${line(1)}\n${line(2)}`), Buffer.byteLength(line(4))]);
  });
});

describe("opening a chat's event log", () => {
  it("refuses a chat that does not exist", async () => {
    const { root } = await withChat();

    expect((await storeError(openChatLog({ project: PROJECT, root }, "SAGA-1", 2))).code).toBe("chat-not-found");
  });

  it("refuses a record with no log", async () => {
    const { root, log } = await withChat();
    await rm(log);

    expect((await storeError(open(root))).code).toBe("chat-unreadable");
  });

  it("refuses a log that is a symbolic link", async () => {
    const { root, log } = await withChat();
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, `${line(1)}\n`);
    await rm(log);
    await symlink(outside, log);

    expect((await storeError(open(root))).code).toBe("chat-unreadable");
  });

  it("refuses a log with a second name, and writes nothing through it", async () => {
    const { root, log } = await withChat();
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, `${line(1)}\n`);
    await rm(log);
    await link(outside, log);

    expect((await storeError(open(root))).code).toBe("chat-unreadable");
    await expect(read(outside)).resolves.toBe(`${line(1)}\n`);
  });
});

describe("a chat that moved away", () => {
  it("answers chat-not-found to an append and a read once the chat is gone", async () => {
    const { root } = await withChat();
    const opened = await open(root);
    await opened.append({ text: "one" });
    await rm(chatsDir(root), { recursive: true });

    expect((await storeError(opened.append({ text: "two" }))).code).toBe("chat-not-found");
    expect((await storeError(opened.read(0))).code).toBe("chat-not-found");
  });

  it("answers chat-not-found through a link put in the place of a directory above the log, and writes nothing through it", async () => {
    const { root } = await withChat();
    const opened = await open(root);
    await opened.append({ text: "one" });
    const outside = join(root, "outside", "1", "events.jsonl");
    await plant(outside, `${line(1)}\n`);
    await rm(join(chatsDir(root), "1"), { recursive: true });
    await symlink(join(root, "outside"), join(chatsDir(root), "1"));

    expect((await storeError(opened.append({ text: "two" }))).code).toBe("chat-not-found");
    expect((await storeError(opened.read(0))).code).toBe("chat-not-found");
    await expect(read(outside)).resolves.toBe(`${line(1)}\n`);
  });

  it("goes on with the next seq in the renamed project once it is relocated", async () => {
    const { root } = await withChat();
    const opened = await open(root);
    await opened.append({ text: "one" });
    await opened.append({ text: "two" });

    await renameProject({ project: PROJECT, root }, { tag: "NEW" });

    expect((await storeError(opened.append({ text: "lost" }))).code).toBe("chat-not-found");
    opened.relocate("NEW");
    expect(opened.task).toBe("NEW-1");
    expect(opened.chat).toBe(1);
    await expect(opened.append({ text: "three" })).resolves.toMatchObject({ seq: 3 });
    expect((await opened.read(0)).map((entry) => entry.event.text)).toEqual(["one", "two", "three"]);
    const reopened = await openChatLog({ project: "NEW", root }, "NEW-1", 1);
    expect(reopened.last).toBe(3);
  });
});
