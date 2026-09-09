import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { execPath } from "node:process";
import { build, resolveConfig } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { binTargets, packageDirs, readManifest, workspaceRoot } from "../workspace.js";

// Read from the manifests rather than listed here: the target pnpm links at
// install time is the one the build has to emit.
const APPS = packageDirs
  .map((dir) => ({ dir, targets: binTargets(readManifest(dir)).map((target) => posix.normalize(target)) }))
  .filter((app) => app.targets.length > 0);

/** The two packages the end-to-end proof drives, which is also where the mirror departs from a plain link. */
const CLI = "apps/cli";
const DAEMON = "apps/daemon";

/**
 * A process id no process can hold: every supported kernel caps its own far
 * below it. The seeded record names it, so the cleanup can tell a record the
 * test wrote from one a daemon wrote.
 */
const UNUSED_PID = 2_147_483_647;

/**
 * The task file the read steps below run against, in three parts, because some
 * steps print a part of it rather than the whole.
 *
 * It is written by this test rather than through the engine: the repository root
 * imports no package, so the one way to put a task in the tree is to write the
 * bytes. It states no workflow and no step, which is what keeps every step's
 * stderr exactly what the verb wrote.
 */
const TASK_HEAD = `---
id: TASM-1
title: Read the tree through the CLI
status: To Do
created: "2026-09-07T10:00:00+02:00"
updated: "2026-09-07T10:00:00+02:00"
next_comment_id: 3
---

# Goal

The body of the planted task.

<!-- task:comment {id: 1, title: "Dev notes #1", created: "2026-09-07T10:05:00+02:00", author: almaz} -->

The body of comment 1.

`;

/** The second marker, written in the block style so it can carry `collapsed`. */
const COLLAPSED_MARKER = `<!-- task:comment
id: 2
title: "Review #1: FAIL"
created: "2026-09-07T10:10:00+02:00"
collapsed: true
-->
`;

const COLLAPSED_BODY = `
The body of comment 2, which the default view leaves out.
`;

const TASK_FILE = `${TASK_HEAD}${COLLAPSED_MARKER}${COLLAPSED_BODY}`;

/** The body the write steps create their task with, and the one an append adds to. */
const SECOND_BODY = "The body of the second task.\n";

/** The body the comment steps write, and the one their append adds to. */
const COMMENT_BODY = "The body of the comment the CLI wrote.\n";

let outRoot = "";

/** Where each app's own config puts its output, relative to the package. */
const outDirs = new Map<string, string>();

function node(
  file: string,
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { env, input = "" } = options;

  return new Promise((resolve) => {
    const child = execFile(execPath, [file, ...args],
      { env: env === undefined ? process.env : { ...process.env, ...env } },
      (error, stdout, stderr) => {
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      });

    // Ended in every case: a step reading standard input waits for the end of
    // it, and a step that reads none never sees the bytes.
    child.stdin?.end(input);
  });
}

/** A port bound and released, so nothing listens on it and the first call of the sequence reaches nothing. */
async function freePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  return port;
}

/**
 * The environment a step runs under: the tree of the test, and a port the
 * operating system chooses.
 *
 * `TASMA_DAEMON_URL` is cleared rather than left inherited. A developer who
 * exports it — which is a shape this CLI expects — would otherwise make every
 * step below act on an address stated by hand, which `daemon start` refuses.
 */
function treeEnv(home: string): Record<string, string> {
  return { HOME: home, TASMA_DAEMON_PORT: "0", TASMA_DAEMON_URL: "" };
}

/** Where the tree of a home records its daemon. */
function recordPathIn(home: string): string {
  return join(home, ".tasma", "daemon.json");
}

/** Where the tree of a home holds the planted project. */
function projectDirIn(home: string): string {
  return join(home, ".tasma", "projects", "TASM");
}

/** Where that project holds its task files. */
function tasksDirIn(home: string): string {
  return join(projectDirIn(home), "tasks");
}

/** Where one of them stands, which a store note quotes as its location. */
function taskPathIn(home: string, id: string): string {
  return join(tasksDirIn(home), `${id}.md`);
}

/** What the tree's record states, or nothing where it holds none. */
function recordIn(home: string): { port: number; pid: number } | undefined {
  const path = recordPathIn(home);

  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { port: number; pid: number }) : undefined;
}

/** Where the build put a package's single declared executable. */
function executable(dir: string): string {
  const [target, ...extra] = APPS.find((app) => app.dir === dir)?.targets ?? [];

  if (target === undefined || extra.length > 0) {
    throw new Error(`${dir} must declare exactly one "bin" target`);
  }

  return join(outRoot, dir, target);
}

describe("the built executables", () => {
  // The explicit timeout is for a cold machine, where vitest's 5 s default is
  // not enough to run the builds.
  beforeAll(async () => {
    outRoot = mkdtempSync(join(tmpdir(), "tasma-executables-"));

    for (const app of APPS) {
      const root = join(workspaceRoot, app.dir);
      // The app's own config decides the output directory as well as the file
      // name; the test moves only the root that directory hangs off, so what it
      // builds is what `pnpm build` builds.
      const resolved = await resolveConfig({ root, logLevel: "silent" }, "build");
      const outDir = posix.normalize(resolved.build.outDir);

      outDirs.set(app.dir, outDir);

      await build({
        root,
        logLevel: "silent",
        // The mirror repeats the package's own layout, so a declared bin target
        // resolves against it unchanged. Vite refuses to empty a directory
        // outside the project root unless it is told to.
        build: { outDir: join(outRoot, app.dir, outDir), emptyOutDir: true },
      });

      // A build leaves the real dependencies external, so an artifact resolves
      // them by walking up out of its own directory. The mirror gives each
      // package the dependency root that walk reaches in place — its own, not
      // the workspace's, so a dependency the package does not declare fails here
      // as it would in an install of that package alone.
      //
      // The CLI is the exception: it finds the daemon through module resolution,
      // and the daemon it has to find is the one just built rather than the
      // workspace's own dist.
      if (app.dir !== CLI) {
        symlinkSync(join(root, "node_modules"), join(outRoot, app.dir, "node_modules"), "dir");
      }
    }

    // The manifest beside the built daemon, because that is what names the
    // executable, and one entry in the CLI's dependency root pointing at it. The
    // CLI's own dependencies are inlined by its build, so nothing else belongs
    // there and an undeclared dependency still fails.
    copyFileSync(join(workspaceRoot, DAEMON, "package.json"), join(outRoot, DAEMON, "package.json"));
    mkdirSync(join(outRoot, CLI, "node_modules", "@tasma"), { recursive: true });
    symlinkSync(join(outRoot, DAEMON), join(outRoot, CLI, "node_modules", "@tasma", "daemon"), "dir");
  }, 30_000);

  afterAll(() => {
    rmSync(outRoot, { recursive: true, force: true });
  });

  // Without this the manifest is checked against a directory the test supplies
  // itself, and an app that built somewhere other than its declared bin's
  // directory would still pass.
  it("are built into the directory their manifest's bin target names", () => {
    expect(APPS.length).toBeGreaterThan(0);

    for (const app of APPS) {
      for (const target of app.targets) {
        expect(outDirs.get(app.dir), `${app.dir} declares ${target}`).toBe(posix.dirname(target));
      }
    }
  });

  it("land at the path their manifest declares, with a shebang so a linked bin runs", () => {
    for (const app of APPS) {
      for (const target of app.targets) {
        const shebang = readFileSync(join(outRoot, app.dir, target), "utf8").startsWith("#!/usr/bin/env node");

        expect(shebang, `${app.dir} declares ${target}`).toBe(true);
      }
    }
  });

  it("answer tasma --version on stdout", async () => {
    const { code, stdout } = await node(executable(CLI), ["--version"]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/^tasma \d+\.\d+\.\d+\n$/);
  });

  // Run with a port it must refuse, so the artifact reports and exits instead of
  // starting a daemon against the real home tree. That still proves what the
  // build has to get right: the artifact imports the engine, and its
  // extension-bearing specifiers resolve inside the bundle.
  it("refuse a bad daemon port on stderr, without starting a daemon", async () => {
    const { code, stdout, stderr } = await node(executable(DAEMON), ["--port", "nonsense"]);

    expect(code).toBe(1);
    expect(stderr).toBe('tasma-daemon: --port must be a whole number from 0 to 65535: "nonsense"\n');
    expect(stdout).toBe("");
  });

  // The one place both artifacts exist, which is what the daemon's lifecycle
  // through the CLI can only be proved against: the CLI resolves an executable,
  // spawns it and reaches it, and none of that is exercised by a fake.
  describe("driving the daemon of a tree", () => {
    let home = "";
    let url = "";

    /**
     * The tree the whole sequence runs in, holding a record that names a port
     * nothing listens on.
     *
     * `TASMA_DAEMON_PORT` alone would not keep the CLI off 8278: an empty home
     * holds no record, the location rule falls back to the built-in address, and
     * a real daemon serving the developer's own tree answers there. The seeded
     * record is what sends the first call to a dead port instead, after which
     * start-on-demand runs and the spawned daemon claims the tree — the daemon
     * never consults the recorded process.
     */
    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), "tasma-tree-"));
      mkdirSync(dirname(recordPathIn(home)), { recursive: true });
      writeFileSync(recordPathIn(home), JSON.stringify({ port: await freePort(), pid: UNUSED_PID }));

      // A project is a directory whose name is a tag, so planting one is
      // creating the directory its task file stands in. It declares no
      // configuration file, which is what makes its name and its path absent and
      // its statuses the built-in ones.
      const tasks = tasksDirIn(home);

      mkdirSync(tasks, { recursive: true });
      writeFileSync(join(tasks, "TASM-1.md"), TASK_FILE);
    });

    afterAll(() => {
      const record = recordIn(home);

      // Never the seeded record: its process is nobody's. A failed step leaves
      // no daemon behind, and the removal never masks what failed.
      if (record !== undefined && record.pid !== UNUSED_PID) {
        try {
          process.kill(record.pid, "SIGTERM");
        } catch {
          // Already gone, which is what the signal was for.
        }
      }

      rmSync(home, { recursive: true, force: true });
    });

    it("starts one on demand, and records where it listens", async () => {
      const { code, stdout, stderr } = await node(executable(CLI), ["daemon", "start"], { env: treeEnv(home) });
      const record = recordIn(home);

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(record?.pid).not.toBe(UNUSED_PID);
      url = `http://127.0.0.1:${record?.port ?? 0}`;
      expect(stdout).toMatch(/^tasma-daemon \d+\.\d+\.\d+ at http:\/\/127\.0\.0\.1:\d+\n$/);
      expect(stdout).toContain(` at ${url}\n`);
    });

    it("reports the same daemon through the record", async () => {
      const { code, stdout } = await node(executable(CLI), ["daemon", "status"], { env: treeEnv(home) });

      expect(code).toBe(0);
      expect(stdout).toContain(` at ${url}\n`);
    });

    // The reads, against the real daemon, the real engine and the built CLI:
    // the one place the whole path from an argument to a file on disk is proved.
    it("lists the projects of the tree", async () => {
      const { code, stdout, stderr } = await node(executable(CLI), ["project", "list"], { env: treeEnv(home) });

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toBe("TASM  -  -\n");
    });

    it("lists the tasks of one project", async () => {
      const { code, stdout, stderr } = await node(executable(CLI), ["task", "list", "--project", "TASM"], { env: treeEnv(home) });

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toBe("TASM-1  To Do  -  -  Read the tree through the CLI\n");
    });

    it("prints the task without the collapsed body, and names what it left out", async () => {
      const { code, stdout, stderr } = await node(executable(CLI), ["task", "view", "TASM-1"], { env: treeEnv(home) });

      expect(code).toBe(0);
      expect(stdout).toBe(`${TASK_HEAD}${COLLAPSED_MARKER}`);
      expect(stderr).toBe("tasma: 1 comment collapsed (2): comment view TASM-1 <n> prints one, task view TASM-1 --full prints all\n");
    });

    it("prints the whole file with --full, the collapsed body included", async () => {
      const { code, stdout, stderr } = await node(executable(CLI), ["task", "view", "TASM-1", "--full"], { env: treeEnv(home) });

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toBe(TASK_FILE);
    });

    it("maps the comments of the task", async () => {
      const { code, stdout, stderr } = await node(executable(CLI), ["comment", "list", "TASM-1"], { env: treeEnv(home) });
      const lines = stdout.split("\n").filter((line) => line !== "");

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("almaz");
      expect(lines[0]).toContain("Dev notes #1");
      expect(lines[1]).toContain("collapsed");
      expect(lines[1]).toContain("Review #1: FAIL");
    });

    it("prints one collapsed comment alone, whole", async () => {
      const { code, stdout, stderr } = await node(executable(CLI), ["comment", "view", "TASM-1", "2"], { env: treeEnv(home) });

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toBe(`${COLLAPSED_MARKER}${COLLAPSED_BODY}`);
    });

    // The writes, as one sequence: each step acts on what the step before it
    // left, so they hold only in the order they stand in.
    it("creates a task from a file, and reports what the write corrected", async () => {
      const path = join(home, "body.md");

      writeFileSync(path, SECOND_BODY);

      const { code, stdout, stderr } = await node(executable(CLI), [
        "task", "create", "-p", "TASM", "--title", "Second",
        "--priority", "high", "--label", "Infra", "--body-file", path,
      ], { env: treeEnv(home) });

      expect(code).toBe(0);
      expect(stdout).toBe("TASM-2\n");
      // Validation runs before the file has a name, so its note quotes the
      // directory the task is about to stand in.
      expect(stderr).toBe(
        `tasma: note: label-case-converted: the label "Infra" was stored as "infra" (${tasksDirIn(home)})\n`
        + "tasma: note: next-task-id-rebuilt: the task counter was rebuilt from the files on disk and is now 2 "
        + `(${join(projectDirIn(home), "state.yml")})\n`,
      );
    });

    it("shows the task the create wrote", async () => {
      const { code, stdout, stderr } = await node(executable(CLI), ["task", "view", "TASM-2"], { env: treeEnv(home) });

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toContain("priority: high\n");
      expect(stdout).toContain("  - infra\n");
      expect(stdout).toContain(SECOND_BODY);
    });

    it("corrects the case of a status it stores, and removes the field a clear names", async () => {
      const written = await node(executable(CLI),
        ["task", "edit", "TASM-2", "--status", "in progress", "--clear", "priority"], { env: treeEnv(home) });

      expect(written.code).toBe(0);
      expect(written.stdout).toBe("TASM-2\n");
      expect(written.stderr).toBe(
        'tasma: note: status-case-corrected: status "in progress" was stored as the declared "In Progress" '
        + `(${taskPathIn(home, "TASM-2")})\n`,
      );

      const { stdout } = await node(executable(CLI), ["task", "view", "TASM-2"], { env: treeEnv(home) });

      expect(stdout).toContain("status: In Progress\n");
      expect(stdout).not.toContain("priority:");
    });

    it("adds text after the stored body, read from a pipe", async () => {
      const written = await node(executable(CLI),
        ["task", "edit", "TASM-2", "--body-file", "-", "--append"], { env: treeEnv(home), input: "more" });

      expect(written.stderr).toBe("");
      expect(written.code).toBe(0);
      expect(written.stdout).toBe("TASM-2\n");

      const { stdout } = await node(executable(CLI), ["task", "view", "TASM-2"], { env: treeEnv(home) });

      expect(stdout).toContain(`${SECOND_BODY.trimEnd()}\n\nmore\n`);
    });

    it("deletes the task, and the file with it", async () => {
      const { code, stdout, stderr } = await node(executable(CLI), ["task", "delete", "TASM-2"], { env: treeEnv(home) });

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toBe("TASM-2\n");
      expect(existsSync(taskPathIn(home, "TASM-2"))).toBe(false);

      const listed = await node(executable(CLI), ["task", "list", "-p", "TASM"], { env: treeEnv(home) });

      expect(listed.stdout).toBe("TASM-1  To Do  -  -  Read the tree through the CLI\n");
    });

    // The comment writes, on the task the read steps planted: each acts on what
    // the step before it left, and the id the add issues carries through them.
    it("adds a comment from a pipe, and issues its id", async () => {
      const { code, stdout, stderr } = await node(executable(CLI),
        ["comment", "add", "TASM-1", "--title", "Smoke", "--body-file", "-"],
        { env: treeEnv(home), input: COMMENT_BODY });

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toBe("3\n");
    });

    it("shows the comment the add wrote, collapsed by nothing", async () => {
      const { code, stdout, stderr } = await node(executable(CLI), ["comment", "list", "TASM-1"], { env: treeEnv(home) });
      const lines = stdout.split("\n").filter((line) => line !== "");

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(lines).toHaveLength(3);
      expect(lines[2]).toContain("Smoke");
      expect(lines[2]).not.toContain("collapsed");
    });

    // The two read paths agreeing about one comment is the invariant the whole
    // pair of them stands on: the default view hides the body, and the comment
    // read prints it whole.
    it("collapses it, which the task view then hides and the comment view still prints", async () => {
      const written = await node(executable(CLI),
        ["comment", "edit", "TASM-1", "3", "--collapsed"], { env: treeEnv(home) });

      expect(written.stderr).toBe("");
      expect(written.code).toBe(0);
      expect(written.stdout).toBe("3\n");

      const viewed = await node(executable(CLI), ["task", "view", "TASM-1"], { env: treeEnv(home) });

      expect(viewed.stderr)
        .toBe("tasma: 2 comments collapsed (2, 3): comment view TASM-1 <n> prints one, task view TASM-1 --full prints all\n");
      expect(viewed.stdout).not.toContain(COMMENT_BODY);

      const alone = await node(executable(CLI), ["comment", "view", "TASM-1", "3"], { env: treeEnv(home) });

      expect(alone.code).toBe(0);
      expect(alone.stdout).toContain(COMMENT_BODY);
      expect(alone.stderr).toBe("");
    });

    it("adds text after the stored body of the comment, read from a pipe", async () => {
      const written = await node(executable(CLI),
        ["comment", "edit", "TASM-1", "3", "--body-file", "-", "--append"], { env: treeEnv(home), input: "more" });

      expect(written.stderr).toBe("");
      expect(written.code).toBe(0);
      expect(written.stdout).toBe("3\n");

      const { stdout } = await node(executable(CLI), ["comment", "view", "TASM-1", "3"], { env: treeEnv(home) });

      expect(stdout).toContain(`${COMMENT_BODY.trimEnd()}\n\nmore\n`);
    });

    it("deletes the comment, and the row with it", async () => {
      const { code, stdout, stderr } = await node(executable(CLI),
        ["comment", "delete", "TASM-1", "3"], { env: treeEnv(home) });

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toBe("3\n");

      const listed = await node(executable(CLI), ["comment", "list", "TASM-1"], { env: treeEnv(home) });
      const lines = listed.stdout.split("\n").filter((line) => line !== "");

      expect(lines).toHaveLength(2);
      expect(listed.stdout).not.toContain("Smoke");
    });

    it("stops it and leaves no record behind", async () => {
      const { code, stdout, stderr } = await node(executable(CLI), ["daemon", "stop"], { env: treeEnv(home) });

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toBe(`tasma-daemon at ${url} stopped\n`);
      expect(existsSync(recordPathIn(home))).toBe(false);
    });

    // Reaching the goal state is exit 0, whether this call did the stopping.
    it("says so when there is nothing left to stop", async () => {
      const { code, stdout } = await node(executable(CLI), ["daemon", "stop"], { env: treeEnv(home) });

      expect(code).toBe(0);
      expect(stdout).toBe("no daemon is running\n");
    });
  });
});
