import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { TaskStoreError } from "@tasma/engine";
import { createProjectHost } from "../../src/projects/host.js";
import type { ProjectHost } from "../../src/projects/host.js";
import { loseTasks, plant, projectConfig, projectDir, projectsRoot, tasksDir, taskText, userConfig } from "../helpers.js";

/** A host closed when the test ends, whether or not the test closes it. */
function host(root: string, repairInterval?: number): ProjectHost {
  const created = createProjectHost({ root, repairInterval });
  onTestFinished(() => created.close());
  return created;
}

/** Runs a call and returns the `TaskStoreError` it must reject with. */
async function storeError(call: Promise<unknown>): Promise<TaskStoreError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof TaskStoreError) return error;
    throw error;
  }
  throw new Error("the call did not reject");
}

describe("the listing", () => {
  it("answers with every project of the tree, and what each one calls itself", async () => {
    const root = await projectsRoot("TASM", "CLIB");
    await plant(projectConfig(root, "TASM"), "name: Tasma\npath: /srv/tasma\n");

    await expect(host(root).list()).resolves.toEqual([
      { tag: "CLIB", name: undefined, path: undefined },
      { tag: "TASM", name: "Tasma", path: "/srv/tasma" },
    ]);
  });

  it("keeps the order of the tree however many projects it reads at a time", async () => {
    const tags = ["A1", "B2", "C3", "D4", "E5", "F6", "G7", "H8", "I9", "J10", "K11"];
    const root = await projectsRoot(...tags);

    await expect(host(root).list()).resolves.toEqual([...tags].sort().map((tag) => ({ tag })));
  });

  it("lists a project whose configuration cannot be read by its tag alone", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "name: [Tasma\n");

    await expect(host(root).list()).resolves.toEqual([{ tag: "TASM" }]);
  });

  it("answers over a shared configuration file this engine cannot read, which states neither field", async () => {
    const root = await projectsRoot("TASM");
    await plant(userConfig(root), "statuses: [\n");
    await plant(projectConfig(root, "TASM"), "name: Tasma\n");

    await expect(host(root).list()).resolves.toEqual([{ tag: "TASM", name: "Tasma", path: undefined }]);
  });

  it("lists a project whose own directory cannot be read by its tag alone, and keeps every other one", async () => {
    const root = await projectsRoot("TASM", "CLIB");
    const directory = projectDir(root, "TASM");
    await plant(projectConfig(root, "CLIB"), "name: Claude Lib\n");
    await chmod(directory, 0o000);
    onTestFinished(() => chmod(directory, 0o755));

    await expect(host(root).list()).resolves.toEqual([
      { tag: "CLIB", name: "Claude Lib", path: undefined },
      { tag: "TASM" },
    ]);
  });

  it("passes on a fault of the tree itself, which names no project to leave out", async () => {
    const root = await projectsRoot("TASM");
    const tree = join(root, "projects");
    await chmod(tree, 0o000);
    onTestFinished(() => chmod(tree, 0o755));

    await expect(host(root).list()).rejects.toMatchObject({ code: "EACCES" });
  });

  it("answers with nothing for a tree that holds no project", async () => {
    const root = await projectsRoot();

    await expect(host(root).list()).resolves.toEqual([]);
  });
});

describe("opening one project", () => {
  it("opens one index however many calls name the tag", async () => {
    const root = await projectsRoot("TASM");
    const opened = host(root);

    const [first, second] = await Promise.all([opened.open("TASM"), opened.open("TASM")]);

    expect(first.index).toBe(second.index);
    expect(first.live).toBe(true);
  });

  it("keeps the flag up for a finding that is no loss of the disk", async () => {
    const root = await projectsRoot("TASM");
    await plant(join(tasksDir(root, "TASM"), "TASM-1.md"), "Broken by hand.\n");

    const { index, live } = await host(root).open("TASM");

    expect(live).toBe(true);
    expect(index.query().excluded).toHaveLength(1);
  });

  it.each([
    ["a tag no project of the tree carries", "NOPE"],
    ["a name that is no tag at all, which must not read as a fault of the request", "abc"],
  ])("refuses %s as project-not-found", async (_name, tag) => {
    const root = await projectsRoot("TASM");

    expect((await storeError(host(root).open(tag))).code).toBe("project-not-found");
  });

  it("opens again after an open that failed, rather than holding the failure", async () => {
    const root = await projectsRoot("TASM");
    const opened = host(root);
    // A file at the name the tasks directory stands under, which is what makes
    // the open below refuse the project rather than build an index of it.
    await plant(tasksDir(root, "TASM"), "");

    expect((await storeError(opened.open("TASM"))).code).toBe("project-invalid");

    await rm(tasksDir(root, "TASM"));
    await plant(projectConfig(root, "TASM"), "name: Tasma\n");
    await expect(opened.open("TASM")).resolves.toMatchObject({ live: true });
  });
});

describe("a project the tree no longer holds", () => {
  it("is closed and dropped by the next call, whichever route makes it", async () => {
    const root = await projectsRoot("TASM", "CLIB");
    const opened = host(root);
    const { index } = await opened.open("TASM");

    await rm(projectDir(root, "TASM"), { recursive: true, force: true });
    await opened.open("CLIB");

    expect((await storeError(index.config())).code).toBe("index-closed");
  });

  it("is closed by a listing too", async () => {
    const root = await projectsRoot("TASM");
    const opened = host(root);
    const { index } = await opened.open("TASM");

    await rm(projectDir(root, "TASM"), { recursive: true, force: true });

    await expect(opened.list()).resolves.toEqual([]);
    expect((await storeError(index.config())).code).toBe("index-closed");
  });
});

describe("a host that is closing", () => {
  it("closes every index it holds and answers for no project afterwards", async () => {
    const root = await projectsRoot("TASM", "CLIB");
    const opened = host(root);
    const [first, second] = await Promise.all([opened.open("TASM"), opened.open("CLIB")]);

    await opened.close();

    expect((await storeError(first.index.config())).code).toBe("index-closed");
    expect((await storeError(second.index.config())).code).toBe("index-closed");
    expect((await storeError(opened.open("TASM"))).code).toBe("index-closed");
    expect((await storeError(opened.list())).code).toBe("index-closed");
  });

  it.each([
    ["an open", (opened: ProjectHost) => opened.open("TASM")],
    ["a listing", (opened: ProjectHost) => opened.list()],
  ])("refuses %s that was reading the tree when the close completed", async (_name, call) => {
    const opened = host(await projectsRoot("TASM"));

    // Started, not awaited: the call is inside its directory read when the
    // close drains the map, which is the window an open would otherwise leave a
    // watch handle in with nothing left to close it.
    const pending = call(opened);
    await opened.close();

    expect((await storeError(pending)).code).toBe("index-closed");
  });

  it("closes twice without raising, so a second shutdown is harmless", async () => {
    const opened = host(await projectsRoot("TASM"));
    await opened.open("TASM");

    await opened.close();

    await expect(opened.close()).resolves.toBeUndefined();
  });
});

describe("the live flag", { timeout: 20000, retry: 3 }, () => {
  it("clears when the index stops following the disk, and the next open repairs it", async () => {
    const root = await projectsRoot("TASM");
    const tasks = tasksDir(root, "TASM");
    // Planted before the open, so the index holds a task and a tasks directory
    // it can go on to lose: an index opened without one never reports the loss.
    await plant(join(tasks, "TASM-1.md"), taskText("TASM-1"));
    const opened = host(root);
    const { index } = await opened.open("TASM");
    expect(index.query().entries).toHaveLength(1);

    await loseTasks(root, "TASM", index);

    await plant(join(tasks, "TASM-2.md"), taskText("TASM-2"));
    const again = await opened.open("TASM");

    expect(again.live).toBe(true);
    expect(again.index.query().entries.map((entry) => entry.id)).toEqual(["TASM-2"]);
  });

  it("comes back up for a project that never had a tasks directory, whose repair lost nothing", async () => {
    const root = await projectsRoot("TASM");
    const directory = projectDir(root, "TASM");
    // A directory that can be entered but not read: every path under it stats,
    // so the index opens, while the watch on the directory itself is refused.
    // That is the one loss an empty project can take, and it carries no tasks
    // directory for a repair to find.
    await chmod(directory, 0o111);
    onTestFinished(() => chmod(directory, 0o755));
    const opened = host(root, 0);

    await expect(opened.open("TASM")).resolves.toMatchObject({ live: false });
    await chmod(directory, 0o755);

    await expect(opened.open("TASM")).resolves.toMatchObject({ live: true });
  });

  it("stays down when the repair found the tasks directory still gone, which is reported nowhere", async () => {
    const root = await projectsRoot("TASM");
    await plant(join(tasksDir(root, "TASM"), "TASM-1.md"), taskText("TASM-1"));
    const opened = host(root);
    const { index } = await opened.open("TASM");

    await loseTasks(root, "TASM", index);

    // The rescan lands the index in the state it already stood in, so it
    // reports no loss of its own: the flag states what the rescan found rather
    // than what it said about it.
    const again = await opened.open("TASM");

    expect(again.live).toBe(false);
    expect(again.index.query().entries).toEqual([]);
  });

  it("leaves a project whose repair did not take alone until the interval has passed", async () => {
    const root = await projectsRoot("TASM");
    const tasks = tasksDir(root, "TASM");
    await plant(join(tasks, "TASM-1.md"), taskText("TASM-1"));
    const opened = host(root);
    const { index } = await opened.open("TASM");
    await loseTasks(root, "TASM", index);
    await expect(opened.open("TASM")).resolves.toMatchObject({ live: false });

    // The directory is back, but the repair that found it gone ran a moment
    // ago, so this read answers from what that one found rather than paying for
    // a rescan of its own.
    await plant(join(tasks, "TASM-2.md"), taskText("TASM-2"));

    await expect(opened.open("TASM")).resolves.toMatchObject({ live: false });
  });

  it("repairs again once the interval has passed", async () => {
    const root = await projectsRoot("TASM");
    const tasks = tasksDir(root, "TASM");
    await plant(join(tasks, "TASM-1.md"), taskText("TASM-1"));
    // An interval every read stands outside of, which is the state a host
    // whose last repair is old enough is in.
    const opened = host(root, 0);
    const { index } = await opened.open("TASM");
    await loseTasks(root, "TASM", index);
    await expect(opened.open("TASM")).resolves.toMatchObject({ live: false });

    await plant(join(tasks, "TASM-2.md"), taskText("TASM-2"));

    await expect(opened.open("TASM")).resolves.toMatchObject({ live: true });
  });

  it("stays down when the repair itself fails, so the open after it repairs again", async () => {
    const root = await projectsRoot("TASM");
    const directory = projectDir(root, "TASM");
    await plant(join(tasksDir(root, "TASM"), "TASM-1.md"), taskText("TASM-1"));
    const opened = host(root);
    const { index } = await opened.open("TASM");

    await loseTasks(root, "TASM", index);
    // The project directory becomes unreadable, so the rescan the next open
    // runs rejects on the stat of the tasks name under it. The tree above it is
    // untouched, so discovery still lists the tag and the open reaches the
    // repair.
    await chmod(directory, 0o000);
    onTestFinished(() => chmod(directory, 0o755));

    await expect(opened.open("TASM")).rejects.toMatchObject({ code: "EACCES" });

    // The second open is the assertion: it rejects only because the flag came
    // back down, which is what makes it run the repair again rather than answer
    // live for an index that never got one.
    await expect(opened.open("TASM")).rejects.toMatchObject({ code: "EACCES" });
  });

  it("makes an open that lands during a repair join it, rather than answer live while it runs", async () => {
    const root = await projectsRoot("TASM");
    const directory = projectDir(root, "TASM");
    await plant(join(tasksDir(root, "TASM"), "TASM-1.md"), taskText("TASM-1"));
    const opened = host(root);
    const { index } = await opened.open("TASM");

    await loseTasks(root, "TASM", index);
    await chmod(directory, 0o000);
    onTestFinished(() => chmod(directory, 0o755));

    // Both read the tree at once, so the second reaches the flag while the
    // first is inside the rescan. The flag stands raised for the whole of it,
    // so a second call that read it alone would answer live for an index whose
    // repair goes on to fail.
    const [first, second] = await Promise.allSettled([opened.open("TASM"), opened.open("TASM")]);

    expect(first).toMatchObject({ status: "rejected", reason: { code: "EACCES" } });
    expect(second).toMatchObject({ status: "rejected", reason: { code: "EACCES" } });
  });
});
