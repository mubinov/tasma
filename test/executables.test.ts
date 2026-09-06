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

let outRoot = "";

/** Where each app's own config puts its output, relative to the package. */
const outDirs = new Map<string, string>();

function node(
  file: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(execPath, [file, ...args], { env: env === undefined ? process.env : { ...process.env, ...env } },
      (error, stdout, stderr) => {
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      });
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
      const { code, stdout, stderr } = await node(executable(CLI), ["daemon", "start"], treeEnv(home));
      const record = recordIn(home);

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(record?.pid).not.toBe(UNUSED_PID);
      url = `http://127.0.0.1:${record?.port ?? 0}`;
      expect(stdout).toMatch(/^tasma-daemon \d+\.\d+\.\d+ at http:\/\/127\.0\.0\.1:\d+\n$/);
      expect(stdout).toContain(` at ${url}\n`);
    });

    it("reports the same daemon through the record", async () => {
      const { code, stdout } = await node(executable(CLI), ["daemon", "status"], treeEnv(home));

      expect(code).toBe(0);
      expect(stdout).toContain(` at ${url}\n`);
    });

    it("stops it and leaves no record behind", async () => {
      const { code, stdout, stderr } = await node(executable(CLI), ["daemon", "stop"], treeEnv(home));

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toBe(`tasma-daemon at ${url} stopped\n`);
      expect(existsSync(recordPathIn(home))).toBe(false);
    });

    // Reaching the goal state is exit 0, whether this call did the stopping.
    it("says so when there is nothing left to stop", async () => {
      const { code, stdout } = await node(executable(CLI), ["daemon", "stop"], treeEnv(home));

      expect(code).toBe(0);
      expect(stdout).toBe("no daemon is running\n");
    });
  });
});
