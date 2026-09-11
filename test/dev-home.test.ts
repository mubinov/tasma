import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { binTargets, readManifest, workspaceRoot } from "../workspace.js";

const script = join(workspaceRoot, "scripts", "dev-home.sh");

describe("the development runner", () => {
  // The dev:cli script invokes it by path, so a lost executable bit breaks the
  // command rather than falling back to an interpreter.
  it("is executable", () => {
    expect(statSync(script).mode & 0o111).toBeGreaterThan(0);
  });

  it("puts HOME on a tree under /tmp and creates it", () => {
    const home = execFileSync(script, ["sh", "-c", 'printf %s "$HOME"'], { encoding: "utf8" });

    expect(home.startsWith("/tmp/")).toBe(true);
    expect(existsSync(home)).toBe(true);
  });

  it("passes its arguments through unchanged, a flag included", () => {
    const passed = execFileSync(script, ["printf", "%s\n", "task", "list", "--project", "TASM"], {
      encoding: "utf8",
    });

    expect(passed).toBe("task\nlist\n--project\nTASM\n");
  });

  // HOME is changed for the CLI alone and never for pnpm: under a changed HOME
  // the package manager loses its store and re-resolves the workspace, which is
  // why the script is the last link of the chain rather than the first.
  it("stands after pnpm in the dev:cli script", () => {
    const devCli = readManifest(".").scripts?.["dev:cli"] ?? "";

    expect(devCli).toMatch(/^pnpm\s.*\sscripts\/dev-home\.sh\s/);
  });

  // pnpm exports the directory it was invoked from, which is where the CLI has
  // to run: the acting project is resolved from the working directory, and a
  // root script otherwise pins every invocation to the repository.
  it("runs the command in the directory the invocation came from", () => {
    const invocation = mkdtempSync(join(tmpdir(), "dev-home-cwd-"));

    const where = execFileSync(script, ["sh", "-c", "pwd"], {
      encoding: "utf8",
      cwd: workspaceRoot,
      env: { ...process.env, INIT_CWD: invocation },
    });

    expect(realpathSync(where.trim())).toBe(realpathSync(invocation));
    rmSync(invocation, { recursive: true, force: true });
  });

  it("stays where it was invoked when nothing names another directory", () => {
    const env = { ...process.env };
    delete env.INIT_CWD;

    const where = execFileSync(script, ["sh", "-c", "pwd"], {
      encoding: "utf8",
      cwd: workspaceRoot,
      env,
    });

    expect(realpathSync(where.trim())).toBe(realpathSync(workspaceRoot));
  });
});

describe("the dev:cli script", () => {
  const devCli = readManifest(".").scripts?.["dev:cli"] ?? "";

  // pnpm links node_modules/.bin during an install, and only where the target
  // already exists: on a fresh clone the install precedes the first build, so
  // the shim is never written and no later install re-links it. The built file
  // is the same entry point without that dependency, and it is mode 644, so
  // node is named rather than the file executed. The path is absolute because
  // the runner changes directory before it runs the command.
  it("runs the built entry point rather than the install-time shim", () => {
    const entry = binTargets(readManifest("apps/cli")).find((target) =>
      devCli.includes(`node "$PWD/${posix.join("apps/cli", target)}"`),
    );

    expect(entry, "dev:cli must run apps/cli's own bin target").toBeTypeOf("string");
    expect(devCli).not.toContain("node_modules/.bin");
  });

  // The build reports on the same stream the CLI answers on, so a capture of
  // the mandated runner's output would carry the build log inside the answer.
  it("keeps the build off the stream the CLI answers on", () => {
    expect(devCli.slice(0, devCli.indexOf("&&"))).toContain(">&2");
  });

  // `daemon start` spawns the daemon's own built file, and a --filter build
  // covers the named package alone: a CLI-only build leaves the daemon absent
  // on a fresh clone and stale after any edit under apps/daemon/src.
  it("builds every package whose built file it runs", () => {
    const build = devCli.slice(0, devCli.indexOf("&&"));

    for (const name of ["@tasma/cli", "@tasma/daemon"]) {
      expect(build, `dev:cli must build ${name}`).toContain(name);
    }
  });
});
