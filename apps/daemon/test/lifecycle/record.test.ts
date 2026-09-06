import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { claimRecord, readRecord, recordPath, removeRecord } from "../../src/lifecycle/record.js";
import { projectsRoot, seedRecord } from "../helpers.js";

const execFile = promisify(execFileCallback);

/** The name a file grows under, once the test below sets it. Every other read runs untouched. */
const growing = vi.hoisted(() => ({ path: undefined as string | undefined }));

// A file that grows after its length was measured. The measure and the read are
// two calls whatever makes them, so nothing but the read itself can bound how
// much of a name is read.
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();

  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      const grows = growing.path;

      if (grows === undefined) return handle;

      const measure = handle.stat.bind(handle);
      Object.defineProperty(handle, "stat", {
        value: async (...options: Parameters<typeof measure>) => {
          const held = await measure(...options);
          await actual.appendFile(grows, " ".repeat(8192));

          return held;
        },
      });

      return handle;
    },
  };
});

/** A tree nothing else answers for: every record it holds names a daemon that is gone. */
const gone = () => Promise.resolve(false);

/** A tree every record it holds names a daemon of. */
const answers = () => Promise.resolve(true);

/**
 * A tree the two racing claims below serve: the record either of them installs
 * names a daemon that answers, and the one a dead process left behind names none.
 */
const racing = (port: number) => Promise.resolve(port === 1 || port === 3);

describe("the record of the running daemon", () => {
  it("reads back what a claim wrote", async () => {
    const root = await projectsRoot();

    await claimRecord(root, { port: 8278, pid: 4242 }, gone);

    expect(await readRecord(root)).toEqual({ port: 8278, pid: 4242 });
  });

  it("stands at daemon.json in the root of the tree", async () => {
    const root = await projectsRoot();

    expect(recordPath(root)).toBe(join(root, "daemon.json"));
  });

  it("creates a tree root that does not exist yet", async () => {
    const root = join(await projectsRoot(), "fresh");

    await claimRecord(root, { port: 1, pid: 2 }, gone);

    expect(await readRecord(root)).toEqual({ port: 1, pid: 2 });
  });

  it("refuses a tree root a symbolic link points away from", async () => {
    const outside = await projectsRoot();
    const root = join(await projectsRoot(), "link");
    await symlink(outside, root, "dir");

    await expect(claimRecord(root, { port: 1, pid: 2 }, gone)).rejects.toThrow("is not a directory");

    expect(await readdir(outside)).toEqual([]);
  });

  it("leaves no file beside the record it installed", async () => {
    const root = await projectsRoot();

    await claimRecord(root, { port: 1, pid: 2 }, gone);

    expect(await readdir(root)).toEqual(["daemon.json"]);
  });

  it("leaves nothing behind where the write fails", async () => {
    const root = await projectsRoot();
    await chmod(root, 0o500);
    onTestFinished(() => chmod(root, 0o700));

    await expect(claimRecord(root, { port: 1, pid: 2 }, gone)).rejects.toThrow();

    expect(await readdir(root)).toEqual([]);
  });

  it("gives the file and the directory the modes the tree is kept at", async () => {
    const root = join(await projectsRoot(), "fresh");

    await claimRecord(root, { port: 1, pid: 2 }, gone);

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(recordPath(root))).mode & 0o777).toBe(0o600);
  });

  it("reads as absent for every way the file states no record", async () => {
    const root = await projectsRoot();
    expect(await readRecord(root), "no file at all").toBeUndefined();

    await mkdir(recordPath(root));
    expect(await readRecord(root), "a name that holds a directory").toBeUndefined();

    const bad = [
      "{",
      '"text"',
      "null",
      "42",
      '{"port": 70000, "pid": 1}',
      '{"port": 1.5, "pid": 1}',
      '{"port": -1, "pid": 1}',
      '{"port": 1}',
      '{"port": 1, "pid": 1.5}',
      '{"port": 1, "pid": 0}',
      '{"port": 1, "pid": -1}',
      '{"port": 1, "pid": "1"}',
    ];

    for (const text of bad) {
      const other = await projectsRoot();
      await writeFile(recordPath(other), text, "utf8");
      expect(await readRecord(other), text).toBeUndefined();
    }
  });

  it("reads as absent for a file longer than a record can be", async () => {
    const root = await projectsRoot();
    await writeFile(recordPath(root), `${JSON.stringify({ port: 1, pid: 2 })}${" ".repeat(8192)}`, "utf8");

    expect(await readRecord(root)).toBeUndefined();
  });

  it("reads as absent for a file that grows past a record's length after it is measured", async () => {
    const root = await projectsRoot();
    await seedRecord(root, { port: 1, pid: 2 });
    growing.path = recordPath(root);
    onTestFinished(() => {
      growing.path = undefined;
    });

    expect(await readRecord(root)).toBeUndefined();
  });

  it("reads as absent for a name a symbolic link points away from", async () => {
    const root = await projectsRoot();
    const outside = join(await projectsRoot(), "outside.json");
    await writeFile(outside, '{"port": 1, "pid": 2}', "utf8");
    await symlink(outside, recordPath(root));

    expect(await readRecord(root)).toBeUndefined();
  });

  it("reads as absent at once for a pipe, which an open would otherwise wait on", async () => {
    const root = await projectsRoot();
    await execFile("mkfifo", [recordPath(root)]);

    expect(await readRecord(root)).toBeUndefined();
  });

  it("removes the record it holds the process of, and no other", async () => {
    const root = await projectsRoot();
    await seedRecord(root, { port: 1, pid: 4242 });

    await removeRecord(root, 4243);
    expect(await readRecord(root), "another process wrote it").toEqual({ port: 1, pid: 4242 });

    await removeRecord(root, 4242);
    expect(await readRecord(root)).toBeUndefined();
    expect(await readdir(root), "and leaves nothing beside it").toEqual([]);
  });

  it("leaves standing a name that states no record, whatever it holds", async () => {
    const root = await projectsRoot();
    await writeFile(recordPath(root), "{", "utf8");

    await removeRecord(root, 4242);

    expect(await readFile(recordPath(root), "utf8"), "a file stating nothing").toBe("{");

    const other = await projectsRoot();
    await mkdir(recordPath(other));

    await expect(removeRecord(other, 4242), "a name holding no file at all").resolves.toBeUndefined();
    expect((await stat(recordPath(other))).isDirectory()).toBe(true);
    expect(await readdir(root)).toEqual(["daemon.json"]);
  });

  it("removes a record that is not there without a fault", async () => {
    const root = await projectsRoot();

    await expect(removeRecord(root, 4242)).resolves.toBeUndefined();
  });

  it("leaves standing the record a start installed while it was removing its own", async () => {
    const root = await projectsRoot();
    await seedRecord(root, { port: 1, pid: 4242 });
    let removal: Promise<void> | undefined;
    // The daemon the record names starts removing it while this claim judges it,
    // so the name the removal read is not the name it goes on to clear.
    const judged = () => {
      removal = removeRecord(root, 4242);

      return Promise.resolve(false);
    };

    expect(await claimRecord(root, { port: 3, pid: 4243 }, judged)).toBeUndefined();

    await expect(removal).resolves.toBeUndefined();
    expect(await readRecord(root)).toEqual({ port: 3, pid: 4243 });
    expect(await readdir(root)).toEqual(["daemon.json"]);
  });
});

describe("the claim on a tree", () => {
  it("takes a tree nothing holds", async () => {
    const root = await projectsRoot();

    expect(await claimRecord(root, { port: 1, pid: 2 }, gone)).toBeUndefined();
    expect(await readRecord(root)).toEqual({ port: 1, pid: 2 });
  });

  it("answers the record already holding the tree, and leaves it standing", async () => {
    const root = await projectsRoot();
    await seedRecord(root, { port: 1, pid: 2 });

    expect(await claimRecord(root, { port: 3, pid: 4 }, answers)).toEqual({ port: 1, pid: 2 });
    expect(await readRecord(root)).toEqual({ port: 1, pid: 2 });
  });

  it("takes a tree whose record states nothing", async () => {
    const root = await projectsRoot();
    await writeFile(recordPath(root), "{", "utf8");

    expect(await claimRecord(root, { port: 3, pid: 4 }, gone)).toBeUndefined();
    expect(await readRecord(root)).toEqual({ port: 3, pid: 4 });
    expect(await readdir(root)).toEqual(["daemon.json"]);
  });

  it("takes a tree whose record names a daemon that is gone", async () => {
    const root = await projectsRoot();
    await seedRecord(root, { port: 1, pid: 4242 });

    expect(await claimRecord(root, { port: 3, pid: 4 }, gone)).toBeUndefined();
    expect(await readRecord(root)).toEqual({ port: 3, pid: 4 });
  });

  it("takes a tree whose record another start cleared while it was judged", async () => {
    const root = await projectsRoot();
    await seedRecord(root, { port: 1, pid: 4242 });
    const cleared = () => rm(recordPath(root)).then(() => false);

    expect(await claimRecord(root, { port: 3, pid: 4 }, cleared)).toBeUndefined();
    expect(await readRecord(root)).toEqual({ port: 3, pid: 4 });
  });

  it("leaves standing the record another start installed while the last one was judged", async () => {
    const root = await projectsRoot();
    await seedRecord(root, { port: 1, pid: 4242 });
    // Every round of the claim finds a record it did not judge, which is the one
    // state a claim cannot resolve: the name is taken again as fast as it clears it.
    const retaken = async (port: number) => {
      await seedRecord(root, { port: port + 1, pid: 4242 });

      return false;
    };

    await expect(claimRecord(root, { port: 3, pid: 4 }, retaken)).rejects.toThrow(/as fast as/);

    expect(await readRecord(root), "the record it took away is put back").toEqual({ port: 4, pid: 4242 });
    expect(await readdir(root)).toEqual(["daemon.json"]);
  });

  it("ends the start where the name cannot be linked at all", async () => {
    const root = await projectsRoot();
    await seedRecord(root, { port: 1, pid: 4242 });
    const sealed = async () => {
      await rm(recordPath(root));
      await chmod(root, 0o500);

      return false;
    };
    onTestFinished(() => chmod(root, 0o700));

    await expect(claimRecord(root, { port: 3, pid: 4 }, sealed)).rejects.toThrow("EACCES");
  });

  it("is taken by one of two starts and no more", async () => {
    const root = await projectsRoot();

    const claims = await Promise.all([
      claimRecord(root, { port: 1, pid: 2 }, racing),
      claimRecord(root, { port: 3, pid: 4 }, racing),
    ]);

    expect(claims.filter((claim) => claim === undefined)).toHaveLength(1);
    expect(await readRecord(root)).toEqual(claims.find((claim) => claim !== undefined));
    expect(await readdir(root)).toEqual(["daemon.json"]);
  });

  it("is taken by one of two starts racing to clear a record left behind", async () => {
    const root = await projectsRoot();
    await seedRecord(root, { port: 9, pid: 4242 });

    const claims = await Promise.all([
      claimRecord(root, { port: 1, pid: 2 }, racing),
      claimRecord(root, { port: 3, pid: 4 }, racing),
    ]);

    expect(claims.filter((claim) => claim === undefined)).toHaveLength(1);
    expect(await readRecord(root)).toEqual(claims.find((claim) => claim !== undefined));
    expect(await readdir(root)).toEqual(["daemon.json"]);
  });

  it("takes a name that holds no file at all", async () => {
    const root = await projectsRoot();
    await mkdir(recordPath(root));
    await writeFile(join(recordPath(root), "inside"), "", "utf8");

    expect(await claimRecord(root, { port: 3, pid: 4 }, gone)).toBeUndefined();
    expect(await readFile(recordPath(root), "utf8")).toBe(JSON.stringify({ port: 3, pid: 4 }));
  });
});
