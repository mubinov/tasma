import { execFileSync, spawn } from "node:child_process";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import type { IndexChange } from "../../src/index-cache/types.js";
import type { WatchOpen } from "../../src/index-cache/watch.js";
import { type ReadTree, readTree, type TreeArea, type TreeChange, WHOLE_TREE } from "../../src/tree/state.js";
import { openTree, type TreeWatch } from "../../src/tree/watch.js";
import { plant, projectConfig, projectDir, projectsRoot, taskFile, tasksDir, taskText, userConfig } from "../store/helpers.js";
import { Fake, HAS_BUN, nudge, until } from "../index-cache/helpers.js";
import { plantWorkflow, workflowDir, workflowFile } from "../workflow/helpers.js";

/** A `WatchOpen` that hands out fakes, and every fake it took by path, oldest first. */
function fakes(refuse: (path: string) => boolean = () => false): {
  open: WatchOpen;
  taken: Map<string, Fake[]>;
  latest: (path: string) => Fake;
} {
  const taken = new Map<string, Fake[]>();
  const open: WatchOpen = (path, listener) => {
    if (refuse(path)) throw new Error("too many open files");
    const fake = new Fake(listener);
    taken.set(path, [...(taken.get(path) ?? []), fake]);
    return fake as unknown as FSWatcher;
  };
  const latest = (path: string): Fake => {
    const fake = taken.get(path)?.at(-1);
    if (fake === undefined) throw new Error(`no watch was taken on ${path}`);
    return fake;
  };
  return { open, taken, latest };
}

/** A read of the tree that records the area of each read. */
function counting(): { read: ReadTree; areas: TreeArea[] } {
  const areas: TreeArea[] = [];
  const read: ReadTree = (root, area, last) => {
    areas.push(last === undefined ? WHOLE_TREE : area);
    return readTree(root, area, last);
  };
  return { read, areas };
}

/** The watch paths that hold an open fake. */
function openPaths(taken: Map<string, Fake[]>): string[] {
  return [...taken].filter(([, list]) => list.at(-1)?.closed === 0).map(([path]) => path).sort();
}

/** Whether the list holds this item. */
function saw<T>(list: T[], item: T): boolean {
  return list.some((seen) => isDeepStrictEqual(seen, item));
}

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tree watch closed when the test ends, and the changes it reported. */
async function watching(
  root: string,
  options: { open?: WatchOpen; read?: ReadTree; limit?: number; onChange?: (change: TreeChange) => void } = {},
): Promise<{ tree: TreeWatch; changes: TreeChange[] }> {
  const changes: TreeChange[] = [];
  const tree = await openTree({
    root,
    open: options.open,
    read: options.read,
    limit: options.limit,
    onChange: options.onChange ?? ((change) => void changes.push(change)),
  });
  onTestFinished(() => tree.close());
  return { tree, changes };
}

describe("the watches of a tree", () => {
  it("watches the root, projects/, each project, the workflows folder and each workflow folder", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    await plantWorkflow(root, "flow", "steps: []\n");
    await mkdir(workflowDir(root, "draft"));
    const { open, taken } = fakes();

    await watching(root, { open });

    expect(openPaths(taken)).toEqual([
      root,
      join(root, "projects"),
      projectDir(root, "ACME"),
      projectDir(root, "SAGA"),
      join(root, "workflows"),
      workflowDir(root, "draft"),
      workflowDir(root, "flow"),
    ].sort());
  });

  it("reports nothing for the baseline", async () => {
    const root = await projectsRoot("SAGA");
    await plant(userConfig(root), "priorities: [high]\n");

    const { changes } = await watching(root, { open: fakes().open });

    expect(changes).toEqual([]);
  });

  it("reads the area of one folder once for a burst of its events, whatever names they carry", async () => {
    const root = await projectsRoot("SAGA");
    const { open, latest } = fakes();
    const { read, areas } = counting();
    const { changes } = await watching(root, { open, read });
    areas.length = 0;

    await plant(projectConfig(root), "name: Saga\n");
    for (const name of [null, "config.yml", ".config.yml.0a1b.tmp", "tasks", "SAGA"]) latest(projectDir(root)).change(name);
    await until(() => changes.length > 0, "the edit was reported");
    await settle();

    expect(areas).toEqual([{ kind: "project", tag: "SAGA" }]);
    expect(changes).toEqual([{ kind: "project", tag: "SAGA", change: "changed" }]);
  });

  it("reads the area of a new folder once more after it takes the first watch on it", async () => {
    const root = await projectsRoot("SAGA");
    const { open, latest } = fakes();
    const { read, areas } = counting();
    const { changes } = await watching(root, { open, read });
    areas.length = 0;

    await mkdir(projectDir(root, "ACME"));
    latest(join(root, "projects")).change("ACME");
    await until(() => areas.length === 2, "the new folder was read again");
    await settle();

    expect(areas).toEqual([{ kind: "projects" }, { kind: "project", tag: "ACME" }]);
    expect(changes).toEqual([{ kind: "project", tag: "ACME", change: "created" }]);
    expect(latest(projectDir(root, "ACME")).closed).toBe(0);
  });

  it("takes a watch that failed again at the next rescan, with no extra read", async () => {
    const root = await projectsRoot("SAGA");
    let refused = 0;
    const { open, taken } = fakes((path) => path === projectDir(root) && refused++ < 2);
    const { read, areas } = counting();
    const { tree } = await watching(root, { open, read });
    expect(taken.has(projectDir(root))).toBe(false);
    areas.length = 0;

    await tree.rescan();

    expect(openPaths(taken)).toContain(projectDir(root));
    expect(areas).toEqual([WHOLE_TREE]);
  });

  it("drops a watch that emits an error and takes it again at the next read, with no extra read", async () => {
    const root = await projectsRoot("SAGA");
    const { open, latest, taken } = fakes();
    const { read, areas } = counting();
    const { changes } = await watching(root, { open, read });
    const first = latest(join(root, "projects"));
    areas.length = 0;

    first.emit("error", new Error("the queue overflowed"));
    await plant(userConfig(root), "priorities: [high]\n");
    latest(root).change("config.yml");
    await until(() => changes.length > 0, "the edit was reported");
    await settle();

    expect(first.closed).toBe(1);
    expect(taken.get(join(root, "projects"))).toHaveLength(2);
    expect(latest(join(root, "projects")).closed).toBe(0);
    expect(areas).toEqual([WHOLE_TREE]);
  });

  it("takes a new watch on each folder that another one replaced, with no extra read", async () => {
    const root = await projectsRoot("SAGA");
    await plantWorkflow(root, "flow", "steps: []\n");
    const { open, latest, taken } = fakes();
    const { read, areas } = counting();
    const { tree } = await watching(root, { open, read });
    const folders = [root, join(root, "projects"), join(root, "workflows"), workflowDir(root, "flow")];
    const before = folders.map((path) => latest(path));
    areas.length = 0;

    const old = `${root}.old`;
    onTestFinished(() => rm(old, { recursive: true, force: true }));
    await rename(root, old);
    await mkdir(root);
    await mkdir(join(root, "projects"));
    await rename(join(old, "projects", "SAGA"), projectDir(root));
    await mkdir(workflowDir(root, "flow"), { recursive: true });
    await rename(join(old, "workflows", "flow", "workflow.yml"), workflowFile(root, "flow"));
    await tree.rescan();

    expect(before.map((fake) => fake.closed)).toEqual([1, 1, 1, 1]);
    expect(folders.map((path) => latest(path).closed)).toEqual([0, 0, 0, 0]);
    expect(areas).toEqual([WHOLE_TREE]);
    // A late error of a watch that was replaced leaves the new one standing.
    for (const fake of before) fake.emit("error", new Error("the folder is gone"));
    await tree.rescan();
    expect(folders.map((path) => taken.get(path)?.length)).toEqual([2, 2, 2, 2]);
  });

  it("follows the projects and the workflow folders that come and go", async () => {
    const root = await projectsRoot("SAGA");
    const { open, taken } = fakes();
    const { tree } = await watching(root, { open });

    await mkdir(projectDir(root, "ACME"));
    await mkdir(workflowDir(root, "draft"), { recursive: true });
    await tree.rescan();
    expect(openPaths(taken)).toEqual(
      [root, join(root, "projects"), projectDir(root, "ACME"), projectDir(root), join(root, "workflows"), workflowDir(root, "draft")].sort(),
    );

    await rm(projectDir(root, "ACME"), { recursive: true });
    await rm(workflowDir(root, "draft"), { recursive: true });
    await tree.rescan();
    expect(openPaths(taken)).toEqual([root, join(root, "projects"), projectDir(root), join(root, "workflows")].sort());
  });

  it("takes no more watches than its limit, the lists first, and reads the folders past it at a rescan", async () => {
    const root = await projectsRoot("ACME", "BETA", "CORE");
    await plantWorkflow(root, "flow", "steps: []\n");
    const { open, taken } = fakes();
    const { tree, changes } = await watching(root, { open, limit: 4 });
    const lists = [root, join(root, "projects"), join(root, "workflows")];
    expect(openPaths(taken)).toEqual([...lists, projectDir(root, "ACME")].sort());

    await plant(projectConfig(root, "CORE"), "name: Core\n");
    await tree.rescan();
    expect(changes).toEqual([{ kind: "project", tag: "CORE", change: "changed" }]);

    await rm(projectDir(root, "ACME"), { recursive: true });
    await tree.rescan();
    expect(openPaths(taken)).toEqual([...lists, projectDir(root, "BETA")].sort());
  });

  it("takes no watch on a path that holds no folder by the time the watch is taken", async () => {
    const root = await projectsRoot("SAGA");
    const fifo = join(root, "fifo");
    let swap = false;
    const read: ReadTree = async (at, area, last) => {
      const state = await readTree(at, area, last);
      if (swap) {
        swap = false;
        await rm(projectDir(root, "ACME"), { recursive: true });
        execFileSync("mkfifo", [projectDir(root, "ACME")]);
        await rm(workflowDir(root, "draft"), { recursive: true });
        execFileSync("mkfifo", [fifo]);
        await symlink(fifo, workflowDir(root, "draft"));
      }
      return state;
    };
    const { open, taken } = fakes();
    const { tree, changes } = await watching(root, { open, read });

    await mkdir(projectDir(root, "ACME"));
    await mkdir(workflowDir(root, "draft"), { recursive: true });
    swap = true;
    await tree.rescan();

    expect(taken.has(projectDir(root, "ACME"))).toBe(false);
    expect(taken.has(workflowDir(root, "draft"))).toBe(false);
    expect(changes).toEqual([
      { kind: "project", tag: "ACME", change: "created" },
      { kind: "project", tag: "ACME", change: "deleted" },
    ]);
  });

  it("keeps at most one read of an area waiting behind the read in flight", async () => {
    const root = await projectsRoot("SAGA");
    let release!: () => void;
    let hold: Promise<void> | undefined;
    const areas: TreeArea[] = [];
    const read: ReadTree = async (at, area, last) => {
      areas.push(last === undefined ? WHOLE_TREE : area);
      const gate = hold;
      hold = undefined;
      await gate;
      return readTree(at, area, last);
    };
    const { open, latest } = fakes();
    const { tree } = await watching(root, { open, read });
    areas.length = 0;

    hold = new Promise((resolve) => (release = resolve));
    const first = tree.rescan();
    for (let round = 0; round < 3; round += 1) {
      latest(projectDir(root)).change("config.yml");
      await settle(150);
    }
    const again = [tree.rescan(), tree.rescan()];
    release();
    await Promise.all([first, ...again]);
    await settle();

    expect(areas).toEqual([WHOLE_TREE, { kind: "project", tag: "SAGA" }, WHOLE_TREE]);
  });

  it("runs one read at a time, so each one compares with the state the last one left", async () => {
    const root = await projectsRoot("SAGA");
    let running = 0;
    let most = 0;
    const read: ReadTree = async (at, area, last) => {
      running += 1;
      most = Math.max(most, running);
      await settle(20);
      try {
        return await readTree(at, area, last);
      } finally {
        running -= 1;
      }
    };
    const { tree, changes } = await watching(root, { open: fakes().open, read });

    await plant(userConfig(root), "priorities: [high]\n");
    await Promise.all([tree.rescan(), tree.rescan(), tree.rescan()]);

    expect(most).toBe(1);
    expect(changes).toEqual([{ kind: "config" }]);
  });

  it("reports what a read that threw would have found at the read after it", async () => {
    const root = await projectsRoot("SAGA");
    let fail = false;
    const read: ReadTree = (at, area, last) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("a defect"));
      }
      return readTree(at, area, last);
    };
    const { tree, changes } = await watching(root, { open: fakes().open, read });

    await plant(userConfig(root), "priorities: [high]\n");
    fail = true;
    await tree.rescan();
    expect(changes).toEqual([]);
    await tree.rescan();

    expect(changes).toEqual([{ kind: "config" }]);
  });

  it("starts with no watch when the baseline read throws, and takes them at the next rescan", async () => {
    const root = await projectsRoot("SAGA");
    let fail = true;
    const read: ReadTree = (at, area, last) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("a defect"));
      }
      return readTree(at, area, last);
    };
    const { open, taken } = fakes();
    const { tree, changes } = await watching(root, { open, read });
    expect(openPaths(taken)).toEqual([]);

    await tree.rescan();

    expect(openPaths(taken)).toContain(projectDir(root));
    expect(changes).toEqual([]);
  });

  it("reports no change after close resolves, also from a read in flight", async () => {
    const root = await projectsRoot("SAGA");
    let release!: () => void;
    let started!: () => void;
    let hold = false;
    const held = new Promise<void>((resolve) => (release = resolve));
    const reading = new Promise<void>((resolve) => (started = resolve));
    const read: ReadTree = async (at, area, last) => {
      if (hold) {
        started();
        await held;
      }
      return readTree(at, area, last);
    };
    const { open, latest, taken } = fakes();
    const { tree, changes } = await watching(root, { open, read });

    await plant(userConfig(root), "priorities: [high]\n");
    hold = true;
    const rescan = tree.rescan();
    await reading;
    latest(root).change("config.yml");
    let closed = false;
    const closing = tree.close().then(() => (closed = true));
    await settle(20);
    expect(closed).toBe(false);
    release();
    await closing;
    await rescan;
    await settle();

    expect(changes).toEqual([]);
    expect([...taken.values()].every((list) => list.every((fake) => fake.closed === 1))).toBe(true);
  });

  it("starts no read after close, for an event or for a rescan", async () => {
    const root = await projectsRoot("SAGA");
    const { open, latest } = fakes();
    const { read, areas } = counting();
    const { tree, changes } = await watching(root, { open, read });
    areas.length = 0;

    await tree.close();
    await plant(userConfig(root), "priorities: [high]\n");
    latest(root).change("config.yml");
    await tree.rescan();
    await settle();

    expect(areas).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("goes on to the next change when the listener throws", async () => {
    const root = await projectsRoot();
    const seen: TreeChange[] = [];
    const { tree } = await watching(root, {
      open: fakes().open,
      onChange: (change) => {
        seen.push(change);
        throw new Error("the listener failed");
      },
    });

    await plant(userConfig(root), "priorities: [high]\n");
    await mkdir(projectDir(root, "SAGA"), { recursive: true });
    await tree.rescan();

    expect(seen).toEqual([{ kind: "config" }, { kind: "project", tag: "SAGA", change: "created" }]);
  });
});

// The watch is proved on events alone: that each kind of hand edit arrives
// without a rescan. A watch of the operating system can drop the first changes
// that follow it, so each change is made again while the test waits.
describe("the tree watch on the file system", { timeout: 8000, retry: 3 }, () => {
  it("reports a project folder that is made and one that is removed", async () => {
    const root = await projectsRoot("SAGA");
    const { changes } = await watching(root);
    const touch = nudge(join(root, "projects"));

    await until(() => saw(changes, { kind: "project", tag: "ACME", change: "created" }), "the new project was reported", async () => {
      await mkdir(projectDir(root, "ACME"), { recursive: true });
      await touch();
    });
    await until(() => saw(changes, { kind: "project", tag: "ACME", change: "deleted" }), "the removed project was reported", async () => {
      await rm(projectDir(root, "ACME"), { recursive: true, force: true });
      await touch();
    });
  });

  it("reports a hand rename of a project folder as a delete and a create", async () => {
    const root = await projectsRoot("SAGA");
    const { changes } = await watching(root);
    const touch = nudge(join(root, "projects"));

    await until(
      () => saw(changes, { kind: "project", tag: "SAGA", change: "deleted" }) && saw(changes, { kind: "project", tag: "ACME", change: "created" }),
      "the rename was reported",
      async () => {
        if (existsSync(projectDir(root))) await rename(projectDir(root), projectDir(root, "ACME"));
        else await touch();
      },
    );
  });

  it("reports an edit of a project config.yml and of the root config.yml", async () => {
    const root = await projectsRoot("SAGA");
    const { changes } = await watching(root);
    let round = 0;

    await until(() => saw(changes, { kind: "project", tag: "SAGA", change: "changed" }), "the project edit was reported", () =>
      writeFile(projectConfig(root), `name: Saga ${++round}\n`),
    );
    await until(() => saw(changes, { kind: "config" }), "the root edit was reported", () =>
      writeFile(userConfig(root), `priorities: [p${++round}]\n`),
    );
  });

  it("reports a tasks folder that a hand edit removed", async () => {
    const root = await projectsRoot("SAGA");
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));
    const { changes } = await watching(root);
    const touch = nudge(projectDir(root));

    await until(() => saw(changes, { kind: "project", tag: "SAGA", change: "changed" }), "the lost tasks folder was reported", async () => {
      await rm(tasksDir(root), { recursive: true, force: true });
      await touch();
    });
  });

  it("reports a workflow whose folder comes first and whose workflow.yml is written later, with no rescan", async () => {
    const root = await projectsRoot();
    await mkdir(join(root, "workflows"));
    const opened: string[] = [];
    const { changes } = await watching(root, {
      open: (path, listener) => {
        opened.push(path);
        return watch(path, listener);
      },
    });
    const touch = nudge(join(root, "workflows"));
    let round = 0;

    // The touch of the workflows folder repeats only until the new folder is
    // watched: after that, only the watch on the new folder can hear its file.
    await until(() => opened.includes(workflowDir(root, "flow")), "the new workflow folder was watched", async () => {
      await mkdir(workflowDir(root, "flow"), { recursive: true });
      await touch();
    });
    await until(() => saw(changes, { kind: "workflow", name: "flow", change: "created" }), "the new workflow was reported", () =>
      writeFile(workflowFile(root, "flow"), `title: Flow ${++round}\nsteps: []\n`),
    );
    await until(() => saw(changes, { kind: "workflow", name: "flow", change: "changed" }), "the workflow edit was reported", () =>
      writeFile(workflowFile(root, "flow"), `title: Flow ${++round}\nsteps: []\n`),
    );
  });
});

/** A line the `bun` process printed: a change of the tree watch, or a change of the index beside it. */
type BunLine = { tree: TreeChange } | { index: IndexChange };

/**
 * A tree watch over the temp tree inside a `bun` process, with an index over
 * one project when a tag is given. The lines it printed so far, and a way to
 * close the tree watch and open it again.
 */
async function watchingUnderBun(
  root: string,
  tag?: string,
): Promise<{ lines: BunLine[]; reopen: () => Promise<void> }> {
  const script = fileURLToPath(new URL("under-bun.ts", import.meta.url));
  const child = spawn("bun", [script, root, ...(tag === undefined ? [] : [tag])], { stdio: ["pipe", "pipe", "inherit"] });
  onTestFinished(() => {
    child.stdin.end();
    child.kill();
  });
  const lines: BunLine[] = [];
  const waiting = new Map<string, () => void>();
  let pending = "";
  const ready = new Promise<void>((resolve, reject) => {
    waiting.set("ready", resolve);
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`bun exited with ${String(code)} before the tree watch was open`)));
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    const split = pending.split("\n");
    pending = split.pop() ?? "";
    for (const line of split) {
      const resolve = waiting.get(line);
      if (resolve === undefined) {
        lines.push(JSON.parse(line) as BunLine);
        continue;
      }
      waiting.delete(line);
      resolve();
    }
  });
  await ready;
  return {
    lines,
    reopen: () => {
      const reopened = new Promise<void>((resolve) => waiting.set("reopened", resolve));
      child.stdin.write("reopen\n");
      return reopened;
    },
  };
}

describe("the tree watch under Bun", { timeout: 8000, retry: 3 }, () => {
  it("reports a config.yml saved through a rename and a rename of a project folder", async (ctx) => {
    if (!HAS_BUN) ctx.skip("bun is not on PATH");
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root), "name: Saga\n");
    const { lines } = await watchingUnderBun(root);
    const touch = nudge(join(root, "projects"));
    let round = 0;
    const temp = join(projectDir(root), ".config.yml.0a1b.tmp");

    await until(() => saw(lines, { tree: { kind: "project", tag: "SAGA", change: "changed" } }), "the saved config was reported", async () => {
      await writeFile(temp, `name: Saga ${++round}\n`);
      await rename(temp, projectConfig(root));
    });
    await until(
      () =>
        saw(lines, { tree: { kind: "project", tag: "SAGA", change: "deleted" } })
        && saw(lines, { tree: { kind: "project", tag: "ACME", change: "created" } }),
      "the rename was reported",
      async () => {
        if (existsSync(projectDir(root))) await rename(projectDir(root), projectDir(root, "ACME"));
        else await touch();
      },
    );
  });

  // The project has no tasks folder, so the watch on the project folder is the
  // one watch the index holds, and the only one that can report the new task.
  it("leaves the index watch on a project folder live when the tree watch is closed and opened again", async (ctx) => {
    if (!HAS_BUN) ctx.skip("bun is not on PATH");
    const root = await projectsRoot("SAGA");
    const { lines, reopen } = await watchingUnderBun(root, "SAGA");

    await reopen();
    await plant(taskFile(root, "SAGA-1"), taskText("SAGA-1"));

    await until(() => saw(lines, { index: { id: "SAGA-1", change: "created" } }), "the index reported the new task", nudge(projectDir(root)));
  });
});
