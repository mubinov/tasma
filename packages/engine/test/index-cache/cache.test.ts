import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { StoreDiagnostic } from "@tasma/engine";
import { TaskIndex } from "../../src/index-cache/cache.js";
import { FRONTMATTER_CAP, openTaskFile } from "../../src/index-cache/frontmatter.js";
import { projectPaths } from "../../src/store/paths.js";
import { plant, PROJECT, projectDir, taskFile, tasksDir, taskText, tempRoot } from "../store/helpers.js";
import { BOM, ids, listener, taskEntry } from "./helpers.js";

function index(root: string, on?: (diagnostic: StoreDiagnostic) => void): TaskIndex {
  return new TaskIndex(projectPaths({ project: PROJECT, root }), on);
}

/**
 * An index whose read of one file stops where the test puts it, so what happens
 * to the project while a read stands there is decided by the test rather than by
 * the scheduler.
 *
 * `stop` is what the read has done when it waits: at `"open"` the file is not
 * open yet, so the open itself lands after whatever the test did; at `"read"`
 * the handle already stands on the file the name held before it.
 */
function holding(
  root: string,
  stop: "open" | "read",
  on?: (diagnostic: StoreDiagnostic) => void,
): { cache: TaskIndex; reading: Promise<void>; release: () => void } {
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const reading = new Promise<void>((resolve) => (started = resolve));
  const cache = new TaskIndex(projectPaths({ project: PROJECT, root }), on, async (path) => {
    if (stop === "open") {
      started();
      await held;
    }
    const source = await openTaskFile(path);
    if (stop === "read") {
      started();
      await held;
    }
    return source;
  });
  return { cache, reading, release };
}

/** A built index over the temp tree, which is what almost every test starts from. */
async function built(root: string, on?: (diagnostic: StoreDiagnostic) => void): Promise<TaskIndex> {
  const cache = index(root, on);
  await cache.reconcile();
  return cache;
}

/**
 * An index that records how many reads of a task file stood open at one moment.
 *
 * `readers` is how many files a scan a caller waits on applies at once. Set
 * under the gate that bounds the reads, it is what tells the bound on the
 * applies from no bound at all: the gate would admit eight of them either way.
 */
function counting(root: string, readers?: number): { cache: TaskIndex; peak: () => number } {
  let open = 0;
  let peak = 0;
  const cache = new TaskIndex(
    projectPaths({ project: PROJECT, root }),
    undefined,
    async (path) => {
      open += 1;
      peak = Math.max(peak, open);
      try {
        // A turn of the loop, so a read that started beside this one is counted
        // before this one returns.
        await new Promise((resolve) => setTimeout(resolve, 0));
        return await openTaskFile(path);
      } finally {
        open -= 1;
      }
    },
    readers,
  );
  return { cache, peak: () => peak };
}

describe("the entries of the index", () => {
  it("holds one entry per task file, ordered by file number ascending", async () => {
    const root = await tempRoot();
    for (const id of ["TASM-10", "TASM-2", "TASM-1"]) await plant(taskFile(root, id), taskText(id));

    expect(ids(await built(root))).toEqual(["TASM-1", "TASM-2", "TASM-10"]);
  });

  it("carries the id, the path and the frontmatter of the file", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", "priority: high\n"));

    const [entry] = (await built(root)).query().entries;

    expect(entry).toEqual({
      id: "TASM-1",
      path: taskFile(root, "TASM-1"),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- an asymmetric matcher is typed `any`
      frontmatter: expect.objectContaining({ id: "TASM-1", title: "Planted", priority: "high" }),
    });
  });

  it("reads a file the whole parse refuses under the frontmatter", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), `${taskText("TASM-1")}\n<!-- task:comment {id: 1\n`);

    expect(ids(await built(root))).toEqual(["TASM-1"]);
  });

  it("hands out an entry no caller can change", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", "labels: [one]\n"));

    const [entry] = (await built(root)).query().entries;

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.frontmatter)).toBe(true);
    expect(Object.isFrozen(entry?.frontmatter.labels)).toBe(true);
  });

  it("answers each query with fresh arrays over the entries it holds", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const cache = await built(root);

    const first = cache.query();
    first.entries.length = 0;

    expect(cache.query().entries).toHaveLength(1);
    expect(cache.query().entries).not.toBe(first.entries);
  });

  it("holds no entry for a project whose tasks directory does not exist", async () => {
    const root = await tempRoot();
    const seen = listener();

    expect((await built(root, seen.on)).query()).toEqual({ entries: [], excluded: [] });
    expect(seen.codes()).toEqual([]);
  });
});

describe("the files the index excludes", () => {
  it("excludes a file that does not parse and reports it", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), "Not a task file.\n");
    const seen = listener();

    const result = (await built(root, seen.on)).query();

    expect(result.entries).toEqual([]);
    expect(result.excluded).toEqual([
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- an asymmetric matcher is typed `any`
      { path: taskFile(root, "TASM-1"), code: "task-file-unreadable", message: expect.stringContaining("---") },
    ]);
    expect(seen.codes()).toEqual(["task-file-unreadable"]);
    expect(seen.seen[0]?.path).toBe(taskFile(root, "TASM-1"));
  });

  it("carries the line of the fault to the listener", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1").replace("title: Planted", "title: [one]"));
    const seen = listener();
    await built(root, seen.on);

    expect(seen.seen[0]?.code).toBe("task-file-unreadable");
    expect(seen.seen[0]?.line).toBe(3);
  });

  it("excludes a file whose id names no task of this project", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("OTHER-1"));

    expect((await built(root)).query().excluded[0]?.code).toBe("task-file-foreign");
  });

  it("excludes a file whose id names another task of this project", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-9"));

    const [excluded] = (await built(root)).query().excluded;

    expect(excluded?.code).toBe("task-file-misnamed");
    expect(excluded?.message).toContain("TASM-9");
  });

  // A scan reads several files at a time, so the order they land in is the order
  // the reads finished in and not one the index chose. The answer is the sort
  // either way.
  it.each([
    ["by number", ["TASM-1", "TASM-2", "TASM-10"]],
    ["in reverse", ["TASM-10", "TASM-2", "TASM-1"]],
  ])("orders the excluded files by path ascending, having landed them %s", async (_name, landed) => {
    const root = await tempRoot();
    for (const id of landed) await plant(taskFile(root, id), "Not a task file.\n");
    const cache = index(root);
    for (const id of landed) await cache.apply(taskEntry(root, id));

    expect(cache.query().excluded.map((file) => file.path)).toEqual([
      taskFile(root, "TASM-1"),
      taskFile(root, "TASM-10"),
      taskFile(root, "TASM-2"),
    ]);
  });

  it("states why a file cannot be read without naming the class that refused it", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), "---\nid: TASM-1\n");

    const [excluded] = (await built(root)).query().excluded;

    expect(excluded?.message).not.toContain("TaskParseError");
    expect(excluded?.message).toContain(taskFile(root, "TASM-1"));
    expect(excluded?.message).toContain('the frontmatter has no closing "---" line');
  });

  it("cuts an id the file supplied down to a length a message can carry", async () => {
    const root = await tempRoot();
    const long = "x".repeat(4000);
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1").replace("id: TASM-1", `id: ${long}`));

    const [excluded] = (await built(root)).query().excluded;

    expect(excluded?.code).toBe("task-file-foreign");
    expect(excluded?.message.length).toBeLessThan(200);
  });

  it("cuts a reason as long as a file cared to make it", async () => {
    const root = await tempRoot();
    // An explicit key stands under no length rule of the library, so the key the
    // fault names runs as far as the file lets it.
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", `? "${"x".repeat(2000)}"\n: &loop [*loop]\n`));
    const seen = listener();

    const [excluded] = (await built(root, seen.on)).query().excluded;

    expect(excluded?.code).toBe("task-file-unreadable");
    expect(excluded?.message.length).toBeLessThan(300);
    expect(seen.seen[0]?.message.length).toBeLessThan(300);
  });

  it("keeps out of a message every character a file supplied that would end a line", async () => {
    const root = await tempRoot();
    // The newline a terminal breaks on, and the line and paragraph separators a
    // renderer that is not one breaks on.
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", '? "one\\ntwo\\u2028three\\u2029four"\n: &loop [*loop]\n'));

    const [excluded] = (await built(root)).query().excluded;

    expect(excluded?.message).toContain("one two three four");
    expect(excluded?.message).not.toMatch(/[\n\u2028\u2029]/);
  });

  it("cuts a value on a character rather than in the middle of one", async () => {
    const root = await tempRoot();
    const id = `x${"\u{1F600}".repeat(40)}`;
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1").replace("id: TASM-1", `id: "${id}"`));

    const [excluded] = (await built(root)).query().excluded;

    expect(excluded?.code).toBe("task-file-foreign");
    expect(excluded?.message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("excludes a file whose frontmatter stands past the cap, naming the bound it read to", async () => {
    const root = await tempRoot();
    // A region the writer of this engine produces without complaint: the write
    // path bounds a value by its depth and its node count, never by its text.
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", `note: ${"x".repeat(FRONTMATTER_CAP)}\n`));
    const seen = listener();

    const [excluded] = (await built(root, seen.on)).query().excluded;

    expect(excluded?.code).toBe("task-file-unreadable");
    expect(excluded?.message).toContain(`stands past the first ${FRONTMATTER_CAP} bytes`);
    expect(excluded?.message).not.toContain('no closing "---" line');
    // The bound is this reader's, not a line of the file, so the finding names none.
    expect(seen.seen[0]?.line).toBeUndefined();
  });

  it("excludes a file that opens with a byte-order mark, which no reader of it accepts", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), `${BOM}${taskText("TASM-1")}`);

    const [excluded] = (await built(root)).query().excluded;

    expect(excluded?.code).toBe("task-file-unreadable");
    expect(excluded?.message).toContain('the file must start with a "---" line');
  });

  it("excludes a file it may not read", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    await chmod(taskFile(root, "TASM-1"), 0o000);
    onTestFinished(() => chmod(taskFile(root, "TASM-1"), 0o600));
    const seen = listener();

    const excluded = (await built(root, seen.on)).query().excluded;

    expect(excluded[0]?.code).toBe("task-file-unreadable");
    expect(excluded[0]?.message).toContain("EACCES");
    expect(seen.seen[0]?.line).toBeUndefined();
  });

  it("keeps a temp file and a foreign markdown file out of the excluded set", async () => {
    const root = await tempRoot();
    await plant(join(tasksDir(root), ".TASM-1.md.abcd.tmp"), "half a write");
    await plant(join(tasksDir(root), "notes.md"), "notes");
    const seen = listener();

    expect((await built(root, seen.on)).query().excluded).toEqual([]);
    expect(seen.codes().sort()).toEqual(["task-file-unexpected", "temp-file-left"]);
  });
});

describe("what the index reports", () => {
  it("reports a file that is still broken for the same reason once", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), "Not a task file.\n");
    const seen = listener();
    const cache = await built(root, seen.on);

    await cache.reconcile();

    expect(seen.codes()).toEqual(["task-file-unreadable"]);
  });

  it("reports a file that broke for another reason again", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), "Not a task file.\n");
    const seen = listener();
    const cache = await built(root, seen.on);

    await plant(taskFile(root, "TASM-1"), taskText("OTHER-1"));
    await cache.reconcile();

    expect(seen.codes()).toEqual(["task-file-unreadable", "task-file-foreign"]);
  });

  it("reports a file that broke again after it was repaired", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), "Not a task file.\n");
    const seen = listener();
    const cache = await built(root, seen.on);

    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    await cache.reconcile();
    await plant(taskFile(root, "TASM-1"), "Not a task file.\n");
    await cache.reconcile();

    expect(seen.codes()).toEqual(["task-file-unreadable", "task-file-unreadable"]);
  });

  it("reports a temp file the last scan already named once", async () => {
    const root = await tempRoot();
    await plant(join(tasksDir(root), ".TASM-1.md.abcd.tmp"), "half a write");
    const seen = listener();
    const cache = await built(root, seen.on);

    await cache.reconcile();

    expect(seen.codes()).toEqual(["temp-file-left"]);
  });

  it("reports a temp file that came back after it was gone", async () => {
    const root = await tempRoot();
    const temp = join(tasksDir(root), ".TASM-1.md.abcd.tmp");
    await plant(temp, "half a write");
    const seen = listener();
    const cache = await built(root, seen.on);

    await rm(temp);
    await cache.reconcile();
    await plant(temp, "half a write");
    await cache.reconcile();

    expect(seen.codes()).toEqual(["temp-file-left", "temp-file-left"]);
  });

  it("names a file a scan found by the path it stands under", async () => {
    const root = await tempRoot();
    // A name is whatever its writer chose: it can drive a terminal and it can
    // run to the length of a name the filesystem accepts. What a finding names
    // is still the file, which a listener has to be able to open.
    const name = `one\rtwo${"x".repeat(200)}.md`;
    const path = join(tasksDir(root), name);
    await plant(path, "notes");
    const seen = listener();

    await built(root, seen.on);

    expect(seen.codes()).toEqual(["task-file-unexpected"]);
    expect(seen.seen[0]?.path).toBe(path);
  });

  it("reports a stray file that appeared beside one it already named", async () => {
    const root = await tempRoot();
    // Two names that no longer tell one file from the other once either is cut
    // to a length or stripped of the characters a name may hold.
    const first = join(tasksDir(root), `${"x".repeat(200)}one\rtwo.md`);
    const second = join(tasksDir(root), `${"x".repeat(200)}one two.md`);
    await plant(first, "notes");
    const seen = listener();
    const cache = await built(root, seen.on);

    await plant(second, "notes");
    await cache.reconcile();

    expect(seen.codes()).toEqual(["task-file-unexpected", "task-file-unexpected"]);
    expect(seen.seen.map((diagnostic) => diagnostic.path)).toEqual([first, second]);
  });

  it("keeps the map and the caller unharmed when a listener throws", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), "Not a task file.\n");
    await plant(taskFile(root, "TASM-2"), taskText("TASM-2"));

    const cache = await built(root, () => {
      throw new Error("the listener failed");
    });

    expect(ids(cache)).toEqual(["TASM-2"]);
    expect(cache.query().excluded).toHaveLength(1);
  });
});

describe("applying one path", () => {
  it("adds the file that appeared", async () => {
    const root = await tempRoot();
    const cache = await built(root);
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    await cache.apply(taskEntry(root, "TASM-1"));

    expect(ids(cache)).toEqual(["TASM-1"]);
  });

  it("replaces the entry of a file that changed", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const cache = await built(root);

    await plant(taskFile(root, "TASM-1"), taskText("TASM-1").replace("Planted", "Edited"));
    await cache.apply(taskEntry(root, "TASM-1"));

    expect(cache.query().entries[0]?.frontmatter.title).toBe("Edited");
  });

  it("drops the entry of a file that is gone, without reporting it", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const seen = listener();
    const cache = await built(root, seen.on);

    await rm(taskFile(root, "TASM-1"));
    await cache.apply(taskEntry(root, "TASM-1"));

    expect(cache.query().entries).toEqual([]);
    expect(seen.codes()).toEqual([]);
  });

  it("excludes a name that holds no regular file", async () => {
    const root = await tempRoot();
    const cache = await built(root);
    await mkdir(taskFile(root, "TASM-1"), { recursive: true });

    await cache.apply(taskEntry(root, "TASM-1"));

    expect(cache.query().excluded[0]?.code).toBe("task-file-unreadable");
  });

  it("drops the exclusion of a file that is gone", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), "Not a task file.\n");
    const cache = await built(root);

    await rm(taskFile(root, "TASM-1"));
    await cache.apply(taskEntry(root, "TASM-1"));

    expect(cache.query().excluded).toEqual([]);
  });

  it("lands no entry it read through a project directory a symbolic link replaced", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const seen = listener();
    const cache = await built(root, seen.on);

    // The open of a task file guards its own name alone, so a link above it is
    // followed and the read lands frontmatter from outside the tree.
    await plant(join(root, "outside", "tasks", "TASM-2.md"), taskText("TASM-2"));
    await rm(projectDir(root), { recursive: true });
    await symlink(join(root, "outside"), projectDir(root));
    await cache.apply(taskEntry(root, "TASM-2"));

    expect(cache.query()).toEqual({ entries: [], excluded: [] });
    expect(seen.codes()).toEqual(["tasks-directory-lost"]);
  });

  it("lands nothing it read while a symbolic link replaced the project directory", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    await plant(join(root, "outside", "tasks", "TASM-1.md"), taskText("TASM-1"));
    const seen = listener();
    const { cache, reading, release } = holding(root, "open", seen.on);

    // The check before the read passed, and the open of a task file guards its
    // own name alone, so the open that lands after the link is in place reaches
    // the tree the link points at rather than the one the caller named.
    const applying = cache.apply(taskEntry(root, "TASM-1"));
    await reading;
    await rm(projectDir(root), { recursive: true });
    await symlink(join(root, "outside"), projectDir(root));
    release();
    await applying;

    expect(cache.query()).toEqual({ entries: [], excluded: [] });
    expect(seen.codes()).toEqual(["tasks-directory-lost"]);
  });

  it("lands nothing it read from a tasks directory another one replaced", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const seen = listener();
    const { cache, reading, release } = holding(root, "read", seen.on);

    // The project is sound and the read succeeds, but its handle stands on a
    // directory that was unlinked while it ran, so what it returns is the
    // content of a file the name no longer holds.
    const applying = cache.apply(taskEntry(root, "TASM-1"));
    await reading;
    await rm(tasksDir(root), { recursive: true });
    await mkdir(tasksDir(root), { recursive: true });
    release();
    await applying;

    expect(cache.query().entries).toEqual([]);
    expect(seen.codes()).toEqual([]);
  });

  it("lets the last request decide when two applies overlap", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const cache = await built(root);

    const first = cache.apply(taskEntry(root, "TASM-1"));
    await writeFile(taskFile(root, "TASM-1"), taskText("TASM-1").replace("Planted", "Last"), "utf8");
    const second = cache.apply(taskEntry(root, "TASM-1"));
    await Promise.all([first, second]);

    expect(cache.query().entries[0]?.frontmatter.title).toBe("Last");
  });
});

describe("reconciling the whole directory", () => {
  it("reads several files at a time for a scan a caller waits on", async () => {
    const root = await tempRoot();
    for (const id of ["TASM-1", "TASM-2", "TASM-3"]) await plant(taskFile(root, id), taskText(id));
    const { cache, peak } = counting(root);

    await cache.reconcile();

    expect(peak()).toBeGreaterThan(1);
    expect(ids(cache)).toEqual(["TASM-1", "TASM-2", "TASM-3"]);
  });

  it("holds no more of a scan in flight than it reads files at a time", async () => {
    const root = await tempRoot();
    const ids = ["TASM-1", "TASM-2", "TASM-3", "TASM-4", "TASM-5"];
    for (const id of ids) await plant(taskFile(root, id), taskText(id));
    // Fewer readers than files, and fewer than the gate admits reads, so what
    // the peak states is the bound on the applies: a scan that applied every
    // file at once would pass the gate with all five of them.
    const { cache, peak } = counting(root, 2);

    await cache.reconcile();

    expect(peak()).toBe(2);
  });

  it("reads one file at a time for a scan a watch started, which nobody waits on", async () => {
    const root = await tempRoot();
    for (const id of ["TASM-1", "TASM-2", "TASM-3"]) await plant(taskFile(root, id), taskText(id));
    const { cache, peak } = counting(root);

    await cache.reconcile(false);

    expect(peak()).toBe(1);
    expect(ids(cache)).toEqual(["TASM-1", "TASM-2", "TASM-3"]);
  });

  it("adds what appeared and drops what vanished", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const cache = await built(root);

    await rm(taskFile(root, "TASM-1"));
    await plant(taskFile(root, "TASM-2"), taskText("TASM-2"));
    await cache.reconcile();

    expect(ids(cache)).toEqual(["TASM-2"]);
  });

  it("drops every entry and reports the loss when the tasks directory goes away", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const seen = listener();
    const cache = await built(root, seen.on);

    await rm(tasksDir(root), { recursive: true });
    await cache.reconcile();

    expect(cache.query()).toEqual({ entries: [], excluded: [] });
    expect(seen.codes()).toEqual(["tasks-directory-lost"]);
  });

  it("reports the loss of the tasks directory once", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const seen = listener();
    const cache = await built(root, seen.on);

    await rm(tasksDir(root), { recursive: true });
    await cache.reconcile();
    await cache.reconcile();

    expect(seen.codes()).toEqual(["tasks-directory-lost"]);
  });

  it("takes the tasks directory back when it comes back", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const cache = await built(root);

    await rm(tasksDir(root), { recursive: true });
    await cache.reconcile();
    await plant(taskFile(root, "TASM-2"), taskText("TASM-2"));
    await cache.reconcile();

    expect(ids(cache)).toEqual(["TASM-2"]);
  });

  it("drops every entry when the project directory becomes a symbolic link", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const seen = listener();
    const cache = await built(root, seen.on);

    // The tasks the link points at stand outside the tree the caller named, and
    // `lstat` of the tasks directory alone resolves the link without seeing it.
    await plant(join(root, "outside", "tasks", "TASM-1.md"), taskText("TASM-1"));
    await rm(projectDir(root), { recursive: true });
    await symlink(join(root, "outside"), projectDir(root));
    await cache.reconcile();

    expect(cache.query()).toEqual({ entries: [], excluded: [] });
    expect(seen.codes()).toEqual(["tasks-directory-lost"]);
  });

  it("reports a tasks name that holds no directory, which is a fault and not an empty project", async () => {
    const root = await tempRoot();
    await plant(tasksDir(root), "not a directory");
    const seen = listener();

    expect((await built(root, seen.on)).query().entries).toEqual([]);
    expect(seen.codes()).toEqual(["tasks-directory-lost"]);
  });

  it("reports a tasks name that became a fault after an empty project was opened", async () => {
    const root = await tempRoot();
    const seen = listener();
    const cache = await built(root, seen.on);

    // A project the store answers for with `project-invalid`, which the index
    // may not read as the empty project it opened on.
    await plant(join(root, "outside", "TASM-1.md"), taskText("TASM-1"));
    await symlink(join(root, "outside"), tasksDir(root));
    await cache.reconcile();

    expect(cache.query().entries).toEqual([]);
    expect(seen.codes()).toEqual(["tasks-directory-lost"]);
  });

  it("reports the tasks directory it lost again after it came back", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const seen = listener();
    const cache = await built(root, seen.on);

    await rm(tasksDir(root), { recursive: true });
    await cache.reconcile();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    await cache.reconcile();
    await rm(tasksDir(root), { recursive: true });
    await cache.reconcile();

    expect(seen.codes()).toEqual(["tasks-directory-lost", "tasks-directory-lost"]);
  });
});

describe("the diagnostics of the index", () => {
  it("hands a diagnostic of its own to the listener", async () => {
    const root = await tempRoot();
    const seen = listener();
    const cache = index(root, seen.on);

    cache.report({ code: "index-watch-failed", message: "the watch failed", path: projectDir(root) });

    expect(seen.codes()).toEqual(["index-watch-failed"]);
  });

  it("drops what a listener throws", () => {
    const cache = index("/tmp/tree", () => {
      throw new Error("the listener failed");
    });

    expect(() => cache.report({ code: "index-watch-failed", message: "the watch failed" })).not.toThrow();
  });
});
