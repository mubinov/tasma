import { chmod, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { TaskStoreError } from "@tasma/engine";
import type { FeedEvent, ProjectInput } from "@tasma/protocol";
import { createProjectHost } from "../../src/projects/host.js";
import type { ProjectHost } from "../../src/projects/host.js";
import {
  loseTasks,
  nudge,
  plant,
  projectConfig,
  projectDir,
  projectsRoot,
  target,
  taskFile,
  tasksDir,
  taskText,
  until,
  userConfig,
} from "../helpers.js";

/** A host closed when the test ends, whether or not the test closes it. */
function host(root: string, repairInterval?: number): ProjectHost {
  const created = createProjectHost({ root, repairInterval });
  onTestFinished(() => created.close());
  return created;
}

/** A host closed when the test ends, with the `project` events it publishes. */
function publishing(root: string, repairInterval?: number): { opened: ProjectHost; projectEvents: FeedEvent[] } {
  const projectEvents: FeedEvent[] = [];
  const opened = createProjectHost({
    root,
    repairInterval,
    publish: (event) => {
      if (event.kind === "project") projectEvents.push(event);
    },
  });
  onTestFinished(() => opened.close());
  return { opened, projectEvents };
}

const SAGA_CHANGED: FeedEvent = { kind: "project", tag: "SAGA", change: "changed" };

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
    const root = await projectsRoot("SAGA", "ACME");
    await plant(projectConfig(root, "SAGA"), "name: Saga\npath: /srv/saga\n");

    await expect(host(root).list()).resolves.toEqual([
      { tag: "ACME", name: undefined, path: undefined },
      { tag: "SAGA", name: "Saga", path: "/srv/saga" },
    ]);
  });

  it("keeps the order of the tree however many projects it reads at a time", async () => {
    const tags = ["A1", "B2", "C3", "D4", "E5", "F6", "G7", "H8", "I9", "J10", "K11"];
    const root = await projectsRoot(...tags);

    await expect(host(root).list()).resolves.toEqual([...tags].sort().map((tag) => ({ tag })));
  });

  it("lists a project whose configuration cannot be read by its tag alone", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "name: [Saga\n");

    await expect(host(root).list()).resolves.toEqual([{ tag: "SAGA" }]);
  });

  it("answers over a shared configuration file this engine cannot read, which states neither field", async () => {
    const root = await projectsRoot("SAGA");
    await plant(userConfig(root), "statuses: [\n");
    await plant(projectConfig(root, "SAGA"), "name: Saga\n");

    await expect(host(root).list()).resolves.toEqual([{ tag: "SAGA", name: "Saga", path: undefined }]);
  });

  it("lists a project whose own directory cannot be read by its tag alone, and keeps every other one", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const directory = projectDir(root, "SAGA");
    await plant(projectConfig(root, "ACME"), "name: Acme\n");
    await chmod(directory, 0o000);
    onTestFinished(() => chmod(directory, 0o755));

    await expect(host(root).list()).resolves.toEqual([
      { tag: "ACME", name: "Acme", path: undefined },
      { tag: "SAGA" },
    ]);
  });

  it("passes on a fault of the tree itself, which names no project to leave out", async () => {
    const root = await projectsRoot("SAGA");
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

describe("the tags of the tree", () => {
  it("answers with every tag, also of a project whose directory cannot be read", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    await chmod(projectDir(root, "SAGA"), 0o000);
    onTestFinished(() => chmod(projectDir(root, "SAGA"), 0o755));

    await expect(host(root).tags()).resolves.toEqual(["ACME", "SAGA"]);
  });

  it("answers with the one tag named, and refuses a tag the tree does not list", async () => {
    const opened = host(await projectsRoot("SAGA", "ACME"));

    await expect(opened.tags("SAGA")).resolves.toEqual(["SAGA"]);
    expect((await storeError(opened.tags("GAMMA"))).code).toBe("project-not-found");
  });
});

describe("opening one project", () => {
  it("opens one index however many calls name the tag", async () => {
    const root = await projectsRoot("SAGA");
    const opened = host(root);

    const [first, second] = await Promise.all([opened.open("SAGA"), opened.open("SAGA")]);

    expect(first.index).toBe(second.index);
    expect(first.live).toBe(true);
  });

  it("keeps the flag up for a finding that is no loss of the disk", async () => {
    const root = await projectsRoot("SAGA");
    await plant(join(tasksDir(root, "SAGA"), "SAGA-1.md"), "Broken by hand.\n");

    const { index, live } = await host(root).open("SAGA");

    expect(live).toBe(true);
    expect(index.query().excluded).toHaveLength(1);
  });

  it.each([
    ["a tag no project of the tree carries", "NOPE"],
    ["a name that is no tag at all, which must not read as a fault of the request", "abc"],
  ])("refuses %s as project-not-found", async (_name, tag) => {
    const root = await projectsRoot("SAGA");

    expect((await storeError(host(root).open(tag))).code).toBe("project-not-found");
  });

  it("opens again after an open that failed, rather than holding the failure", async () => {
    const root = await projectsRoot("SAGA");
    const opened = host(root);
    // A file at the name the tasks directory stands under, which is what makes
    // the open below refuse the project rather than build an index of it.
    await plant(tasksDir(root, "SAGA"), "");

    expect((await storeError(opened.open("SAGA"))).code).toBe("project-invalid");

    await rm(tasksDir(root, "SAGA"));
    await plant(projectConfig(root, "SAGA"), "name: Saga\n");
    await expect(opened.open("SAGA")).resolves.toMatchObject({ live: true });
  });
});

describe("registering a project", () => {
  it("writes the project and answers with the tag it took", async () => {
    const root = await projectsRoot();
    const path = await target();
    const opened = host(root);

    await expect(opened.create({ path })).resolves.toBe("SAGA");

    await expect(opened.list()).resolves.toEqual([{ tag: "SAGA", name: "saga", path }]);
  });

  it("takes the tag and the name the caller states", async () => {
    const root = await projectsRoot();
    const path = await target();
    const opened = host(root);

    await expect(opened.create({ path, tag: "ACME", name: "Acme" })).resolves.toBe("ACME");

    await expect(opened.list()).resolves.toEqual([{ tag: "ACME", name: "Acme", path }]);
  });

  it.each([
    ["a tree of its own", "/srv/elsewhere"],
    ["a tree with no value, which is how a body carrying null arrives", undefined],
  ])("refuses a create naming %s, which is no field of a request", async (_name, stated) => {
    const root = await projectsRoot();
    const path = await target();
    const opened = host(root);

    const error = await storeError(opened.create({ path, root: stated } as ProjectInput));

    expect(error.code).toBe("field-not-writable");
    await expect(opened.list()).resolves.toEqual([]);
  });

  it("closes the index held for a project whose directory went by hand", async () => {
    const root = await projectsRoot("SAGA");
    const opened = host(root);
    const { index } = await opened.open("SAGA");
    await rm(projectDir(root, "SAGA"), { recursive: true, force: true });

    await expect(opened.create({ path: await target() })).resolves.toBe("SAGA");

    expect((await storeError(index.config())).code).toBe("index-closed");
  });
});

describe("writing what a project states", () => {
  it("sets the name and clears it", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "path: /srv/saga\n");
    const opened = host(root);

    await opened.update("SAGA", { name: "Saga" });
    await expect(opened.list()).resolves.toEqual([{ tag: "SAGA", name: "Saga", path: "/srv/saga" }]);

    await opened.update("SAGA", { name: null });
    await expect(opened.list()).resolves.toEqual([{ tag: "SAGA", name: undefined, path: "/srv/saga" }]);
  });

  it.each([
    ["a tag no project of the tree carries", "NOPE"],
    ["a tag in a case no directory of the tree carries", "saga"],
  ])("refuses %s as project-not-found", async (_name, tag) => {
    const root = await projectsRoot("SAGA");

    expect((await storeError(host(root).update(tag, { name: "Saga" }))).code).toBe("project-not-found");
  });
});

describe("removing a project", () => {
  it("answers with what the project stated and takes the directory with it", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "name: Saga\npath: /srv/saga\n");
    await plant(taskFile(root, "SAGA", "SAGA-1"), taskText("SAGA-1"));
    const opened = host(root);

    await expect(opened.remove("SAGA")).resolves.toEqual({ tag: "SAGA", name: "Saga", path: "/srv/saga" });

    await expect(opened.list()).resolves.toEqual([]);
  });

  it("closes the index it held, with no request after it", async () => {
    const root = await projectsRoot("SAGA");
    const opened = host(root);
    const { index } = await opened.open("SAGA");

    await opened.remove("SAGA");

    expect((await storeError(index.config())).code).toBe("index-closed");
  });

  it("removes a project whose own file cannot be read, and answers with its tag alone", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "name: [Saga\n");
    const opened = host(root);

    await expect(opened.remove("SAGA")).resolves.toEqual({ tag: "SAGA" });

    await expect(opened.list()).resolves.toEqual([]);
  });

  it.each([
    ["a tag no project of the tree carries", "NOPE"],
    ["a tag in a case no directory of the tree carries", "saga"],
  ])("refuses %s as project-not-found", async (_name, tag) => {
    const root = await projectsRoot("SAGA");

    expect((await storeError(host(root).remove(tag))).code).toBe("project-not-found");
  });
});

describe("a project the tree no longer holds", () => {
  it("is closed and dropped by the next call, whichever route makes it", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const opened = host(root);
    const { index } = await opened.open("SAGA");

    await rm(projectDir(root, "SAGA"), { recursive: true, force: true });
    await opened.open("ACME");

    expect((await storeError(index.config())).code).toBe("index-closed");
  });

  it.each([
    ["a listing", (opened: ProjectHost) => opened.list()],
    ["a read of the tags", (opened: ProjectHost) => opened.tags()],
  ])("is closed by %s too", async (_name, call) => {
    const root = await projectsRoot("SAGA");
    const opened = host(root);
    const { index } = await opened.open("SAGA");

    await rm(projectDir(root, "SAGA"), { recursive: true, force: true });

    await expect(call(opened)).resolves.toEqual([]);
    expect((await storeError(index.config())).code).toBe("index-closed");
  });
});

describe("a host that is closing", () => {
  it("closes every index it holds and answers for no project afterwards", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const opened = host(root);
    const [first, second] = await Promise.all([opened.open("SAGA"), opened.open("ACME")]);

    await opened.close();

    expect((await storeError(first.index.config())).code).toBe("index-closed");
    expect((await storeError(second.index.config())).code).toBe("index-closed");
    expect((await storeError(opened.open("SAGA"))).code).toBe("index-closed");
    expect((await storeError(opened.list())).code).toBe("index-closed");
    expect((await storeError(opened.tags())).code).toBe("index-closed");
  });

  it.each([
    ["an open", (opened: ProjectHost) => opened.open("SAGA")],
    ["a listing", (opened: ProjectHost) => opened.list()],
    ["a read of the tags", (opened: ProjectHost) => opened.tags()],
  ])("refuses %s that was reading the tree when the close completed", async (_name, call) => {
    const opened = host(await projectsRoot("SAGA"));

    // Started, not awaited: the call is inside its directory read when the
    // close drains the map, which is the window an open would otherwise leave a
    // watch handle in with nothing left to close it.
    const pending = call(opened);
    await opened.close();

    expect((await storeError(pending)).code).toBe("index-closed");
  });

  it("refuses every write of the tree, so a shutdown leaves none of them half made", async () => {
    const opened = host(await projectsRoot("SAGA"));

    await opened.close();

    expect((await storeError(opened.create({ path: "/srv/saga" }))).code).toBe("index-closed");
    expect((await storeError(opened.update("SAGA", { name: "Saga" }))).code).toBe("index-closed");
    expect((await storeError(opened.remove("SAGA"))).code).toBe("index-closed");
  });

  it("refuses a resolution, which reads the tree the same way a listing does", async () => {
    const opened = host(await projectsRoot("SAGA"));
    await opened.close();

    expect((await storeError(opened.locate(await target()))).code).toBe("index-closed");
  });

  it("closes twice without raising, so a second shutdown is harmless", async () => {
    const opened = host(await projectsRoot("SAGA"));
    await opened.open("SAGA");

    await opened.close();

    await expect(opened.close()).resolves.toBeUndefined();
  });
});

describe("the live flag", { timeout: 20000, retry: 3 }, () => {
  it("clears when the index stops following the disk, and is up again once the tasks directory is back", async () => {
    const root = await projectsRoot("SAGA");
    const tasks = tasksDir(root, "SAGA");
    // Planted before the open, so the index holds a task and a tasks directory
    // it can go on to lose: an index opened without one never reports the loss.
    await plant(join(tasks, "SAGA-1.md"), taskText("SAGA-1"));
    const opened = host(root);
    const { index } = await opened.open("SAGA");
    expect(index.query().entries).toHaveLength(1);

    await loseTasks(root, "SAGA", index);

    // The return of the directory starts a repair, which the open joins, or
    // which raised the flag before the open.
    await plant(join(tasks, "SAGA-2.md"), taskText("SAGA-2"));
    const again = await opened.open("SAGA");

    expect(again.live).toBe(true);
    expect(again.index.query().entries.map((entry) => entry.id)).toEqual(["SAGA-2"]);
  });

  it("comes back up for a project that never had a tasks directory, whose repair lost nothing", async () => {
    const root = await projectsRoot("SAGA");
    const directory = projectDir(root, "SAGA");
    // A directory that can be entered but not read: every path under it stats,
    // so the index opens, while the watch on the directory itself is refused.
    // That is the one loss an empty project can take, and it carries no tasks
    // directory for a repair to find.
    await chmod(directory, 0o111);
    onTestFinished(() => chmod(directory, 0o755));
    const opened = host(root, 0);

    await expect(opened.open("SAGA")).resolves.toMatchObject({ live: false });
    await chmod(directory, 0o755);

    await expect(opened.open("SAGA")).resolves.toMatchObject({ live: true });
  });

  it("stays down when the repair found the tasks directory still gone, which is reported nowhere", async () => {
    const root = await projectsRoot("SAGA");
    await plant(join(tasksDir(root, "SAGA"), "SAGA-1.md"), taskText("SAGA-1"));
    const opened = host(root);
    const { index } = await opened.open("SAGA");

    await loseTasks(root, "SAGA", index);

    // The rescan lands the index in the state it already stood in, so it
    // reports no loss of its own: the flag states what the rescan found rather
    // than what it said about it.
    const again = await opened.open("SAGA");

    expect(again.live).toBe(false);
    expect(again.index.query().entries).toEqual([]);
  });

  it("leaves a project whose repair did not take alone until the interval has passed", async () => {
    const root = await projectsRoot("SAGA");
    const directory = projectDir(root, "SAGA");
    // The watch on the project directory is refused at the open and again in
    // the repair the open runs.
    await chmod(directory, 0o111);
    onTestFinished(() => chmod(directory, 0o755));
    const opened = host(root);
    await expect(opened.open("SAGA")).resolves.toMatchObject({ live: false });

    // The cause is gone, but the repair that did not take ran a moment ago, so
    // this read answers from what that one found rather than paying for a
    // rescan of its own.
    await chmod(directory, 0o755);

    await expect(opened.open("SAGA")).resolves.toMatchObject({ live: false });
  });

  it("repairs again once the interval has passed", async () => {
    const root = await projectsRoot("SAGA");
    const directory = projectDir(root, "SAGA");
    await plant(join(tasksDir(root, "SAGA"), "SAGA-1.md"), taskText("SAGA-1"));
    await chmod(directory, 0o111);
    onTestFinished(() => chmod(directory, 0o755));
    // An interval every read stands outside of, which is the state a host
    // whose last repair is old enough is in.
    const opened = host(root, 0);
    await expect(opened.open("SAGA")).resolves.toMatchObject({ live: false });

    await chmod(directory, 0o755);
    const again = await opened.open("SAGA");

    expect(again.live).toBe(true);
    expect(again.index.query().entries.map((entry) => entry.id)).toEqual(["SAGA-1"]);
  });

  it("stays down when the repair itself fails, so the open after it repairs again", async () => {
    const root = await projectsRoot("SAGA");
    const directory = projectDir(root, "SAGA");
    await plant(join(tasksDir(root, "SAGA"), "SAGA-1.md"), taskText("SAGA-1"));
    const opened = host(root);
    const { index } = await opened.open("SAGA");

    await loseTasks(root, "SAGA", index);
    // The project directory becomes unreadable, so the rescan the next open
    // runs rejects on the stat of the tasks name under it. The tree above it is
    // untouched, so discovery still lists the tag and the open reaches the
    // repair.
    await chmod(directory, 0o000);
    onTestFinished(() => chmod(directory, 0o755));

    await expect(opened.open("SAGA")).rejects.toMatchObject({ code: "EACCES" });

    // The second open is the assertion: it rejects only because the flag came
    // back down, which is what makes it run the repair again rather than answer
    // live for an index that never got one.
    await expect(opened.open("SAGA")).rejects.toMatchObject({ code: "EACCES" });
  });

  it("makes an open that lands during a repair join it, rather than answer live while it runs", async () => {
    const root = await projectsRoot("SAGA");
    const directory = projectDir(root, "SAGA");
    await plant(join(tasksDir(root, "SAGA"), "SAGA-1.md"), taskText("SAGA-1"));
    const opened = host(root);
    const { index } = await opened.open("SAGA");

    await loseTasks(root, "SAGA", index);
    await chmod(directory, 0o000);
    onTestFinished(() => chmod(directory, 0o755));

    // Both read the tree at once, so the second reaches the flag while the
    // first is inside the rescan. The flag stands raised for the whole of it,
    // so a second call that read it alone would answer live for an index whose
    // repair goes on to fail.
    const [first, second] = await Promise.allSettled([opened.open("SAGA"), opened.open("SAGA")]);

    expect(first).toMatchObject({ status: "rejected", reason: { code: "EACCES" } });
    expect(second).toMatchObject({ status: "rejected", reason: { code: "EACCES" } });
  });

  it("publishes a project event when the index stops following the disk, and none for a repair that does not take", async () => {
    const root = await projectsRoot("SAGA");
    await plant(join(tasksDir(root, "SAGA"), "SAGA-1.md"), taskText("SAGA-1"));
    const { opened, projectEvents } = publishing(root);
    const { index } = await opened.open("SAGA");

    await loseTasks(root, "SAGA", index);
    await until(() => projectEvents.length > 0, "the loss was published");
    await expect(opened.open("SAGA")).resolves.toMatchObject({ live: false });

    expect(projectEvents).toEqual([SAGA_CHANGED]);
  });

  it("publishes no project event for a loss inside a repair, and one when a repair takes", async () => {
    const root = await projectsRoot("SAGA");
    const directory = projectDir(root, "SAGA");
    // The watch is refused at the open and again inside the repair the open runs.
    await chmod(directory, 0o111);
    onTestFinished(() => chmod(directory, 0o755));
    const { opened, projectEvents } = publishing(root, 0);

    await expect(opened.open("SAGA")).resolves.toMatchObject({ live: false });
    expect(projectEvents).toEqual([SAGA_CHANGED]);
    await chmod(directory, 0o755);
    await expect(opened.open("SAGA")).resolves.toMatchObject({ live: true });

    expect(projectEvents).toEqual([SAGA_CHANGED, SAGA_CHANGED]);
  });

  it("publishes no project event for a second loss while the flag is down", async () => {
    const root = await projectsRoot("SAGA");
    const directory = projectDir(root, "SAGA");
    await plant(join(tasksDir(root, "SAGA"), "SAGA-1.md"), taskText("SAGA-1"));
    await chmod(directory, 0o111);
    onTestFinished(() => chmod(directory, 0o755));
    const { opened, projectEvents } = publishing(root);
    const { index } = await opened.open("SAGA");
    await chmod(directory, 0o755);

    // A rescan of the index alone takes the watch back but raises no flag; only
    // a repair of the host does.
    await rm(tasksDir(root, "SAGA"), { recursive: true });
    await index.rescan();

    expect(index.query().entries).toEqual([]);
    expect(projectEvents).toEqual([SAGA_CHANGED]);
  });
});

describe("a repair with no request", { timeout: 20000, retry: 3 }, () => {
  it("runs when the tasks directory comes back by hand, and publishes the flag going up", async () => {
    const root = await projectsRoot("SAGA");
    await plant(join(tasksDir(root, "SAGA"), "SAGA-1.md"), taskText("SAGA-1"));
    const { opened, projectEvents } = publishing(root);
    const { index } = await opened.open("SAGA");
    await loseTasks(root, "SAGA", index);

    await plant(join(tasksDir(root, "SAGA"), "SAGA-2.md"), taskText("SAGA-2"));
    await until(() => projectEvents.length === 2, "the repair was published", nudge(projectDir(root, "SAGA")));

    expect(projectEvents).toEqual([SAGA_CHANGED, SAGA_CHANGED]);
    const again = await opened.open("SAGA");
    expect(again.live).toBe(true);
    expect(again.index.query().entries.map((entry) => entry.id)).toEqual(["SAGA-2"]);
  });

  it("is waited for by the close of the host", async () => {
    const root = await projectsRoot("SAGA");
    await plant(join(tasksDir(root, "SAGA"), "SAGA-1.md"), taskText("SAGA-1"));
    const { opened, projectEvents } = publishing(root);
    const { index } = await opened.open("SAGA");
    await loseTasks(root, "SAGA", index);

    // Enough files that the repair still reads them when the close comes. They
    // arrive in one rename, so no recovery starts before all of them are there.
    const staged = join(root, "staged");
    for (let number = 2; number <= 200; number += 1) await plant(join(staged, `SAGA-${number}.md`), taskText(`SAGA-${number}`));
    await rename(staged, tasksDir(root, "SAGA"));
    // The index follows the disk again from the read that finds the directory,
    // which is the read that starts the repair.
    await until(() => index.followsDisk(), "the index took the tasks directory back", nudge(projectDir(root, "SAGA")));
    await opened.close();

    expect(projectEvents).toEqual([SAGA_CHANGED, SAGA_CHANGED]);
  });

  it("repairs a held project whose watch failed once it is due, and publishes once when the repair takes", async () => {
    const root = await projectsRoot("SAGA");
    const directory = projectDir(root, "SAGA");
    await chmod(directory, 0o111);
    onTestFinished(() => chmod(directory, 0o755));
    const { opened, projectEvents } = publishing(root, 0);
    await expect(opened.open("SAGA")).resolves.toMatchObject({ live: false });
    await chmod(directory, 0o755);

    await opened.repairDue();
    await opened.repairDue();

    expect(projectEvents).toEqual([SAGA_CHANGED, SAGA_CHANGED]);
    await expect(opened.open("SAGA")).resolves.toMatchObject({ live: true });
  });

  it("leaves a held project alone inside the interval", async () => {
    const root = await projectsRoot("SAGA");
    const directory = projectDir(root, "SAGA");
    await chmod(directory, 0o111);
    onTestFinished(() => chmod(directory, 0o755));
    const { opened, projectEvents } = publishing(root);
    await expect(opened.open("SAGA")).resolves.toMatchObject({ live: false });
    await chmod(directory, 0o755);

    await opened.repairDue();

    expect(projectEvents).toEqual([SAGA_CHANGED]);
  });

  it("does nothing for a live project", async () => {
    const root = await projectsRoot("SAGA");
    const { opened, projectEvents } = publishing(root, 0);
    await opened.open("SAGA");

    await opened.repairDue();

    expect(projectEvents).toEqual([]);
  });

  it("does not repair a held project whose folder went by hand, and closes its index", async () => {
    const root = await projectsRoot("SAGA");
    const directory = projectDir(root, "SAGA");
    await chmod(directory, 0o111);
    onTestFinished(() => chmod(directory, 0o755).catch(() => undefined));
    const { opened, projectEvents } = publishing(root, 0);
    const { index } = await opened.open("SAGA");
    await chmod(directory, 0o755);
    await rm(directory, { recursive: true });

    await opened.repairDue();

    expect(projectEvents).toEqual([SAGA_CHANGED]);
    expect((await storeError(index.config())).code).toBe("index-closed");
  });

  it("resolves when the tree cannot be listed, when a repair fails and when the host is closed", async () => {
    const root = await projectsRoot("SAGA");
    const directory = projectDir(root, "SAGA");
    const projects = join(root, "projects");
    await plant(join(tasksDir(root, "SAGA"), "SAGA-1.md"), taskText("SAGA-1"));
    const opened = host(root, 0);
    const { index } = await opened.open("SAGA");
    await loseTasks(root, "SAGA", index);

    await chmod(projects, 0o000);
    onTestFinished(() => chmod(projects, 0o755));
    await expect(opened.repairDue()).resolves.toBeUndefined();
    await chmod(projects, 0o755);
    await chmod(directory, 0o000);
    onTestFinished(() => chmod(directory, 0o755));
    await expect(opened.repairDue()).resolves.toBeUndefined();
    await opened.close();
    await expect(opened.repairDue()).resolves.toBeUndefined();
  });
});

describe("renaming a project", () => {
  it("answers the tasks of the tree under the new tag, and holds the old one no more", async () => {
    const root = await projectsRoot("SAGA");
    await plant(taskFile(root, "SAGA", "SAGA-1"), taskText("SAGA-1"));
    const opened = host(root);

    await expect(opened.rename("SAGA", { tag: "NEW" })).resolves.toEqual([]);

    await expect(opened.list()).resolves.toEqual([{ tag: "NEW" }]);
    const { index } = await opened.open("NEW");
    expect(index.query().entries.map((entry) => entry.id)).toEqual(["NEW-1"]);
  });

  it("closes the index it held for the old tag, with no request after it", async () => {
    const root = await projectsRoot("SAGA");
    const opened = host(root);
    const { index } = await opened.open("SAGA");

    await opened.rename("SAGA", { tag: "NEW" });

    expect((await storeError(index.config())).code).toBe("index-closed");
  });

  it("carries the findings of the rename", async () => {
    const root = await projectsRoot("SAGA");
    await plant(join(tasksDir(root, "SAGA"), "notes.md"), "not a task file");
    const opened = host(root);

    await expect(opened.rename("SAGA", { tag: "NEW" })).resolves.toEqual([
      { code: "task-file-unexpected", message: expect.any(String) as string, path: join(tasksDir(root, "NEW"), "notes.md") },
    ]);
  });

  it("refuses a source the tree does not list", async () => {
    const opened = host(await projectsRoot("SAGA"));

    expect((await storeError(opened.rename("NOPE", { tag: "NEW" }))).code).toBe("project-not-found");
  });

  it("refuses a rename once the host is closing", async () => {
    const opened = host(await projectsRoot("SAGA"));
    await opened.close();

    expect((await storeError(opened.rename("SAGA", { tag: "NEW" }))).code).toBe("index-closed");
  });
});
