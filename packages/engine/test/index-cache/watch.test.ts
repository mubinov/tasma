import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, type FSWatcher } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { type IndexChange, type IndexedProject, openIndexedProject, type StoreDiagnostic } from "@tasma/engine";
import { type ReadIdentity, Watches, type WatchHandlers } from "../../src/index-cache/watch.js";
import { projectPaths } from "../../src/store/paths.js";
import { plant, project, projectDir, PROJECT, taskFile, tasksDir, taskText, tempRoot } from "../store/helpers.js";
import { ids, listener, until } from "./helpers.js";

/** An index that watches the temp tree, closed when the test ends. */
async function watching(root: string, on?: (diagnostic: StoreDiagnostic) => void): Promise<IndexedProject> {
  const indexed = await openIndexedProject(project(root), on === undefined ? {} : { onDiagnostic: on });
  onTestFinished(() => indexed.close());
  return indexed;
}

/** Whether a `bun` is on PATH to run the watcher under, as the compiled daemon runs it. */
const HAS_BUN = spawnSync("bun", ["--version"]).error === undefined;

/** A change the index under Bun reported, with the title it then held for the task. */
type BunChange = IndexChange & { title?: string };

/**
 * An index that watches the temp tree inside a `bun` process, and the changes
 * it has printed so far.
 */
async function watchingUnderBun(root: string): Promise<BunChange[]> {
  const script = fileURLToPath(new URL("under-bun.ts", import.meta.url));
  const child = spawn("bun", [script, root, PROJECT], { stdio: ["pipe", "pipe", "inherit"] });
  onTestFinished(() => {
    child.stdin.end();
    child.kill();
  });
  const changes: BunChange[] = [];
  let pending = "";
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`bun exited with ${String(code)} before the index was open`)));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "ready") resolve();
        else changes.push(JSON.parse(line) as BunChange);
      }
    });
  });
  return changes;
}

/** Whether the changes hold one of this id and kind, and, where given, with this title. */
function saw(changes: BunChange[], id: string, change: IndexChange["change"], title?: string): boolean {
  return changes.some(
    (seen) => seen.id === id && seen.change === change && (title === undefined || seen.title === title),
  );
}

// The watcher is proved on events alone: that they arrive and are applied. Every
// rule they run into — the map, the exclusions, the queue — is proved without
// one, so a test here waits by polling the index rather than by sleeping.
describe("the watcher of an open index", { timeout: 8000, retry: 3 }, () => {
  it("takes up a file a hand edit created", async () => {
    const root = await tempRoot();
    const indexed = await watching(root);

    await until(() => ids(indexed).length === 1, "the created file reached the index", () =>
      plant(taskFile(root, "SAGA-1"), taskText("SAGA-1")),
    );

    expect(ids(indexed)).toEqual(["SAGA-1"]);
  });

  it("takes up a change a hand edit made", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const indexed = await watching(root);

    await until(() => indexed.query().entries[0]?.frontmatter.title === "By hand", "the edit reached the index", () =>
      writeFile(taskFile(root, "SAGA-1"), taskText("SAGA-1").replace("Planted", "By hand"), "utf8"),
    );
  });

  it("drops a file a hand edit removed", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const indexed = await watching(root);

    // Written again before each removal: a second removal of a file that is
    // already gone changes nothing, so it reports nothing either.
    await until(() => ids(indexed).length === 0, "the removed file left the index", async () => {
      await writeFile(taskFile(root, "SAGA-1"), taskText("SAGA-1"), "utf8");
      await rm(taskFile(root, "SAGA-1"), { force: true });
    });
  });

  it("excludes a file a hand edit broke, and reports it", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const seen = listener();
    const indexed = await watching(root, seen.on);

    await until(() => seen.codes().includes("task-file-unreadable"), "the broken file was reported", () =>
      writeFile(taskFile(root, "SAGA-1"), "Broken by hand.\n", "utf8"),
    );

    expect(ids(indexed)).toEqual([]);
    expect(indexed.query().excluded[0]?.path).toBe(taskFile(root, "SAGA-1"));
  });

  it("takes up a tasks directory that appeared under it", async () => {
    const root = await tempRoot();
    const indexed = await watching(root);

    await until(() => ids(indexed).length === 1, "the new tasks directory reached the index", () =>
      plant(taskFile(root, "SAGA-1"), taskText("SAGA-1")),
    );
  });

  it("drops every task when the tasks directory goes away", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const seen = listener();
    const indexed = await watching(root, seen.on);

    await until(() => seen.codes().includes("tasks-directory-lost"), "the lost directory was reported", async () => {
      await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
      await rm(tasksDir(root), { recursive: true, force: true });
    });

    expect(ids(indexed)).toEqual([]);
  });

  it("passes over a file that is no task file of this project", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const seen = listener();
    const indexed = await watching(root, seen.on);

    await until(() => ids(indexed).length === 2, "the second task reached the index", async () => {
      await plant(join(tasksDir(root), "notes.md"), "notes");
      await plant(taskFile(root, "SAGA-2"), taskText("SAGA-2"));
    });

    expect(seen.codes()).toEqual([]);
  });
});

// Bun reports a rename under its source name alone on macOS, where Node reports
// both names, so only a run under Bun shows that the file a rename put in place
// is read.
describe("the watcher under Bun", { timeout: 8000, retry: 3 }, () => {
  it("takes up a task file that a rename replaced", async (ctx) => {
    if (!HAS_BUN) ctx.skip("bun is not on PATH");
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const changes = await watchingUnderBun(root);
    const temp = join(tasksDir(root), ".SAGA-1.md.tmp");

    await until(() => saw(changes, "SAGA-1", "changed", "Saved"), "the replaced file was reported", async () => {
      await writeFile(temp, taskText("SAGA-1").replace("Planted", "Saved"), "utf8");
      await rename(temp, taskFile(root, "SAGA-1"));
    });

    expect(changes.every((change) => change.id === "SAGA-1" && change.change === "changed")).toBe(true);
  });

  it("takes up a task file that a rename created", async (ctx) => {
    if (!HAS_BUN) ctx.skip("bun is not on PATH");
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const changes = await watchingUnderBun(root);
    const temp = join(tasksDir(root), ".SAGA-1.md.tmp");

    await until(() => saw(changes, "SAGA-1", "created", "Planted"), "the created file was reported", async () => {
      await writeFile(temp, taskText("SAGA-1"), "utf8");
      await rename(temp, taskFile(root, "SAGA-1"));
    });
  });

  it("takes up a task file that a rename moved to another task name", async (ctx) => {
    if (!HAS_BUN) ctx.skip("bun is not on PATH");
    const root = await tempRoot();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-2"));
    const changes = await watchingUnderBun(root);

    await until(
      () => saw(changes, "SAGA-1", "deleted") && saw(changes, "SAGA-2", "created", "Planted"),
      "the move was reported under both names",
      async () => {
        if (existsSync(taskFile(root, "SAGA-1"))) await rename(taskFile(root, "SAGA-1"), taskFile(root, "SAGA-2"));
        else await rename(taskFile(root, "SAGA-2"), taskFile(root, "SAGA-1"));
      },
    );
  });
});

describe("the two watches themselves", () => {
  /** A watch a test drives by hand, in place of one the operating system feeds. */
  class Fake extends EventEmitter {
    closed = 0;
    readonly #listener: (event: string, name: string | null) => void;

    constructor(listener: (event: string, name: string | null) => void) {
      super();
      this.#listener = listener;
    }

    /** What the operating system reports for one change under the directory. */
    change(name: string | null, event = "change"): void {
      this.#listener(event, name);
    }

    close(): void {
      this.closed += 1;
    }
  }

  /** Handlers that do nothing, for a test that hears one of them at most. */
  const QUIET: WatchHandlers = {
    onTask: () => {},
    onUnnamedChange: () => {},
    onTasksDirectory: () => {},
    onFailure: () => {},
  };

  /**
   * The watches over a temp tree, and the fake watch each `ensure` took.
   *
   * `identity` stands in for the read of what a name holds, so a test that turns
   * on which of two reads answers last decides that itself rather than leaving
   * it to the scheduler.
   */
  function openWatches(
    root: string,
    handlers: Partial<WatchHandlers> = {},
    identity?: ReadIdentity,
  ): { watches: Watches; taken: Map<string, Fake> } {
    const taken = new Map<string, Fake>();
    const paths = projectPaths({ project: PROJECT, root });
    const all: WatchHandlers = {
      onTask: handlers.onTask ?? (() => {}),
      onUnnamedChange: handlers.onUnnamedChange ?? (() => {}),
      onTasksDirectory: handlers.onTasksDirectory ?? (() => {}),
      onFailure: handlers.onFailure ?? (() => {}),
    };
    const open = (path: string, listener: (event: string, name: string | null) => void): FSWatcher => {
      const fake = new Fake(listener);
      taken.set(path, fake);
      return fake as unknown as FSWatcher;
    };
    return { watches: new Watches(paths, all, open, identity), taken };
  }

  it("watches the project directory and the tasks directory", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const { watches, taken } = openWatches(root);

    await watches.ensure();

    expect([...taken.keys()]).toEqual([projectDir(root), tasksDir(root)]);
    await watches.close();
  });

  it("watches the project directory alone while there is no tasks directory", async () => {
    const root = await tempRoot();
    const { watches, taken } = openWatches(root);

    await watches.ensure();

    expect([...taken.keys()]).toEqual([projectDir(root)]);
    await watches.close();
  });

  it("closes every watch it took", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const { watches, taken } = openWatches(root);
    await watches.ensure();

    await watches.close();

    expect([...taken.values()].map((fake) => fake.closed)).toEqual([1, 1]);
  });

  it("drops an event it had not read yet when it closes", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const applied: string[] = [];
    const { watches, taken } = openWatches(root, {
      onTask: (file) => void applied.push(file.id),
      onUnnamedChange: () => void applied.push("sweep"),
    });
    await watches.ensure();

    taken.get(tasksDir(root))?.change("SAGA-1.md");
    await watches.close();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(applied).toEqual([]);
  });

  it("takes no watch once it is closed", async () => {
    const root = await tempRoot();
    const { watches, taken } = openWatches(root);
    await watches.close();

    await watches.ensure();

    expect([...taken.keys()]).toEqual([]);
  });

  it("takes no watch when it is closed while it looks for the project directory", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const reading = new Promise<void>((resolve) => (started = resolve));
    const identity: ReadIdentity = async () => {
      started();
      await held;
      return "1:1";
    };
    const { watches, taken } = openWatches(root, {}, identity);

    const ensuring = watches.ensure();
    await reading;
    await watches.close();
    release();
    await ensuring;

    expect([...taken.keys()]).toEqual([]);
  });

  it("takes no tasks watch when it is closed while it looks for the tasks directory", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const taken = new Map<string, Fake>();
    const paths = projectPaths({ project: PROJECT, root });
    // The close lands where nothing else can put it: the moment the project
    // watch is taken, which is while the tasks name is still being read.
    const watches: Watches = new Watches(
      paths,
      QUIET,
      (path, listener) => {
        const fake = new Fake(listener);
        taken.set(path, fake);
        // After the watcher is held, and so before the read of the tasks name
        // that follows it can answer.
        queueMicrotask(() => void watches.close());
        return fake as unknown as FSWatcher;
      },
    );

    await watches.ensure();

    expect([...taken.keys()]).toEqual([projectDir(root)]);
    expect(taken.get(projectDir(root))?.closed).toBe(1);
  });

  it("takes the project watch again on a project directory that was replaced", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const { watches, taken } = openWatches(root);
    await watches.ensure();
    const first = taken.get(projectDir(root));

    // A watcher on a directory that was unlinked raises no error: it goes quiet,
    // so the name holding another directory is the whole signal.
    await rm(projectDir(root), { recursive: true });
    await mkdir(tasksDir(root), { recursive: true });
    await watches.ensure();

    expect(first?.closed).toBe(1);
    expect(taken.get(projectDir(root))).not.toBe(first);
    await watches.close();
  });

  it("reads one file for several events on it", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const applied: string[] = [];
    const { watches, taken } = openWatches(root, { onTask: (file) => void applied.push(file.id) });
    await watches.ensure();

    for (const event of ["rename", "change", "change"]) taken.get(tasksDir(root))?.change("SAGA-1.md", event);
    await until(() => applied.length > 0, "the events were applied");

    expect(applied).toEqual(["SAGA-1"]);
    await watches.close();
  });

  it.each(["notes.md", ".SAGA-1.md.abcd.tmp", "SAGA-x.md", "SAGA-1.txt"])("passes over the name %s", async (name) => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const applied: string[] = [];
    const { watches, taken } = openWatches(root, { onTask: (file) => void applied.push(file.id) });
    await watches.ensure();

    taken.get(tasksDir(root))?.change(name);
    taken.get(tasksDir(root))?.change("SAGA-1.md");
    await until(() => applied.length > 0, "the task file was applied");

    expect(applied).toEqual(["SAGA-1"]);
    await watches.close();
  });

  it("sweeps the directory once for a burst of events, whatever each one names", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const applied: string[] = [];
    const { watches, taken } = openWatches(root, {
      onTask: (file) => void applied.push(file.id),
      onUnnamedChange: () => void applied.push("sweep"),
    });
    await watches.ensure();

    for (const name of [".SAGA-1.md.tmp", null, "notes.md", "SAGA-1.md"]) taken.get(tasksDir(root))?.change(name, "rename");
    await until(() => applied.length === 2, "the event and the sweep were handed on");

    expect(applied.sort()).toEqual(["SAGA-1", "sweep"]);
    await watches.close();
  });

  it("passes over an event that names no file", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const applied: string[] = [];
    const { watches, taken } = openWatches(root, { onTask: (file) => void applied.push(file.id) });
    await watches.ensure();

    taken.get(tasksDir(root))?.change(null);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(applied).toEqual([]);
    await watches.close();
  });

  it("reports a tasks directory that appeared, under a name of something else", async () => {
    const root = await tempRoot();
    const moved: number[] = [];
    const { watches, taken } = openWatches(root, { onTasksDirectory: () => void moved.push(1) });
    await watches.ensure();

    // The name an event of the project directory carries says nothing about
    // whether the tasks directory moved, so every one of them is read for it.
    await mkdir(tasksDir(root), { recursive: true });
    taken.get(projectDir(root))?.change("config.yml", "rename");
    await until(() => moved.length > 0, "the new tasks directory was reported");

    expect(moved).toEqual([1]);
    await watches.close();
  });

  it("reports a tasks directory the project directory took with it", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const moved: number[] = [];
    const { watches, taken } = openWatches(root, { onTasksDirectory: () => void moved.push(1) });
    await watches.ensure();

    // A project directory that goes away takes its tasks directory with it, and
    // nothing inside it moved, so the operating system reports the watched
    // directory under its own name.
    await rm(projectDir(root), { recursive: true });
    taken.get(projectDir(root))?.change(PROJECT, "rename");
    await until(() => moved.length > 0, "the lost tasks directory was reported");

    expect(moved).toEqual([1]);
    await watches.close();
  });

  it("reports a tasks directory an event of the project directory named nothing of", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const moved: number[] = [];
    const { watches, taken } = openWatches(root, { onTasksDirectory: () => void moved.push(1) });
    await watches.ensure();

    // A platform that reports no name still says that something changed, and
    // reading what the tasks name holds needs no name to run.
    await rm(tasksDir(root), { recursive: true });
    taken.get(projectDir(root))?.change(null, "rename");
    await until(() => moved.length > 0, "the lost tasks directory was reported");

    expect(moved).toEqual([1]);
    await watches.close();
  });

  it("passes over a change under a tasks directory that is still there", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const moved: number[] = [];
    const { watches, taken } = openWatches(root, { onTasksDirectory: () => void moved.push(1) });
    await watches.ensure();

    // Every change under `tasks/` reaches the project directory under the name
    // of the directory itself, so the name says nothing on its own.
    taken.get(projectDir(root))?.change("tasks", "rename");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(moved).toEqual([]);
    await watches.close();
  });

  it("reports a tasks directory that another one replaced inside one debounce", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const moved: number[] = [];
    const { watches, taken } = openWatches(root, { onTasksDirectory: () => void moved.push(1) });
    await watches.ensure();
    const first = taken.get(tasksDir(root));

    // The removal and the creation coalesce into one event, so the name holds a
    // directory before and after it and presence alone reports nothing.
    await rm(tasksDir(root), { recursive: true });
    await mkdir(tasksDir(root), { recursive: true });
    taken.get(projectDir(root))?.change("tasks", "rename");
    await until(() => moved.length > 0, "the replaced tasks directory was reported");

    expect(moved).toEqual([1]);
    // The watch stood on the directory that was unlinked, which reports nothing
    // further, so the next `ensure` has to take it again.
    expect(first?.closed).toBe(1);
    await watches.ensure();
    expect(taken.get(tasksDir(root))).not.toBe(first);
    await watches.close();
  });

  it("reports a tasks directory that came and went inside one debounce", async () => {
    const root = await tempRoot();
    const moved: number[] = [];
    const { watches, taken } = openWatches(root, { onTasksDirectory: () => void moved.push(1) });
    await watches.ensure();

    // The creation and the removal coalesce into one event, so the name holds no
    // directory either side of it, and the identity the read finds is the one
    // the absent directory was recorded under.
    await mkdir(tasksDir(root), { recursive: true });
    taken.get(projectDir(root))?.change("tasks", "rename");
    await rm(tasksDir(root), { recursive: true });
    taken.get(projectDir(root))?.change("tasks", "rename");
    await until(() => moved.length > 0, "the lost tasks directory was reported");

    expect(moved).toEqual([1]);
    await watches.close();
  });

  it("takes the watch again on a tasks directory replaced while it looked for one", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const { watches, taken } = openWatches(root);
    await watches.ensure();
    const first = taken.get(tasksDir(root));

    // The event stands in its debounce while a rescan runs, and the watcher
    // stands on the directory that was unlinked, which reports nothing further.
    await rm(tasksDir(root), { recursive: true });
    await mkdir(tasksDir(root), { recursive: true });
    taken.get(projectDir(root))?.change("tasks", "rename");
    await watches.ensure();

    expect(first?.closed).toBe(1);
    expect(taken.get(tasksDir(root))).not.toBe(first);
    await watches.close();
  });

  it("lets the newest read of the tasks name decide which watch stands", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const reading = new Promise<void>((resolve) => (started = resolve));
    let reads = 0;
    // The first read of the tasks name finds no directory and answers last, so
    // the watch the call behind it took must survive what that read found.
    const identity: ReadIdentity = async (path) => {
      if (path !== tasksDir(root)) return "1:1";
      reads += 1;
      if (reads > 1) return "1:2";
      started();
      await held;
      return undefined;
    };
    const { watches, taken } = openWatches(root, {}, identity);

    const first = watches.ensure();
    await reading;
    const second = watches.ensure();
    // A turn of the loop, so a call that does not wait for the one in flight has
    // run to its end before that one answers.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([first, second]);

    expect(taken.get(tasksDir(root))?.closed).toBe(0);
    await watches.close();
  });

  it("takes the watches on the call behind one whose read of a name failed", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    let reads = 0;
    const identity: ReadIdentity = async (path) => {
      reads += 1;
      if (reads === 1) throw new Error("the directory could not be read");
      return path === tasksDir(root) ? "1:2" : "1:1";
    };
    const { watches, taken } = openWatches(root, {}, identity);

    await expect(watches.ensure()).rejects.toThrow("the directory could not be read");
    await watches.ensure();

    expect([...taken.keys()]).toEqual([projectDir(root), tasksDir(root)]);
    await watches.close();
  });

  it("reports a tasks directory it cannot read at all", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const seen = listener();
    const { watches, taken } = openWatches(root, { onFailure: seen.on });
    await watches.ensure();

    await chmod(projectDir(root), 0o000);
    onTestFinished(() => chmod(projectDir(root), 0o755));
    taken.get(projectDir(root))?.change("tasks", "rename");
    await until(() => seen.seen.length > 0, "the unreadable directory was reported");

    expect(seen.codes()).toEqual(["index-watch-failed"]);
    await watches.close();
  });

  it("drops a watch that failed, and takes it again on the next scan", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    const seen = listener();
    const { watches, taken } = openWatches(root, { onFailure: seen.on });
    await watches.ensure();
    const first = taken.get(tasksDir(root));

    first?.emit("error", new Error("the queue overflowed"));
    await watches.ensure();

    expect(seen.codes()).toEqual(["index-watch-failed"]);
    expect(seen.seen[0]?.path).toBe(tasksDir(root));
    expect(first?.closed).toBe(1);
    expect(taken.get(tasksDir(root))).not.toBe(first);
    await watches.close();
  });

  it("reports a directory it cannot watch at all", async () => {
    const root = await tempRoot();
    const seen = listener();
    const paths = projectPaths({ project: PROJECT, root });
    const watches = new Watches(paths, { ...QUIET, onFailure: seen.on }, () => {
      throw new Error("too many open files");
    });

    await watches.ensure();

    expect(seen.codes()).toEqual(["index-watch-failed"]);
    expect(seen.seen[0]?.message).toContain("too many open files");
    await watches.close();
  });

  it("cuts what it quotes of a fault down to a length its message can carry", async () => {
    const root = await tempRoot();
    const seen = listener();
    const paths = projectPaths({ project: PROJECT, root });
    const watches = new Watches(paths, { ...QUIET, onFailure: seen.on }, () => {
      throw new Error(`one\ntwo${"x".repeat(4000)}`);
    });

    await watches.ensure();

    expect(seen.seen[0]?.message.length).toBeLessThan(300);
    expect(seen.seen[0]?.message).not.toContain("\n");
    await watches.close();
  });
});
