import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SkillInstall } from "@tasma/protocol";
import type { AgentAdapter, AgentEnv } from "../../src/agents/adapter.js";
import { CLAUDE_SESSION_VARIABLES } from "../../src/agents/process.js";
import type { ShellEnv } from "../../src/agents/shell-env.js";
import { createSkillInstaller } from "../../src/setup/skill-install.js";
import type { SkillInstaller } from "../../src/setup/skill-install.js";
import { target, until, untilGone, untilPid } from "../helpers.js";

/** A child that the next spawn gives in place of a real one. */
const spawning = vi.hoisted(() => ({ next: undefined as ChildProcess | undefined }));

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn(...args: Parameters<typeof actual.spawn>) {
      const { next } = spawning;
      spawning.next = undefined;
      return next ?? actual.spawn(...args);
    },
  };
});

/** Runs before each `mkdtemp`, when a test sets it. */
const making = vi.hoisted(() => ({ before: undefined as (() => void) | undefined }));

/** A folder that `stat` gives to another account, when a test sets it. */
const owning = vi.hoisted(() => ({ foreign: undefined as string | undefined }));

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();

  return {
    ...actual,
    mkdtemp(...args: Parameters<typeof actual.mkdtemp>) {
      making.before?.();
      return actual.mkdtemp(...args);
    },
    async stat(...args: Parameters<typeof actual.stat>) {
      const info = await actual.stat(...args);
      return args[0] === owning.foreign ? Object.assign(info, { uid: 99_999 }) : info;
    },
  };
});

const AGENTS = ["alpha-agent", "beta-agent"];

const LONG_HOLD_MS = 10_000;

const SHORT_HOLD_MS = 200;

const STOPPED = "The daemon stopped.";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The skill file of a fake adapter in `home`. */
function skillFile(home: string, agent: string): string {
  return join(home, `.${agent}`, "skills", "tasma", "SKILL.md");
}

/** An adapter whose one skill file is in the `HOME` of the environment it gets. */
function fakeAdapter(skillsAgent: string): AgentAdapter {
  return {
    agent: "claude",
    launch: () => ({ missing: "No agent binary" }),
    loggedIn: async () => true,
    skillFiles: (env) => [skillFile(env.HOME ?? "/nowhere", skillsAgent)],
    skillListed: async () => false,
    skillsAgent,
    notLoggedIn: "Log in to the agent first",
    sessionGone: "The agent lost the chat",
    projectSessionGone: "The agent lost the project chat",
    filterUpdate: (update) => update,
  };
}

/** Shell lines that write the skill file of each fake adapter in `$HOME`. */
const WRITES_SKILLS = AGENTS.map(
  (agent) => `/bin/mkdir -p "$HOME/.${agent}/skills/tasma" && : > "$HOME/.${agent}/skills/tasma/SKILL.md"`,
).join("\n");

/** A directory that holds an executable `npx` that runs `script`. */
async function npxRunning(script: string): Promise<string> {
  const dir = await target();
  await writeFile(join(dir, "npx"), `#!/bin/sh\n${script}\n`);
  await chmod(join(dir, "npx"), 0o755);
  return dir;
}

type InstallerOptions = { workParent?: string; limitMs?: number; holdMs?: number };

function installerWith(
  shellEnv: (signal: AbortSignal) => Promise<ShellEnv>,
  options: InstallerOptions = {},
): SkillInstaller {
  const installer = createSkillInstaller({
    adapters: AGENTS.map(fakeAdapter),
    env: { HOME: homedir(), PATH: "/usr/bin" },
    shellEnv,
    workParent: options.workParent,
    limitMs: options.limitMs,
    holdMs: options.holdMs ?? LONG_HOLD_MS,
  });
  onTestFinished(() => installer.stop());
  return installer;
}

/** An installer whose login shell gives `env`. */
function installerOver(env: AgentEnv, options: InstallerOptions = {}): SkillInstaller {
  return installerWith(async () => ({ env }), options);
}

/** An installer whose login shell has `npx` running `script` on its `PATH`, and `home` as `HOME`. */
async function installerRunning(
  script: string,
  options: InstallerOptions = {},
): Promise<{ installer: SkillInstaller; home: string }> {
  const home = await target();
  return { installer: installerOver({ PATH: await npxRunning(script), HOME: home }, options), home };
}

/**
 * An `npx` that ignores SIGTERM, prints `print` and then waits in a process
 * that it does not `exec`. It writes its own process id into `out/npx`, and the
 * id of the process that waits into `out/inner`.
 */
function lingeringNpx(out: string, print: string): string {
  return [
    "trap '' TERM",
    `echo $$ > '${out}/npx'`,
    print,
    `/bin/sh -c "echo \\$\\$ > '${out}/inner'; exec /bin/sleep 10"`,
  ].join("\n");
}

/** Asks with `run` until the install no longer runs. */
async function settled(installer: SkillInstaller, run: string): Promise<SkillInstall> {
  for (;;) {
    const answer = await installer.install(run);
    if (answer.result !== "running") return answer;
  }
}

function runOf(answer: SkillInstall): string {
  if (answer.result !== "running") throw new Error(`the install ended: ${JSON.stringify(answer)}`);
  return answer.run;
}

describe("the skill install", () => {
  it("runs the pinned skills CLI for the agent of each adapter, in a new empty folder in the Library/Caches of the daemon HOME that it removes, with stdin closed", async () => {
    const out = await target();
    const { installer } = await installerRunning([
      // `read` gets the end of stdin at once only when stdin is closed.
      `if read -r line; then echo open > '${out}/stdin'; else echo closed > '${out}/stdin'; fi`,
      `printf '%s\\n' "$@" > '${out}/args'`,
      `pwd > '${out}/cwd'`,
      `/bin/ls -A > '${out}/listing'`,
      WRITES_SKILLS,
    ].join("\n"));

    await expect(installer.install()).resolves.toEqual({ result: "installed" });

    expect((await readFile(join(out, "args"), "utf8")).split("\n")).toEqual([
      "--yes",
      "skills@1.7.6",
      "add",
      "https://github.com/mubinov/tasma-skill",
      "-g",
      "-y",
      "--json",
      "-a",
      ...AGENTS,
      "",
    ]);
    expect(await readFile(join(out, "stdin"), "utf8")).toBe("closed\n");
    const cwd = (await readFile(join(out, "cwd"), "utf8")).trim();
    expect(dirname(cwd)).toBe(await realpath(join(homedir(), "Library", "Caches")));
    expect(await readFile(join(out, "listing"), "utf8")).toBe("");
    expect(existsSync(cwd)).toBe(false);
  });

  it("gives the command the environment of the login shell with no relative and no node_modules folder on PATH, no Claude session variables, no telemetry or colour, and its working folder as TMPDIR", async () => {
    const out = await target();
    const home = await target();
    const packageBin = join(await target(), "node_modules", ".bin");
    await mkdir(packageBin, { recursive: true });
    await writeFile(join(packageBin, "npx"), `#!/bin/sh\n: > '${out}/wrong'\n`, { mode: 0o755 });
    const dir = await npxRunning(`/usr/bin/env > '${out}/env'\npwd > '${out}/cwd'\n${WRITES_SKILLS}`);
    const session = Object.fromEntries(CLAUDE_SESSION_VARIABLES.map((name) => [name, "1"]));
    const installer = installerOver({
      ...session,
      PATH: ["node_modules/.bin", packageBin, dir, "", "/usr/bin"].join(delimiter),
      HOME: home,
      CLAUDE_CONFIG_DIR: "/srv/agent",
      ANTHROPIC_MODEL: "opus",
      TMPDIR: "/srv/shared-tmp",
    });

    await expect(installer.install()).resolves.toEqual({ result: "installed" });

    const env = (await readFile(join(out, "env"), "utf8")).split("\n");
    expect(env).toContain(`PATH=${[dir, "/usr/bin"].join(delimiter)}`);
    expect(env).toContain(`HOME=${home}`);
    expect(env).toContain("CLAUDE_CONFIG_DIR=/srv/agent");
    expect(env).toContain("ANTHROPIC_MODEL=opus");
    expect(env).toContain("DISABLE_TELEMETRY=1");
    expect(env).toContain("NO_COLOR=1");
    expect(env).toContain(`TMPDIR=${(await readFile(join(out, "cwd"), "utf8")).trim()}`);
    for (const name of CLAUDE_SESSION_VARIABLES) expect(env.some((line) => line.startsWith(`${name}=`))).toBe(false);
    expect(existsSync(join(out, "wrong"))).toBe(false);
  });

  it("gives failed with stderr, then stdout, for an exit code other than 0, also when the skill files exist", async () => {
    const { installer } = await installerRunning(`${WRITES_SKILLS}\nprintf 'Cloning failed' >&2\necho '{"ok":false}'\nexit 1`);

    await expect(installer.install()).resolves.toEqual({ result: "failed", output: 'Cloning failed\n{"ok":false}\n' });
  });

  it("gives failed with the output for a command that a signal ends", async () => {
    const { installer } = await installerRunning(`${WRITES_SKILLS}\necho 'Cloning' >&2\nkill -9 $$`);

    await expect(installer.install()).resolves.toEqual({ result: "failed", output: "Cloning\n" });
  });

  it("gives failed with a line that names the skill file of an adapter whose file the command did not write", async () => {
    const { installer, home } = await installerRunning([
      "/bin/mkdir -p \"$HOME/.alpha-agent/skills/tasma\" && : > \"$HOME/.alpha-agent/skills/tasma/SKILL.md\"",
      "echo '{\"ok\":true}'",
    ].join("\n"));

    await expect(installer.install()).resolves.toEqual({
      result: "failed",
      output: `{"ok":true}\nThe command ended, but the skill is not in ${skillFile(home, "beta-agent")}.`,
    });
  });

  it("does not take a folder as the skill file", async () => {
    const { installer, home } = await installerRunning(`${WRITES_SKILLS}\n/bin/rm "$HOME/.beta-agent/skills/tasma/SKILL.md"\n/bin/mkdir "$HOME/.beta-agent/skills/tasma/SKILL.md"`);

    await expect(installer.install()).resolves.toEqual({
      result: "failed",
      output: `The command ended, but the skill is not in ${skillFile(home, "beta-agent")}.`,
    });
  });

  it("keeps the last 64 KiB of the output", async () => {
    const { installer } = await installerRunning(
      "/usr/bin/head -c 70000 /dev/zero | /usr/bin/tr '\\0' x >&2\n/usr/bin/head -c 70000 /dev/zero | /usr/bin/tr '\\0' y\necho END\nexit 1",
    );

    const answer = await installer.install();

    if (answer.result !== "failed") throw new Error(`the install did not fail: ${answer.result}`);
    expect(Buffer.byteLength(answer.output)).toBe(64 * 1024);
    expect(answer.output).toMatch(/^y+END\n$/);
  });

  it("starts the last 64 KiB of the output at the first byte of a character", async () => {
    // The cut lands on the second byte of a character of 4 bytes.
    const { installer } = await installerRunning("/usr/bin/yes '😀' | /usr/bin/head -n 20000 | /usr/bin/tr -d '\\n' >&2\nprintf x >&2\nexit 1");

    await expect(installer.install()).resolves.toEqual({ result: "failed", output: `${"😀".repeat(16_383)}x` });
  });

  it("keeps at most 64 KiB of an output that is not UTF-8", async () => {
    const { installer } = await installerRunning("/usr/bin/head -c 70000 /dev/zero | /usr/bin/tr '\\0' '\\377'\nexit 1");

    await expect(installer.install()).resolves.toEqual({ result: "failed", output: "\uFFFD".repeat(21_845) });
  });

  it("gives the result of an install when its working folder cannot be removed", async () => {
    const out = await target();
    const { installer } = await installerRunning(`${WRITES_SKILLS}\npwd > '${out}/cwd'\n/bin/mkdir locked && : > locked/file && /bin/chmod 500 locked`);
    onTestFinished(async () => {
      const cwd = (await readFile(join(out, "cwd"), "utf8")).trim();
      await chmod(join(cwd, "locked"), 0o700);
      await rm(cwd, { recursive: true, force: true });
    });

    await expect(installer.install()).resolves.toEqual({ result: "installed" });
  });

  it.each([
    ["no npx on PATH", async () => ({ PATH: await target() })],
    ["no PATH", async () => ({})],
    ["an npx that this user cannot run", async () => {
      const dir = await target();
      await writeFile(join(dir, "npx"), "#!/bin/sh\n", { mode: 0o644 });
      return { PATH: dir };
    }],
    ["an npx only inside node_modules", async () => {
      const packageBin = join(await target(), "node_modules", ".bin");
      await mkdir(packageBin, { recursive: true });
      await writeFile(join(packageBin, "npx"), "#!/bin/sh\n", { mode: 0o755 });
      return { PATH: packageBin };
    }],
  ])("gives npx-missing with %s in the login shell", async (_name, env: () => Promise<AgentEnv>) => {
    const installer = installerOver(await env());

    await expect(installer.install()).resolves.toEqual({ result: "npx-missing" });
  });

  it("gives failed with the message of a login-shell read that failed, and starts no command", async () => {
    const message = "Tasma could not read the environment of your login shell (/bin/zsh): it did not finish in 10 seconds";
    const installer = installerWith(async () => ({ failed: message }));

    await expect(installer.install()).resolves.toEqual({ result: "failed", output: message });
  });

  it("gives failed with the cause of a login-shell read that throws", async () => {
    const installer = installerWith(() => Promise.reject(new Error("the read broke")));

    await expect(installer.install()).resolves.toEqual({ result: "failed", output: "the read broke" });
  });

  it("gives failed with the error of a command that the system cannot start", async () => {
    const dir = await target();
    // No `#!` line: the exec fails with ENOEXEC.
    await writeFile(join(dir, "npx"), "echo started\n", { mode: 0o755 });
    const installer = installerOver({ PATH: dir, HOME: dir });

    const answer = await installer.install();

    expect(answer).toMatchObject({ result: "failed", output: expect.stringContaining("ENOEXEC") as string });
  });

  it("gives failed with the error of a spawn that fails after the call", async () => {
    const dir = await npxRunning("exit 0");
    const failedSpawn = { pid: undefined, stdout: null, stderr: null };
    const child = Object.assign(new EventEmitter(), failedSpawn) as unknown as ChildProcess;
    spawning.next = child;
    const installer = installerOver({ PATH: dir, HOME: dir });

    const answer = installer.install();
    await until(() => spawning.next === undefined, "the installer spawned the command");
    child.emit("error", new Error("spawn EAGAIN"));

    await expect(answer).resolves.toEqual({ result: "failed", output: "spawn EAGAIN" });
  });

  it("gives failed with the error that a started command emits", async () => {
    const dir = await npxRunning("exit 0");
    const child = Object.assign(new EventEmitter(), {
      // Above the largest process id, so that a kill reaches no real process.
      pid: 99_999_999,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    spawning.next = child;
    const installer = installerOver({ PATH: dir, HOME: dir });

    const answer = installer.install();
    await until(() => spawning.next === undefined, "the installer spawned the command");
    child.emit("error", new Error("kill EPERM"));

    await expect(answer).resolves.toEqual({ result: "failed", output: "kill EPERM" });
  });
});

describe("the working folder of the skill install", () => {
  /** A new folder in a folder with `mode`, as `/tmp` holds a folder of each account. */
  async function folderIn(mode: number): Promise<string> {
    const parent = await target();
    const folder = join(parent, "work");
    await mkdir(folder);
    await chmod(parent, mode);
    return folder;
  }

  it("is made in a new folder with mode 700 when the folder that holds it does not exist", async () => {
    const out = await target();
    const library = join(await target(), "Library");
    const workParent = join(library, "Caches");
    const { installer } = await installerRunning(`pwd > '${out}/cwd'\n${WRITES_SKILLS}`, { workParent });

    await expect(installer.install()).resolves.toEqual({ result: "installed" });

    expect(dirname((await readFile(join(out, "cwd"), "utf8")).trim())).toBe(await realpath(workParent));
    expect((await stat(library)).mode & 0o777).toBe(0o700);
    expect((await stat(workParent)).mode & 0o777).toBe(0o700);
  });

  it.each([
    ["is in a folder that every account can write to, as /tmp", () => folderIn(0o1777)],
    ["is in a folder that its group can write to", () => folderIn(0o770)],
    ["belongs to another account", async () => {
      const folder = await target();
      owning.foreign = await realpath(folder);
      onTestFinished(() => (owning.foreign = undefined));
      return folder;
    }],
    ["cannot be made", async () => {
      const file = join(await target(), "file");
      await writeFile(file, "");
      return join(file, "Caches");
    }],
    ["links to a folder in a folder that every account can write to", async () => {
      const link = join(await target(), "link");
      await symlink(await folderIn(0o1777), link);
      return link;
    }],
  ])("gives failed and starts no command when the folder that holds it %s", async (_name, folderOf: () => Promise<string>) => {
    const out = await target();
    const workParent = await folderOf();
    const { installer } = await installerRunning(`: > '${out}/started'`, { workParent });

    await expect(installer.install()).resolves.toEqual({
      result: "failed",
      output: `Tasma did not run the command, because ${workParent} is not a safe folder for it. `
        + "A folder is safe when it exists and no other account can write to it or to a folder above it.",
    });
    expect(existsSync(join(out, "started"))).toBe(false);
  });
});

describe("the limit of the skill install", () => {
  it("ends the command and the processes it started, also when it ignores SIGTERM, and gives failed with a line", async () => {
    const out = await target();
    // Long enough for npx to start its child, as the first run of a new executable is slow on macOS.
    const { installer } = await installerRunning(lingeringNpx(out, "echo 'Cloning' >&2"), { limitMs: 2000 });

    await expect(installer.install()).resolves.toEqual({
      result: "failed",
      output: "Cloning\nTasma stopped the command after 2 seconds.",
    });

    await untilGone(out, "npx", "inner");
  });
});

describe("the stop of the skill install", () => {
  it("ends the command and the processes it started, and gives failed to each request that waits", async () => {
    const out = await target();
    const { installer } = await installerRunning(lingeringNpx(out, "echo 'Cloning' >&2"));

    const first = installer.install();
    const second = installer.install();
    await untilPid(join(out, "inner"), "npx started its child");
    installer.stop();

    const ended = { result: "failed", output: `Cloning\n${STOPPED}` };
    await expect(first).resolves.toEqual(ended);
    await expect(second).resolves.toEqual(ended);
    await untilGone(out, "npx", "inner");
  });

  it("starts no command after a stop during the login-shell read", async () => {
    const out = await target();
    const dir = await npxRunning(`: > '${out}/started'`);
    const installer = installerWith(async (signal) => {
      await once(signal, "abort");
      return { env: { PATH: dir, HOME: dir } };
    });

    const answer = installer.install();
    installer.stop();

    await expect(answer).resolves.toEqual({ result: "failed", output: STOPPED });
    expect(existsSync(join(out, "started"))).toBe(false);
  });

  it("starts no command after a stop while it makes the working folder", async () => {
    const out = await target();
    const dir = await npxRunning(`: > '${out}/started'`);
    const installer = installerOver({ PATH: dir, HOME: dir });
    making.before = () => installer.stop();
    onTestFinished(() => (making.before = undefined));

    await expect(installer.install()).resolves.toEqual({ result: "failed", output: STOPPED });
    expect(existsSync(join(out, "started"))).toBe(false);
  });

  it("gives failed to a request after the stop, and starts no command", async () => {
    const out = await target();
    const { installer } = await installerRunning(`: > '${out}/started'`);
    installer.stop();

    await expect(installer.install()).resolves.toEqual({ result: "failed", output: STOPPED });
    expect(existsSync(join(out, "started"))).toBe(false);
  });
});

describe("the runs of the skill install", () => {
  /** An `npx` that counts its starts in `out/starts` and ends when `out/go` exists. */
  function waitingNpx(out: string): string {
    return [
      `echo start >> '${out}/starts'`,
      `while [ ! -e '${out}/go' ]; do /bin/sleep 0.05; done`,
      WRITES_SKILLS,
    ].join("\n");
  }

  async function startsOf(out: string): Promise<number> {
    return (await readFile(join(out, "starts"), "utf8")).split("\n").filter(Boolean).length;
  }

  it("answers running with the id of the run after the hold, and starts one command for two requests with no run", async () => {
    const out = await target();
    const { installer } = await installerRunning(waitingNpx(out), { holdMs: SHORT_HOLD_MS });

    const [first, second] = await Promise.all([installer.install(), installer.install()]);

    expect(first).toEqual({ result: "running", run: expect.stringMatching(RUN_ID) as string });
    expect(second).toEqual(first);
    await writeFile(join(out, "go"), "");
    await expect(settled(installer, runOf(first))).resolves.toEqual({ result: "installed" });
    expect(await startsOf(out)).toBe(1);
  });

  it("answers the end of the last run at once, and starts a new run with a new id for a request with no run", async () => {
    const out = await target();
    const { installer } = await installerRunning(waitingNpx(out), { holdMs: SHORT_HOLD_MS });
    const run = runOf(await installer.install());
    await writeFile(join(out, "go"), "");
    await settled(installer, run);

    await expect(installer.install(run)).resolves.toEqual({ result: "installed" });
    expect(await startsOf(out)).toBe(1);

    await rm(join(out, "go"));
    const next = runOf(await installer.install());
    expect(next).not.toBe(run);
    expect(await startsOf(out)).toBe(2);
    await writeFile(join(out, "go"), "");
    await expect(settled(installer, next)).resolves.toEqual({ result: "installed" });
  });

  it("joins the running install for a run that is not the running one, also the run before it", async () => {
    const out = await target();
    const { installer } = await installerRunning(waitingNpx(out), { holdMs: SHORT_HOLD_MS });
    const before = runOf(await installer.install());
    await writeFile(join(out, "go"), "");
    await settled(installer, before);
    await rm(join(out, "go"));
    const running = runOf(await installer.install());

    await expect(installer.install(before)).resolves.toEqual({ result: "running", run: running });
    await expect(installer.install("an unknown run")).resolves.toEqual({ result: "running", run: running });
    expect(await startsOf(out)).toBe(2);
    await writeFile(join(out, "go"), "");
    await settled(installer, running);
  });

  it("answers failed for a run that it does not know while no install runs, and starts no command", async () => {
    const out = await target();
    const { installer } = await installerRunning(`: > '${out}/started'`);

    await expect(installer.install("a run of a daemon before this one")).resolves.toEqual({ result: "failed", output: STOPPED });
    expect(existsSync(join(out, "started"))).toBe(false);
  });
});
