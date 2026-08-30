import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { type IndexedProject, openIndexedProject, TaskParseError, TaskStoreError } from "@tasma/engine";
import { openIndexed } from "../../src/index-cache/project.js";
import type { WatchHandlers } from "../../src/index-cache/watch.js";
import {
  bareRoot,
  plant,
  project,
  PROJECT,
  projectDir,
  read,
  storeError,
  taskFile,
  tasksDir,
  taskText,
  tempRoot,
} from "../store/helpers.js";
import { BOM, ids, listener, taskEntry, unwatched, until } from "./helpers.js";

describe("a write made through the index", () => {
  it("is in the index by the time the call returns", async () => {
    const root = await tempRoot();
    const indexed = await unwatched(project(root));

    const created = await indexed.createTask({ title: "First" });

    expect(ids(indexed)).toEqual([created.id]);
    expect(indexed.query().entries[0]?.frontmatter.title).toBe("First");
  });

  it("carries an edit of a task into the index", async () => {
    const root = await tempRoot();
    const indexed = await unwatched(project(root));
    const created = await indexed.createTask({ title: "First" });

    await indexed.updateTask(created.id, { title: "Edited" });

    expect(indexed.query().entries[0]?.frontmatter.title).toBe("Edited");
  });

  it("drops the entry of a task it deleted", async () => {
    const root = await tempRoot();
    const indexed = await unwatched(project(root));
    const created = await indexed.createTask({ title: "First" });

    await indexed.deleteTask(created.id);

    expect(ids(indexed)).toEqual([]);
  });

  it.each<[string, (indexed: IndexedProject, id: string) => Promise<unknown>]>([
    ["addComment", (indexed, id) => indexed.addComment(id, { title: "Two" })],
    ["updateComment", (indexed, id) => indexed.updateComment(id, 1, { title: "Two" })],
    ["deleteComment", (indexed, id) => indexed.deleteComment(id, 1)],
  ])("reads the file back after %s, which moves the frontmatter", async (_name, write) => {
    const root = await tempRoot();
    const indexed = await unwatched(project(root));
    const created = await indexed.createTask({ title: "First" });
    await indexed.addComment(created.id, { title: "One" });
    // A hand edit the index can only hold if the write that follows it applied
    // the file: a comment write moves `updated` and `next_comment_id`, which
    // stand in the frontmatter.
    const path = taskFile(root, created.id);
    await writeFile(path, (await read(path)).replace("title: First", "title: By hand"), "utf8");

    await write(indexed, created.id);

    expect(indexed.query().entries[0]?.frontmatter.title).toBe("By hand");
  });

  it("reads the file back rather than trusting what it wrote", async () => {
    const root = await tempRoot();
    const indexed = await unwatched(project(root));
    const created = await indexed.createTask({ title: "First" });

    await plant(taskFile(root, created.id), taskText(created.id).replace("Planted", "By hand"));
    await indexed.updateTask(created.id, { order: 1 });

    expect(indexed.query().entries[0]?.frontmatter.title).toBe("By hand");
  });

  it("applies the file of a write that threw", async () => {
    const root = await tempRoot();
    const indexed = await unwatched(project(root));
    const created = await indexed.createTask({ title: "First" });

    await rm(taskFile(root, created.id));
    await expect(indexed.deleteTask(created.id)).rejects.toThrow(TaskStoreError);

    expect(ids(indexed)).toEqual([]);
  });

  it("lands no entry for a write a project a symbolic link replaced refused", async () => {
    const root = await tempRoot();
    const indexed = await unwatched(project(root));
    const created = await indexed.createTask({ title: "First" });

    // The store refuses the write, and the read back of the file it named would
    // reach the tree the link points at.
    await plant(join(root, "outside", "tasks", `${created.id}.md`), taskText(created.id));
    await rm(projectDir(root), { recursive: true });
    await symlink(join(root, "outside"), projectDir(root));

    expect((await storeError(indexed.updateTask(created.id, { title: "Edited" }))).code).toBe("project-invalid");
    expect(ids(indexed)).toEqual([]);
  });

  it("touches the index for no write that names no file of this project", async () => {
    const root = await tempRoot();
    const indexed = await unwatched(project(root));

    expect((await storeError(indexed.updateTask("OTHER-1", { title: "x" }))).code).toBe("task-not-found");
    expect(ids(indexed)).toEqual([]);
  });

  it("leaves a read to the project it wraps", async () => {
    const root = await tempRoot();
    const indexed = await unwatched(project(root));
    const created = await indexed.createTask({ title: "First" });

    expect((await indexed.readTask(created.id)).task.frontmatter.title).toBe("First");
    expect((await indexed.listTaskIds()).ids).toEqual([created.id]);
    expect((await indexed.config()).config.statuses).toContain("To Do");
    expect(indexed.paths.project).toBe(PROJECT);
  });
});

describe("rescanning behind the index", () => {
  it("takes up a file that appeared", async () => {
    const root = await tempRoot();
    const indexed = await unwatched(project(root));

    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    await indexed.rescan();

    expect(ids(indexed)).toEqual(["TASM-1"]);
  });

  it("excludes a file that opens with a byte-order mark, which a read of the task refuses too", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), `${BOM}${taskText("TASM-1")}`);
    const indexed = await unwatched(project(root));

    // One file, one answer: an entry the index admitted and a read that throws
    // would put the same task on both sides of the invariant.
    expect(ids(indexed)).toEqual([]);
    expect(indexed.query().excluded.map((file) => file.code)).toEqual(["task-file-unreadable"]);
    await expect(indexed.readTask("TASM-1")).rejects.toThrow(TaskParseError);
  });

  it("drops a file that a hand edit removed", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const indexed = await unwatched(project(root));

    await rm(taskFile(root, "TASM-1"));
    await indexed.rescan();

    expect(ids(indexed)).toEqual([]);
  });
});

describe("what the index does with what a watch reports", () => {
  /** An index whose watch reports nothing on its own, so the test reports in its place. */
  async function wired(
    root: string,
    seen: ReturnType<typeof listener>,
  ): Promise<{ indexed: IndexedProject; handlers: WatchHandlers }> {
    let handlers: WatchHandlers | undefined;
    const indexed = await openIndexed(project(root), { onDiagnostic: seen.on }, (given) => {
      handlers = given;
      return { ensure: async () => {}, close: async () => {} };
    });
    onTestFinished(() => indexed.close());
    return { indexed, handlers: handlers as WatchHandlers };
  }

  it("reads the file a watch names", async () => {
    const root = await tempRoot();
    const { indexed, handlers } = await wired(root, listener());
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    handlers.onTask(taskEntry(root, "TASM-1"));

    await until(() => ids(indexed).length === 1, "the event reached the index");
  });

  it("reports a watch that failed", async () => {
    const root = await tempRoot();
    const seen = listener();
    const { handlers } = await wired(root, seen);

    handlers.onFailure({ code: "index-watch-failed", message: "the watch failed", path: tasksDir(root) });

    expect(seen.codes()).toEqual(["index-watch-failed"]);
  });

  it("reads nothing more once it is closed", async () => {
    const root = await tempRoot();
    const seen = listener();
    const { indexed, handlers } = await wired(root, seen);
    await indexed.close();
    // A file the index would report on if it read it at all.
    await plant(taskFile(root, "TASM-1"), "Not a task file.\n");

    handlers.onTasksDirectory();
    handlers.onTask(taskEntry(root, "TASM-1"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(() => indexed.query()).toThrow(TaskStoreError);
    expect(seen.codes()).toEqual([]);
  });

  it("hands the listener nothing a watch found after it closed", async () => {
    const root = await tempRoot();
    const seen = listener();
    const { indexed, handlers } = await wired(root, seen);
    await indexed.close();

    // A debounce that fired just before the close is reading a name of its own,
    // with no caller to be waited on and no guard of its own.
    handlers.onFailure({ code: "index-watch-failed", message: "the watch failed", path: tasksDir(root) });

    expect(seen.codes()).toEqual([]);
  });

  it("waits for a read a watch started before it closed", async () => {
    const root = await tempRoot();
    const seen = listener();
    const { indexed, handlers } = await wired(root, seen);
    await plant(taskFile(root, "TASM-1"), "Not a task file.\n");

    // The read holds the file open and reaches the listener, so a close that
    // returned before it would leave both behind the caller's back.
    handlers.onTask(taskEntry(root, "TASM-1"));
    await indexed.close();

    expect(seen.codes()).toEqual(["task-file-unreadable"]);
  });

  it("reports a read a watch started and nobody awaits, rather than letting it escape", async () => {
    const root = await tempRoot();
    const seen = listener();
    const { handlers } = await wired(root, seen);

    // A directory nobody may read: the scan the event starts fails, and the
    // event has no caller to fail.
    await mkdir(tasksDir(root), { recursive: true });
    await chmod(tasksDir(root), 0o000);
    onTestFinished(() => chmod(tasksDir(root), 0o755));
    handlers.onTasksDirectory();

    await until(() => seen.codes().length > 0, "the failed scan was reported");
    expect(seen.codes()).toEqual(["index-watch-failed"]);
    expect(seen.seen[0]?.message).toContain("EACCES");
  });

  it("cuts what it quotes of a fault down to a length its message can carry", async () => {
    const root = await tempRoot();
    const seen = listener();
    let handlers: WatchHandlers | undefined;
    let broken = false;
    const indexed = await openIndexed(project(root), { onDiagnostic: seen.on }, (given) => {
      handlers = given;
      return {
        ensure: async () => {
          if (broken) throw new Error(`one\ntwo${"x".repeat(4000)}`);
        },
        close: async () => {},
      };
    });
    onTestFinished(() => indexed.close());
    broken = true;

    (handlers as WatchHandlers).onTasksDirectory();

    await until(() => seen.codes().length > 0, "the failed scan was reported");
    expect(seen.seen[0]?.message.length).toBeLessThan(300);
    expect(seen.seen[0]?.message).not.toContain("\n");
  });

  it("reads the whole directory when the tasks directory moved", async () => {
    const root = await tempRoot();
    const { indexed, handlers } = await wired(root, listener());
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    handlers.onTasksDirectory();

    await until(() => ids(indexed).length === 1, "the directory was read again");
  });
});

describe("a closed index", () => {
  it("throws index-closed on every call that answers for the project", async () => {
    const root = await tempRoot();
    const indexed = await unwatched(project(root));
    await indexed.close();

    expect(() => indexed.query()).toThrow(TaskStoreError);
    for (const call of [
      indexed.rescan(),
      indexed.readTask("TASM-1"),
      indexed.config(),
      indexed.listTaskIds(),
      indexed.createTask({ title: "First" }),
      indexed.updateTask("TASM-1", { title: "x" }),
      indexed.deleteTask("TASM-1"),
      indexed.addComment("TASM-1", { title: "One" }),
      indexed.updateComment("TASM-1", 1, { title: "One" }),
      indexed.deleteComment("TASM-1", 1),
    ]) {
      expect((await storeError(call)).code).toBe("index-closed");
    }
  });

  it("closes again without failing", async () => {
    const root = await tempRoot();
    const indexed = await unwatched(project(root));

    await indexed.close();

    await expect(indexed.close()).resolves.toBeUndefined();
  });

  it("leaves the project it wraps usable", async () => {
    const root = await tempRoot();
    const inner = project(root);
    const indexed = await unwatched(inner);
    await indexed.close();

    await expect(inner.createTask({ title: "First" })).resolves.toBeDefined();
  });
});

describe("openIndexedProject", () => {
  it("holds the tasks of the project it opened", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    const indexed = await openIndexedProject(project(root));

    expect(ids(indexed)).toEqual(["TASM-1"]);
    await indexed.close();
  });

  it("refuses a project nobody registered", async () => {
    const root = await bareRoot();

    expect((await storeError(openIndexedProject(project(root)))).code).toBe("project-not-found");
  });

  it("reports what the first build found", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), "Not a task file.\n");
    const seen = listener();

    const indexed = await openIndexedProject(project(root), { onDiagnostic: seen.on });

    expect(seen.codes()).toEqual(["task-file-unreadable"]);
    await indexed.close();
  });

  it("releases the watches it took when the first scan fails", async () => {
    const root = await tempRoot();
    // A tasks directory nobody may read: the watches are taken and the scan then
    // fails, which is the one path that has to release what it just took.
    await mkdir(tasksDir(root), { recursive: true });
    await chmod(tasksDir(root), 0o000);
    onTestFinished(() => chmod(tasksDir(root), 0o755));
    let closed = 0;

    const opening = openIndexed(project(root), {}, () => ({
      ensure: async () => {},
      close: async () => {
        closed += 1;
      },
    }));

    await expect(opening).rejects.toThrow();
    expect(closed).toBe(1);
  });
});
