import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdir, readdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseTask } from "@tasma/engine";
import {
  checkOpenFlags,
  createExclusive,
  makeDirectory,
  readRegularFile,
  removeFile,
  replaceFile,
  syncDirectory,
} from "../../src/store/atomic.js";
import { plant, project, read, statePath, tasksDir, taskFile, taskText, tempRoot } from "./helpers.js";

const execFile = promisify(execFileCallback);

/** The permission bits of one path, including the bits above the first nine. */
async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o7777;
}

/** A payload the write refuses once the file it writes into exists. */
const UNWRITABLE_PAYLOAD = 7 as unknown as string;

describe("a write that lands", () => {
  it("leaves no temp file behind", async () => {
    const root = await tempRoot();
    const handle = project(root);
    await handle.createTask({ title: "First" });

    await handle.updateTask("TASM-1", { title: "Renamed" });

    await expect(readdir(tasksDir(root))).resolves.toEqual(["TASM-1.md"]);
  });
});

describe("what a write leaves readable", () => {
  it("creates the task file, the counter and the directory for their owner alone", async () => {
    const root = await tempRoot();

    await project(root).createTask({ title: "First" });

    expect(await mode(tasksDir(root))).toBe(0o700);
    expect(await mode(taskFile(root, "TASM-1"))).toBe(0o600);
    expect(await mode(statePath(root))).toBe(0o600);
  });

  it("keeps a mode a user narrowed by hand", async () => {
    const root = await tempRoot();
    const handle = project(root);
    await handle.createTask({ title: "First" });
    await chmod(taskFile(root, "TASM-1"), 0o400);

    await handle.updateTask("TASM-1", { title: "Renamed" });

    expect(await mode(taskFile(root, "TASM-1"))).toBe(0o400);
  });

  it.each([
    ["a mode another writer widened", 0o666],
    ["a mode that grants the group", 0o640],
    ["the setuid bit", 0o4600],
  ])("does not carry %s onto the file it installs", async (_name, planted) => {
    const root = await tempRoot();
    const handle = project(root);
    await handle.createTask({ title: "First" });
    await chmod(taskFile(root, "TASM-1"), planted);

    await handle.updateTask("TASM-1", { title: "Renamed" });

    expect(await mode(taskFile(root, "TASM-1"))).toBe(0o600);
  });

  it("carries no mode over from a name that holds no regular file, and replaces the name", async () => {
    const root = await tempRoot();
    const outside = join(root, "outside.md");
    await plant(outside, "text");
    await chmod(outside, 0o666);
    await mkdir(tasksDir(root), { recursive: true });
    await symlink(outside, taskFile(root, "TASM-1"));

    await replaceFile(taskFile(root, "TASM-1"), "new text");

    expect(await mode(taskFile(root, "TASM-1"))).toBe(0o600);
    expect(await read(outside)).toBe("text");
  });
});

describe("readRegularFile", () => {
  it("returns at once for a pipe, which an open would otherwise wait on", async () => {
    const root = await tempRoot();
    const pipe = join(root, "pipe");
    await execFile("mkfifo", [pipe]);

    await expect(readRegularFile(pipe)).resolves.toBe("irregular");
  });

  it("reads a file a symbolic link points at when it is told to follow one", async () => {
    const root = await tempRoot();
    await plant(join(root, "outside.yml"), "text\n");
    await symlink(join(root, "outside.yml"), join(root, "link.yml"));

    await expect(readRegularFile(join(root, "link.yml"), true)).resolves.toEqual({ text: "text\n" });
  });

  it("lets a fault that is not a missing file reach the caller", async () => {
    const root = await tempRoot();
    await plant(join(root, "file"), "text");

    await expect(readRegularFile(join(root, "file", "under.yml"))).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

describe("makeDirectory", () => {
  it("creates the directory and passes over a name that already holds one", async () => {
    const root = await tempRoot();
    const path = join(root, "made");

    await makeDirectory(path);
    await makeDirectory(path);

    expect(await mode(path)).toBe(0o700);
  });

  it("lets a fault that is not an existing name reach the caller", async () => {
    const root = await tempRoot();

    await expect(makeDirectory(join(root, "missing", "made"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("syncDirectory", () => {
  it("passes over a directory it cannot open, because the content is already flushed", async () => {
    const root = await tempRoot();

    await expect(syncDirectory(join(root, "nothing"))).resolves.toBeUndefined();
  });

  it.each([
    ["a pipe, which an open would otherwise wait on", async (path: string) => execFile("mkfifo", [path])],
    ["a regular file, which no flush of a directory entry concerns", async (path: string) => plant(path, "text\n")],
  ])("returns at once for %s", async (_name, stage) => {
    const root = await tempRoot();
    const path = join(root, "name");
    await stage(path);

    await expect(syncDirectory(path)).resolves.toBeUndefined();
  });
});

describe("the open flags this layer needs", () => {
  it("accepts the set the platform running the tests defines", () => {
    expect(() => checkOpenFlags(constants)).not.toThrow();
  });

  it.each(["O_NOFOLLOW", "O_NONBLOCK", "O_DIRECTORY"])("refuses a platform that defines no %s", (name) => {
    expect(() => checkOpenFlags({ ...constants, [name]: undefined })).toThrow(name);
  });
});

describe("a write that fails", () => {
  it("leaves the file it was replacing byte-identical", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const before = await read(taskFile(root, "TASM-1"));

    await expect(replaceFile(taskFile(root, "TASM-1"), UNWRITABLE_PAYLOAD)).rejects.toThrow();

    expect(await read(taskFile(root, "TASM-1"))).toBe(before);
    await expect(readdir(tasksDir(root))).resolves.toEqual(["TASM-1.md"]);
  });

  it("removes the temp file it had opened", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    await expect(replaceFile(taskFile(root, "TASM-1"), UNWRITABLE_PAYLOAD)).rejects.toThrow();

    await expect(readdir(tasksDir(root))).resolves.toEqual(["TASM-1.md"]);
  });

  it("removes a file an exclusive create had just made", async () => {
    const root = await tempRoot();
    await plant(join(tasksDir(root), "other.txt"), "keep me");

    await expect(createExclusive(taskFile(root, "TASM-1"), UNWRITABLE_PAYLOAD)).rejects.toThrow();

    await expect(readdir(tasksDir(root))).resolves.toEqual(["other.txt"]);
  });

  it("leaves a file the exclusive create did not make", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const before = await read(taskFile(root, "TASM-1"));

    await expect(createExclusive(taskFile(root, "TASM-1"), "new text")).rejects.toMatchObject({ code: "EEXIST" });

    expect(await read(taskFile(root, "TASM-1"))).toBe(before);
  });
});

describe("a target the filesystem cannot reach", () => {
  it("lets the fault reach the caller and writes no temp file", async () => {
    const root = await tempRoot();
    await plant(tasksDir(root), "a file where the directory belongs");

    await expect(replaceFile(taskFile(root, "TASM-1"), "text")).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

describe("removeFile", () => {
  it("deletes the file", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    await removeFile(taskFile(root, "TASM-1"));

    await expect(readdir(tasksDir(root))).resolves.toEqual([]);
  });
});

describe("two writers on one file", () => {
  it("leaves a file that parses, with the last write winning", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const handle = project(root);
    const titles = ["One", "Two", "Three", "Four", "Five"];

    await Promise.all(titles.map((title) => handle.updateTask("TASM-1", { title })));

    const { task } = parseTask(await read(taskFile(root, "TASM-1")));
    expect(titles).toContain(task.frontmatter.title);
    await expect(readdir(tasksDir(root))).resolves.toEqual(["TASM-1.md"]);
  });

  it("never lets a reader see a file that is half written", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const handle = project(root);
    const long = `\n${"A line of the body.\n".repeat(2000)}`;

    const writes = Promise.all([
      handle.updateTask("TASM-1", { body: long }),
      handle.updateTask("TASM-1", { body: "\nShort.\n" }),
    ]);
    const reads: string[] = [];
    for (let attempt = 0; attempt < 50; attempt += 1) reads.push(await read(taskFile(root, "TASM-1")));
    await writes;

    for (const text of reads) expect(() => parseTask(text)).not.toThrow();
  });
});
