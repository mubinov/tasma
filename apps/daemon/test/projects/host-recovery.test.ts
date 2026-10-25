import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { discoverProjects, type IndexedProject, type IndexOptions, openIndexedProject } from "@tasma/engine";
import type { FeedEvent } from "@tasma/protocol";
import { createProjectHost } from "../../src/projects/host.js";
import type { ProjectHost } from "../../src/projects/host.js";
import { projectsRoot } from "../helpers.js";

// The open of an index and the listing of the tree are the seams where a test
// decides the order of a recovery, a repair and a close.
vi.mock("@tasma/engine", async (importActual) => {
  const actual = await importActual<typeof import("@tasma/engine")>();
  return {
    ...actual,
    discoverProjects: vi.fn(actual.discoverProjects),
    openIndexedProject: vi.fn(actual.openIndexedProject),
  };
});

afterEach(() => {
  vi.mocked(openIndexedProject).mockReset();
  vi.mocked(discoverProjects).mockClear();
});

const SAGA_CHANGED: FeedEvent = { kind: "project", tag: "SAGA", change: "changed" };

/** Opens the index of each tag with the rescan the test gives for it, and answers the options each open got. */
function mockIndexOpen(rescans: Record<string, () => Promise<void>>): { optionsOf: (tag: string) => IndexOptions } {
  const given = new Map<string, IndexOptions>();
  vi.mocked(openIndexedProject).mockImplementation(async (project, options = {}) => {
    const tag = project.paths.project;
    given.set(tag, options);
    return { rescan: rescans[tag], followsDisk: () => true, close: async () => {} } as unknown as IndexedProject;
  });
  return {
    optionsOf: (tag) => {
      const options = given.get(tag);
      if (options === undefined) throw new Error(`the host opened no index of ${tag}`);
      return options;
    },
  };
}

/** A host over a tree of these projects, with the events it publishes. */
async function hostOf(...tags: string[]): Promise<{ host: ProjectHost; events: FeedEvent[] }> {
  const events: FeedEvent[] = [];
  const host = createProjectHost({ root: await projectsRoot(...tags), publish: (event) => void events.push(event) });
  return { host, events };
}

/** What the index reports when its tasks directory is gone, which takes the flag down. */
function lose(options: IndexOptions): void {
  options.onDiagnostic?.({ code: "tasks-directory-lost", message: "the tasks directory is gone", path: "/srv/saga" });
}

/** A rescan that waits until the test settles it. */
function heldRescan(): { rescan: Mock<() => Promise<void>>; settle: (error?: Error) => void } {
  let settle!: (error?: Error) => void;
  const rescan = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        settle = (error) => (error === undefined ? resolve() : reject(error));
      }),
  );
  return { rescan, settle: (error) => settle(error) };
}

describe("a repair that a recovery starts", () => {
  it("is caught when it fails, and the close waits for it", async () => {
    const { rescan, settle } = heldRescan();
    const { optionsOf } = mockIndexOpen({ SAGA: rescan });
    const { host, events } = await hostOf("SAGA");
    await expect(host.open("SAGA")).resolves.toMatchObject({ live: true });
    lose(optionsOf("SAGA"));

    optionsOf("SAGA").onRecovered?.();
    await vi.waitFor(() => expect(rescan).toHaveBeenCalled());
    let closed = false;
    const closing = host.close().then(() => (closed = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    settle(new Error("the rescan failed"));
    await closing;

    expect(rescan).toHaveBeenCalledTimes(1);
    expect(events).toEqual([SAGA_CHANGED]);
  });

  it("does not start once the host is closing", async () => {
    const rescan = vi.fn(async () => {});
    const { optionsOf } = mockIndexOpen({ SAGA: rescan });
    const { host } = await hostOf("SAGA");
    await host.open("SAGA");
    lose(optionsOf("SAGA"));

    const closing = host.close();
    optionsOf("SAGA").onRecovered?.();
    await closing;

    expect(rescan).not.toHaveBeenCalled();
  });
});

describe("the repair of the projects that are due", () => {
  it("passes over a project whose index fails to open", async () => {
    let fail!: (error: Error) => void;
    vi.mocked(openIndexedProject).mockImplementation(
      () => new Promise<IndexedProject>((_resolve, reject) => (fail = reject)),
    );
    const { host } = await hostOf("SAGA");
    const opening = host.open("SAGA");
    await vi.waitFor(() => expect(openIndexedProject).toHaveBeenCalled());

    const due = host.repairDue();
    // The listing of the repair, then a turn, so the repair waits on the open.
    await vi.waitFor(() => expect(discoverProjects).toHaveBeenCalledTimes(2));
    await vi.mocked(discoverProjects).mock.results[1]?.value;
    await new Promise((resolve) => setImmediate(resolve));
    fail(new Error("the project cannot be read"));

    await expect(opening).rejects.toThrow("the project cannot be read");
    await expect(due).resolves.toBeUndefined();
  });

  it("is waited for by the close of the host", async () => {
    const { rescan, settle } = heldRescan();
    const { optionsOf } = mockIndexOpen({ SAGA: rescan });
    const { host, events } = await hostOf("SAGA");
    await host.open("SAGA");
    lose(optionsOf("SAGA"));

    const due = host.repairDue();
    await vi.waitFor(() => expect(rescan).toHaveBeenCalled());
    let closed = false;
    const closing = host.close().then(() => (closed = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    settle();
    await Promise.all([due, closing]);

    expect(events).toEqual([SAGA_CHANGED, SAGA_CHANGED]);
  });

  it("starts no repair once the host is closing, also when the close came during its listing", async () => {
    const recovery = heldRescan();
    const acme = vi.fn(async () => {});
    const { optionsOf } = mockIndexOpen({ SAGA: recovery.rescan, ACME: acme });
    const { host } = await hostOf("SAGA", "ACME");
    await host.open("SAGA");
    await host.open("ACME");
    lose(optionsOf("SAGA"));
    lose(optionsOf("ACME"));
    optionsOf("SAGA").onRecovered?.();
    await vi.waitFor(() => expect(recovery.rescan).toHaveBeenCalled());

    let list!: () => void;
    const listed = new Promise<void>((resolve) => (list = resolve));
    vi.mocked(discoverProjects).mockImplementationOnce(async () => {
      await listed;
      return ["ACME", "SAGA"];
    });
    const due = host.repairDue();
    await vi.waitFor(() => expect(discoverProjects).toHaveBeenCalledTimes(3));
    const closing = host.close();
    list();
    await new Promise((resolve) => setImmediate(resolve));
    recovery.settle();
    await Promise.all([due, closing]);

    expect(acme).not.toHaveBeenCalled();
    expect(recovery.rescan).toHaveBeenCalledTimes(1);
  });
});
