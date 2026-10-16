import { chmod, rm, writeFile } from "node:fs/promises";
import { describe, expect, it, onTestFinished } from "vitest";
import { type IndexChange, type IndexedProject, openIndexedProject } from "@tasma/engine";
import { type OpenTaskFile, TaskIndex } from "../../src/index-cache/cache.js";
import { openTaskFile } from "../../src/index-cache/frontmatter.js";
import { openIndexed } from "../../src/index-cache/project.js";
import { projectPaths } from "../../src/store/paths.js";
import { plant, project, PROJECT, taskFile, tasksDir, taskText, tempRoot } from "../store/helpers.js";
import { ids, taskEntry, unwatched, until, wired } from "./helpers.js";

/** A listener that keeps every change the index hands it. */
function changes(): { seen: IndexChange[]; on: (change: IndexChange) => void; sorted(): IndexChange[] } {
  const seen: IndexChange[] = [];
  return {
    seen,
    on: (change) => void seen.push(change),
    // A scan reads several files at a time, so the order of their reports is
    // the order the reads finished in.
    sorted: () => [...seen].sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

/** A built index over the temp tree that reports its changes, reading each file through `open`. */
async function reporting(root: string, on: (change: IndexChange) => void, open: OpenTaskFile): Promise<TaskIndex> {
  const cache = new TaskIndex(projectPaths({ project: PROJECT, root }), { onChange: on }, open);
  await cache.reconcile();
  cache.startChangeReports();
  return cache;
}

/** A fault of the filesystem with the errno it carries. */
function fault(code: string): Error {
  return Object.assign(new Error(`${code}: the filesystem failed`), { code });
}

describe("a write made through the index", () => {
  it.each<[string, (indexed: IndexedProject, id: string) => Promise<unknown>, IndexChange["change"][]]>([
    ["a create", async () => {}, ["created"]],
    ["an update", (indexed, id) => indexed.updateTask(id, { title: "Edited" }), ["created", "changed"]],
    ["a comment", (indexed, id) => indexed.addComment(id, { title: "One" }), ["created", "changed"]],
    ["a delete", (indexed, id) => indexed.deleteTask(id), ["created", "deleted"]],
  ])("reports %s once, and nothing for the watch event that follows it", async (_name, write, expected) => {
    const root = await tempRoot();
    const seen = changes();
    const { indexed, handlers } = await wired(root, { onChange: seen.on });
    const { id } = await indexed.createTask({ title: "First" });

    await write(indexed, id);
    handlers.onTask(taskEntry(root, id));
    await indexed.close();

    expect(seen.seen).toEqual(expected.map((change) => ({ id, change })));
  });

  it("reports a task a delete rewrote as changed", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    await plant(taskFile(root, "SAGA-2"), taskText("SAGA-2", "parent: SAGA-1\n"));
    const seen = changes();
    const indexed = await unwatched(project(root), { onChange: seen.on });

    await indexed.deleteTask("SAGA-1");

    expect(seen.seen).toEqual([
      { id: "SAGA-1", change: "deleted" },
      { id: "SAGA-2", change: "changed" },
    ]);
  });
});

describe("a direct edit of a task file on disk", () => {
  it("reports one change for one watch event after one edit", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const seen = changes();
    const { indexed, handlers } = await wired(root, { onChange: seen.on });

    await writeFile(taskFile(root, "SAGA-1"), taskText("SAGA-1").replace("Planted", "Edited by hand"), "utf8");
    handlers.onTask(taskEntry(root, "SAGA-1"));
    await indexed.close();

    expect(seen.seen).toEqual([{ id: "SAGA-1", change: "changed" }]);
  });

  it("reports an edit of the body alone, which no frontmatter shows", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const seen = changes();
    const { indexed, handlers } = await wired(root, { onChange: seen.on });

    await writeFile(taskFile(root, "SAGA-1"), taskText("SAGA-1").replace("Body.", "Another body."), "utf8");
    handlers.onTask(taskEntry(root, "SAGA-1"));
    await indexed.close();

    expect(seen.seen).toEqual([{ id: "SAGA-1", change: "changed" }]);
  });

  // The edit is made again while the wait runs, so this proves at least one report.
  it("reports the edit a live watch saw", { timeout: 8000, retry: 3 }, async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const seen = changes();
    const indexed = await openIndexedProject(project(root), { onChange: seen.on });
    onTestFinished(() => indexed.close());
    let edits = 0;

    await until(
      () => seen.seen.length > 0,
      "the edit was reported",
      () => writeFile(taskFile(root, "SAGA-1"), taskText("SAGA-1").replace("Planted", "x".repeat((edits += 1))), "utf8"),
    );

    expect(new Set(seen.seen.map((change) => `${change.id} ${change.change}`))).toEqual(new Set(["SAGA-1 changed"]));
  });
});

describe("the build and a rescan", () => {
  it("reports nothing for the build of a tree that holds tasks", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    await plant(taskFile(root, "SAGA-2"), "Not a task file.\n");
    const seen = changes();

    const indexed = await unwatched(project(root), { onChange: seen.on });

    expect(ids(indexed)).toEqual(["SAGA-1"]);
    expect(seen.seen).toEqual([]);
  });

  it("reports nothing for a rescan of a tree that did not change", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    await plant(taskFile(root, "SAGA-2"), "Not a task file.\n");
    const seen = changes();
    const indexed = await unwatched(project(root), { onChange: seen.on });

    await indexed.rescan();

    expect(seen.seen).toEqual([]);
  });

  it("reports the first task of a project that has no tasks directory yet", async () => {
    const root = await tempRoot();
    const seen = changes();
    const indexed = await unwatched(project(root), { onChange: seen.on });

    const { id } = await indexed.createTask({ title: "First" });

    expect(seen.seen).toEqual([{ id, change: "created" }]);
  });

  it("reports nothing for a build that rejects, nor for a watch event it took up meanwhile", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const seen = changes();

    // The event's read is still running when the build fails, and the close
    // that follows waits for it.
    const opening = openIndexed(project(root), { onChange: seen.on }, (handlers) => ({
      ensure: async () => {
        handlers.onTask(taskEntry(root, "SAGA-1"));
        throw new Error("the watch failed");
      },
      close: async () => {},
    }));

    await expect(opening).rejects.toThrow("the watch failed");
    expect(seen.seen).toEqual([]);
  });

  it("reports a file that appeared behind the index at the next rescan, and its removal at the rescan after", async () => {
    const root = await tempRoot();
    const seen = changes();
    const indexed = await unwatched(project(root), { onChange: seen.on });

    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    await indexed.rescan();
    await rm(taskFile(root, "SAGA-1"));
    await indexed.rescan();

    expect(seen.seen).toEqual([
      { id: "SAGA-1", change: "created" },
      { id: "SAGA-1", change: "deleted" },
    ]);
  });
});

describe("a file that holds no entry", () => {
  it("reports a broken file under the id of its file name", async () => {
    const root = await tempRoot();
    const seen = changes();
    const indexed = await unwatched(project(root), { onChange: seen.on });

    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-9"));
    await plant(taskFile(root, "SAGA-2"), taskText("OTHER-1"));
    await plant(taskFile(root, "SAGA-3"), "Not a task file.\n");
    await indexed.rescan();

    expect(seen.sorted()).toEqual([
      { id: "SAGA-1", change: "created" },
      { id: "SAGA-2", change: "created" },
      { id: "SAGA-3", change: "created" },
    ]);
  });

  it("reports a valid file that broke as changed, and again once it is repaired", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const seen = changes();
    const indexed = await unwatched(project(root), { onChange: seen.on });

    await plant(taskFile(root, "SAGA-1"), "Not a task file.\n");
    await indexed.rescan();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    await indexed.rescan();

    expect(seen.seen).toEqual([
      { id: "SAGA-1", change: "changed" },
      { id: "SAGA-1", change: "changed" },
    ]);
  });

  it("reports nothing again for a file it still may not open", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    await chmod(taskFile(root, "SAGA-1"), 0o000);
    onTestFinished(() => chmod(taskFile(root, "SAGA-1"), 0o600));
    const seen = changes();
    const indexed = await unwatched(project(root), { onChange: seen.on });

    await indexed.rescan();

    expect(indexed.query().excluded.map((file) => file.code)).toEqual(["task-file-unreadable"]);
    expect(seen.seen).toEqual([]);
  });

  it("reports an open that fails once and then succeeds on the same bytes as two changes", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const seen = changes();
    let failing = false;
    const cache = await reporting(root, seen.on, async (path) => {
      if (failing) throw fault("EMFILE");
      return openTaskFile(path);
    });

    failing = true;
    await cache.apply(taskEntry(root, "SAGA-1"));
    failing = false;
    await cache.apply(taskEntry(root, "SAGA-1"));

    expect(seen.seen).toEqual([
      { id: "SAGA-1", change: "changed" },
      { id: "SAGA-1", change: "changed" },
    ]);
  });

  it("reports a read that fails after the open as changed, though the identity is the same, and again once it succeeds", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const seen = changes();
    let failing = false;
    const cache = await reporting(root, seen.on, async (path) => {
      const source = await openTaskFile(path);
      if (!failing || typeof source === "string") return source;
      return { ...source, next: () => Promise.reject(fault("EIO")) };
    });

    failing = true;
    await cache.apply(taskEntry(root, "SAGA-1"));
    failing = false;
    await cache.apply(taskEntry(root, "SAGA-1"));

    expect(seen.seen).toEqual([
      { id: "SAGA-1", change: "changed" },
      { id: "SAGA-1", change: "changed" },
    ]);
  });
});

describe("a loss of the tasks directory", () => {
  it("reports each file it held as deleted, and each file the recovery finds as created", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    await plant(taskFile(root, "SAGA-2"), "Not a task file.\n");
    const seen = changes();
    const indexed = await unwatched(project(root), { onChange: seen.on });

    await rm(tasksDir(root), { recursive: true });
    await indexed.rescan();
    await indexed.rescan();
    const lost = seen.sorted();
    seen.seen.length = 0;
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    await plant(taskFile(root, "SAGA-3"), taskText("SAGA-3"));
    await indexed.rescan();

    expect(lost).toEqual([
      { id: "SAGA-1", change: "deleted" },
      { id: "SAGA-2", change: "deleted" },
    ]);
    expect(seen.sorted()).toEqual([
      { id: "SAGA-1", change: "created" },
      { id: "SAGA-3", change: "created" },
    ]);
  });
});

describe("the listener of changes", () => {
  it("leaves the map and the result of a write unharmed when it throws", async () => {
    const root = await tempRoot();
    const indexed = await unwatched(project(root), {
      onChange: () => {
        throw new Error("the listener failed");
      },
    });

    const created = await indexed.createTask({ title: "First" });

    expect(created).toMatchObject({ id: "SAGA-1", diagnostics: [] });
    expect(ids(indexed)).toEqual(["SAGA-1"]);
  });

  it("hears nothing once the index is closed", async () => {
    const root = await tempRoot();
    const seen = changes();
    const cache = await reporting(root, seen.on, openTaskFile);
    cache.close();

    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    await cache.apply(taskEntry(root, "SAGA-1"));

    expect(ids(cache)).toEqual(["SAGA-1"]);
    expect(seen.seen).toEqual([]);
  });
});
