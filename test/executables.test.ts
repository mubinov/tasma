import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { execPath } from "node:process";
import { build, resolveConfig } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { binTargets, packageDirs, readManifest, workspaceRoot } from "../workspace.js";

// Read from the manifests rather than listed here: the target pnpm links at
// install time is the one the build has to emit.
const APPS = packageDirs
  .map((dir) => ({ dir, targets: binTargets(readManifest(dir)).map((target) => posix.normalize(target)) }))
  .filter((app) => app.targets.length > 0);

let outRoot = "";

/** Where each app's own config puts its output, relative to the package. */
const outDirs = new Map<string, string>();

function node(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(execPath, [file, ...args], (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
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
    }
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
    const { code, stdout } = await node(executable("apps/cli"), ["--version"]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/^tasma \d+\.\d+\.\d+\n$/);
  });

  it("report that the daemon is not implemented, on stderr", async () => {
    const { code, stdout, stderr } = await node(executable("apps/daemon"), []);

    expect(code).toBe(1);
    expect(stderr).toBe("tasma-daemon: not implemented\n");
    expect(stdout).toBe("");
  });
});
