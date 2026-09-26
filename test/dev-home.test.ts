import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { binTargets, readManifest, workspaceRoot } from "../workspace.js";

const WRAPPER = "scripts/dev-home.sh";

const execFileAsync = promisify(execFile);

const script = join(workspaceRoot, WRAPPER);

describe("the development runner", () => {
  // The dev:cli script invokes it by path, so a lost executable bit breaks the
  // command rather than falling back to an interpreter.
  it("is executable", () => {
    expect(statSync(script).mode & 0o111).toBeGreaterThan(0);
  });

  /** Runs the wrapper with TMPDIR set, and returns the HOME it gives the command. */
  function homeUnder(tmp: string): string {
    return execFileSync(script, ["sh", "-c", 'printf %s "$HOME"'], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: tmp },
    });
  }

  /** Runs `body` with a scratch directory that stands in for the temporary directory. */
  function withScratch(body: (scratch: string) => void): void {
    const scratch = mkdtempSync(join(tmpdir(), "dev-home-tmp-"));
    try {
      body(scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("puts HOME in a directory of its own under the temporary directory", () => {
    withScratch((scratch) => {
      const home = homeUnder(`${scratch}/`);

      expect(home).toBe(`${scratch}/tasma-dev`);
      expect(statSync(home).isDirectory()).toBe(true);
      expect(statSync(home).mode & 0o777).toBe(0o700);
    });
  });

  it("gives the same HOME on each run", () => {
    withScratch((scratch) => {
      expect(homeUnder(scratch)).toBe(homeUnder(scratch));
    });
  });

  it("runs every command when several runs create the directory at the same time", async () => {
    for (let round = 0; round < 5; round++) {
      const scratch = mkdtempSync(join(tmpdir(), "dev-home-tmp-"));
      try {
        const markers = [0, 1, 2, 3].map((run) => join(scratch, `ran-${run}`));

        await Promise.all(
          markers.map((marker) => execFileAsync(script, ["touch", marker], { env: { ...process.env, TMPDIR: scratch } })),
        );

        expect(markers.filter((marker) => !existsSync(marker))).toEqual([]);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  it("narrows a directory other accounts can read", () => {
    withScratch((scratch) => {
      const home = join(scratch, "tasma-dev");
      mkdirSync(home);
      chmodSync(home, 0o755);

      homeUnder(scratch);

      expect(statSync(home).mode & 0o777).toBe(0o700);
    });
  });

  /** Runs the wrapper under `scratch` and expects it to refuse without running the command. */
  function expectRefused(scratch: string): void {
    const marker = join(scratch, "ran");

    const run = spawnSync(script, ["touch", marker], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: scratch },
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("is not a directory of this account");
    expect(existsSync(marker)).toBe(false);
  }

  // The target is a directory of this account that a check which follows the
  // link would accept.
  it("refuses a link at the name", () => {
    withScratch((scratch) => {
      const target = join(scratch, "target");
      mkdirSync(target);
      chmodSync(target, 0o755);
      symlinkSync(target, join(scratch, "tasma-dev"));

      expectRefused(scratch);

      expect(statSync(target).mode & 0o777).toBe(0o755);
    });
  });

  it("refuses a link to nothing at the name", () => {
    withScratch((scratch) => {
      symlinkSync(join(scratch, "absent"), join(scratch, "tasma-dev"));

      expectRefused(scratch);

      expect(existsSync(join(scratch, "absent"))).toBe(false);
    });
  });

  it("refuses a file at the name", () => {
    withScratch((scratch) => {
      writeFileSync(join(scratch, "tasma-dev"), "");

      expectRefused(scratch);
    });
  });

  it.each([0o775, 0o777])("refuses a directory other accounts can write (mode %o)", (mode) => {
    withScratch((scratch) => {
      const home = join(scratch, "tasma-dev");
      mkdirSync(home);
      chmodSync(home, mode);

      expectRefused(scratch);

      expect(statSync(home).mode & 0o777).toBe(mode);
    });
  });

  it("shows the error of mkdir when the temporary directory does not exist", () => {
    withScratch((scratch) => {
      const missing = join(scratch, "missing");
      const marker = join(scratch, "ran");

      const run = spawnSync(script, ["touch", marker], {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: missing },
      });

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("mkdir:");
      expect(run.stderr).not.toContain("is not a directory of this account");
      expect(existsSync(marker)).toBe(false);
    });
  });

  it("falls back to /tmp when TMPDIR is empty", () => {
    expect(homeUnder("")).toBe("/tmp/tasma-dev");
  });

  it.each(["relative/dir", "-p"])("falls back to /tmp when TMPDIR is not absolute (%s)", (tmp) => {
    expect(homeUnder(tmp)).toBe("/tmp/tasma-dev");
  });

  /** The cargo and rustup trees the script leaves a command, one per line. */
  function toolchainTrees(env: NodeJS.ProcessEnv): string {
    return execFileSync(script, ["sh", "-c", 'printf "%s\n%s" "$CARGO_HOME" "$RUSTUP_HOME"'], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  // A command that compiles runs under the replaced HOME too, and cargo and
  // rustup keep their trees under HOME: left alone they would download the whole
  // registry into a directory the operating system clears.
  it("keeps the cargo and rustup trees on the real home", () => {
    const trees = toolchainTrees({ HOME: "/var/empty/real-home", CARGO_HOME: "", RUSTUP_HOME: "" });

    expect(trees).toBe("/var/empty/real-home/.cargo\n/var/empty/real-home/.rustup");
  });

  it("leaves the cargo and rustup trees a caller already named", () => {
    const trees = toolchainTrees({ CARGO_HOME: "/var/empty/cargo", RUSTUP_HOME: "/var/empty/rustup" });

    expect(trees).toBe("/var/empty/cargo\n/var/empty/rustup");
  });

  it("passes its arguments through unchanged, a flag included", () => {
    const passed = execFileSync(script, ["printf", "%s\n", "task", "list", "--project", "SAGA"], {
      encoding: "utf8",
    });

    expect(passed).toBe("task\nlist\n--project\nSAGA\n");
  });

  // HOME is changed for the command alone and never for pnpm: under a changed
  // HOME the package manager loses its store and re-resolves the workspace,
  // which is why the script is the last link of the chain rather than the first.
  it("stands after pnpm in every script that wraps a command", () => {
    const scripts = readManifest(".").scripts ?? {};

    for (const [name, command] of Object.entries(scripts).filter(([, command]) => command.includes(WRAPPER))) {
      expect(command, `${name} must reach ${WRAPPER} after pnpm`).toMatch(/^pnpm\s.*\sscripts\/dev-home\.sh\s/);
    }
  });

  // The two commands HOME decides the daemon for: the CLI resolves the tree
  // from HOME itself, and the window reads $HOME/.tasma/daemon.json to find
  // which daemon to forward to. Unwrapped, either one reaches the real tree.
  // `app:dev` builds and runs the crate too, and it does reach the real tree:
  // the wrapper has to follow pnpm in the chain, which the test above holds,
  // and `app:dev` begins with a script of its own. Use `app:start` instead.
  it("wraps every command that resolves its daemon from HOME", () => {
    const scripts = readManifest(".").scripts ?? {};

    for (const name of ["dev:cli", "app:start"]) {
      expect(scripts[name], `${name} must run under the development home`).toContain(WRAPPER);
    }
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
