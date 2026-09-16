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
    ["readTask", (handle: Project) => handle.readTask("SAGA-1")],
    ["createTask", (handle: Project) => handle.createTask({ title: "First" })],
    ["updateTask", (handle: Project) => handle.updateTask("SAGA-1", { title: "x" })],
    ["deleteTask", (handle: Project) => handle.deleteTask("SAGA-1")],
    ["removeReference", (handle: Project) => handle.removeReference("SAGA-1", "SAGA-2")],
    ["addComment", (handle: Project) => handle.addComment("SAGA-1", { title: "x" })],
    ["updateComment", (handle: Project) => handle.updateComment("SAGA-1", 1, { title: "x" })],
    ["deleteComment", (handle: Project) => handle.deleteComment("SAGA-1", 1)],
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
    ["readTask", (handle: Project) => handle.readTask("SAGA-9")],
    ["updateTask", (handle: Project) => handle.updateTask("SAGA-9", { title: "x" })],
    ["deleteTask", (handle: Project) => handle.deleteTask("SAGA-9")],
    ["removeReference", (handle: Project) => handle.removeReference("SAGA-9", "SAGA-1")],
    ["addComment", (handle: Project) => handle.addComment("SAGA-9", { title: "x" })],
    ["deleteComment", (handle: Project) => handle.deleteComment("SAGA-9", 1)],
  ])("is thrown by %s and names the file", async (_name, run) => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));

    const error = await storeError(run(project(root)));

    expect(error.code).toBe("task-not-found");
    expect(error.path).toBe(taskFile(root, "SAGA-9"));
  });

  it("is thrown for an id that is no task id, before any path is opened", async () => {
    const root = await tempRoot();

    expect((await storeError(project(root).readTask("../../etc/passwd"))).code).toBe("task-not-found");
  });
});

describe("comment-not-found", () => {
  it.each([
    ["updateComment", (handle: Project) => handle.updateComment("SAGA-1", 4, { title: "x" })],
    ["deleteComment", (handle: Project) => handle.deleteComment("SAGA-1", 4)],
  ])("is thrown by %s and names the file", async (_name, run) => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));

    const error = await storeError(run(project(root)));

    expect(error.code).toBe("comment-not-found");
    expect(error.path).toBe(taskFile(root, "SAGA-1"));
  });
});

describe("id-mismatch", () => {
  it("is thrown when the file carries another id, and names both", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-30"));

    const error = await storeError(project(root).readTask("SAGA-1"));

    expect(error.code).toBe("id-mismatch");
    expect(error.path).toBe(taskFile(root, "SAGA-1"));
    expect(error.message).toContain("SAGA-30");
  });

  it("stops a write from landing in the wrong file", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-30"));

    expect((await storeError(project(root).updateTask("SAGA-1", { title: "x" }))).code).toBe("id-mismatch");
  });
});

describe("faults of the format layer", () => {
  it("lets a parse error through unwrapped, with the path on it", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), "no frontmatter here\n");

    await expect(project(root).readTask("SAGA-1")).rejects.toBeInstanceOf(TaskParseError);
    await expect(project(root).readTask("SAGA-1")).rejects.toMatchObject({
      code: "frontmatter-missing",
      filename: taskFile(root, "SAGA-1"),
    });
  });

  it("lets a serialize error through unwrapped", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));

    await expect(project(root).updateTask("SAGA-1", { body: "\n<!-- task:comment {} -->\n" })).rejects.toBeInstanceOf(
      TaskSerializeError,
    );
  });
});

describe("a name that holds no regular file", () => {
  it.each([
    [
      "a symbolic link",
      async (root: string) => {
        await plant(join(root, "outside.md"), taskText("SAGA-9"));
        await mkdir(tasksDir(root), { recursive: true });
        await symlink(join(root, "outside.md"), taskFile(root, "SAGA-9"));
      },
    ],
    ["a directory", async (root: string) => mkdir(taskFile(root, "SAGA-9"), { recursive: true })],
    [
      "a pipe, which an open would wait on",
      async (root: string) => {
        await mkdir(tasksDir(root), { recursive: true });
        await execFile("mkfifo", [taskFile(root, "SAGA-9")]);
      },
    ],
  ])("is no task file to a read, the way it is none to the scan, for %s", async (_name, stage) => {
    const root = await tempRoot();
    await stage(root);

    const error = await storeError(project(root).readTask("SAGA-9"));

    expect(error.code).toBe("task-not-found");
    expect(error.path).toBe(taskFile(root, "SAGA-9"));
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

    const error = await storeError(project(root).readTask("SAGA-1"));

    expect(error.code).toBe("project-invalid");
    expect(error.path).toBe(projectDir(root));
  });

  it("refuses a tasks directory that points elsewhere, which the guard on a file cannot reach", async () => {
    const root = await tempRoot();
    const outside = join(root, "outside");
    await plant(join(outside, "SAGA-1.md"), taskText("SAGA-1"));
    await symlink(outside, tasksDir(root));

    const error = await storeError(project(root).readTask("SAGA-1"));

    expect(error.code).toBe("project-invalid");
    expect(error.path).toBe(tasksDir(root));
  });
});

describe("a tasks directory that is not a directory", () => {
  it.each([
    ["readTask", (handle: Project) => handle.readTask("SAGA-1")],
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
    await mkdir(taskFile(root, "SAGA-1"), { recursive: true });

    await expect(project(root).deleteTask("SAGA-1")).rejects.not.toBeInstanceOf(TaskStoreError);
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
