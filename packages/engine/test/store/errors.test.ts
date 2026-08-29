import { execFile as execFileCallback } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { type Project, TaskParseError, TaskSerializeError, TaskStoreError } from "@tasma/engine";
import { bareRoot, plant, project, projectDir, storeError, tasksDir, taskFile, taskText, tempRoot } from "./helpers.js";

const execFile = promisify(execFileCallback);

describe("project-not-found", () => {
  it.each([
    ["readTask", (handle: Project) => handle.readTask("TASM-1")],
    ["createTask", (handle: Project) => handle.createTask({ title: "First" })],
    ["updateTask", (handle: Project) => handle.updateTask("TASM-1", { title: "x" })],
    ["deleteTask", (handle: Project) => handle.deleteTask("TASM-1")],
    ["addComment", (handle: Project) => handle.addComment("TASM-1", { title: "x" })],
    ["updateComment", (handle: Project) => handle.updateComment("TASM-1", 1, { title: "x" })],
    ["deleteComment", (handle: Project) => handle.deleteComment("TASM-1", 1)],
    ["config", (handle: Project) => handle.config()],
    ["listTaskIds", (handle: Project) => handle.listTaskIds()],
  ])("is thrown by %s before anything else", async (_name, run) => {
    const root = await bareRoot();

    const error = await storeError(run(project(root)));

    expect(error.code).toBe("project-not-found");
    expect(error.path).toBe(projectDir(root));
  });
});

describe("task-not-found", () => {
  it.each([
    ["readTask", (handle: Project) => handle.readTask("TASM-9")],
    ["updateTask", (handle: Project) => handle.updateTask("TASM-9", { title: "x" })],
    ["deleteTask", (handle: Project) => handle.deleteTask("TASM-9")],
    ["addComment", (handle: Project) => handle.addComment("TASM-9", { title: "x" })],
    ["deleteComment", (handle: Project) => handle.deleteComment("TASM-9", 1)],
  ])("is thrown by %s and names the file", async (_name, run) => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    const error = await storeError(run(project(root)));

    expect(error.code).toBe("task-not-found");
    expect(error.path).toBe(taskFile(root, "TASM-9"));
  });

  it("is thrown for an id that is no task id, before any path is opened", async () => {
    const root = await tempRoot();

    expect((await storeError(project(root).readTask("../../etc/passwd"))).code).toBe("task-not-found");
  });
});

describe("comment-not-found", () => {
  it.each([
    ["updateComment", (handle: Project) => handle.updateComment("TASM-1", 4, { title: "x" })],
    ["deleteComment", (handle: Project) => handle.deleteComment("TASM-1", 4)],
  ])("is thrown by %s and names the file", async (_name, run) => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    const error = await storeError(run(project(root)));

    expect(error.code).toBe("comment-not-found");
    expect(error.path).toBe(taskFile(root, "TASM-1"));
  });
});

describe("id-mismatch", () => {
  it("is thrown when the file carries another id, and names both", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-30"));

    const error = await storeError(project(root).readTask("TASM-1"));

    expect(error.code).toBe("id-mismatch");
    expect(error.path).toBe(taskFile(root, "TASM-1"));
    expect(error.message).toContain("TASM-30");
  });

  it("stops a write from landing in the wrong file", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-30"));

    expect((await storeError(project(root).updateTask("TASM-1", { title: "x" }))).code).toBe("id-mismatch");
  });
});

describe("faults of the format layer", () => {
  it("lets a parse error through unwrapped, with the path on it", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), "no frontmatter here\n");

    await expect(project(root).readTask("TASM-1")).rejects.toBeInstanceOf(TaskParseError);
    await expect(project(root).readTask("TASM-1")).rejects.toMatchObject({
      code: "frontmatter-missing",
      filename: taskFile(root, "TASM-1"),
    });
  });

  it("lets a serialize error through unwrapped", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    await expect(project(root).updateTask("TASM-1", { body: "\n<!-- task:comment {} -->\n" })).rejects.toBeInstanceOf(
      TaskSerializeError,
    );
  });
});

describe("a name that holds no regular file", () => {
  it.each([
    [
      "a symbolic link",
      async (root: string) => {
        await plant(join(root, "outside.md"), taskText("TASM-9"));
        await mkdir(tasksDir(root), { recursive: true });
        await symlink(join(root, "outside.md"), taskFile(root, "TASM-9"));
      },
    ],
    ["a directory", async (root: string) => mkdir(taskFile(root, "TASM-9"), { recursive: true })],
    [
      "a pipe, which an open would wait on",
      async (root: string) => {
        await mkdir(tasksDir(root), { recursive: true });
        await execFile("mkfifo", [taskFile(root, "TASM-9")]);
      },
    ],
  ])("is no task file to a read, the way it is none to the scan, for %s", async (_name, stage) => {
    const root = await tempRoot();
    await stage(root);

    const error = await storeError(project(root).readTask("TASM-9"));

    expect(error.code).toBe("task-not-found");
    expect(error.path).toBe(taskFile(root, "TASM-9"));
    expect((await project(root).listTaskIds()).ids).toEqual([]);
  });
});

describe("a directory of the project that is a symbolic link", () => {
  it("refuses a project directory that points elsewhere", async () => {
    const root = await bareRoot();
    const outside = join(root, "outside");
    await mkdir(join(outside, "tasks"), { recursive: true });
    await mkdir(join(root, "projects"), { recursive: true });
    await symlink(outside, projectDir(root));

    const error = await storeError(project(root).readTask("TASM-1"));

    expect(error.code).toBe("project-invalid");
    expect(error.path).toBe(projectDir(root));
  });

  it("refuses a tasks directory that points elsewhere, which the guard on a file cannot reach", async () => {
    const root = await tempRoot();
    const outside = join(root, "outside");
    await plant(join(outside, "TASM-1.md"), taskText("TASM-1"));
    await symlink(outside, tasksDir(root));

    const error = await storeError(project(root).readTask("TASM-1"));

    expect(error.code).toBe("project-invalid");
    expect(error.path).toBe(tasksDir(root));
  });
});

describe("a tasks directory that is not a directory", () => {
  it.each([
    ["readTask", (handle: Project) => handle.readTask("TASM-1")],
    ["createTask", (handle: Project) => handle.createTask({ title: "First" })],
    ["listTaskIds", (handle: Project) => handle.listTaskIds()],
  ])("is refused by %s rather than reported as a fault of the filesystem", async (_name, run) => {
    const root = await tempRoot();
    await plant(tasksDir(root), "a file where the directory belongs");

    const error = await storeError(run(project(root)));

    expect(error.code).toBe("project-invalid");
    expect(error.path).toBe(tasksDir(root));
  });
});

describe("a fault of the filesystem the store gives no meaning", () => {
  it("reaches the caller from a delete as it stands", async () => {
    const root = await tempRoot();
    await mkdir(taskFile(root, "TASM-1"), { recursive: true });

    await expect(project(root).deleteTask("TASM-1")).rejects.not.toBeInstanceOf(TaskStoreError);
  });
});

describe("a project path that is not a directory", () => {
  it("is reported as no project", async () => {
    const root = await bareRoot();
    await plant(projectDir(root), "a file where the directory belongs");

    expect((await storeError(project(root).config())).code).toBe("project-not-found");
  });
});

describe("a fault of the project directory the store gives no meaning", () => {
  it("reaches the caller as it stands", async () => {
    const root = await bareRoot();
    await plant(join(root, "projects"), "a file where the directory belongs");

    await expect(project(root).config()).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
