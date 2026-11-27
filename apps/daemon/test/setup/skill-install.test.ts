import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentSkillInstall, ChatAgent, SkillInstall, SkillInstallRequest } from "@tasma/protocol";
import type { AgentAdapter, AgentEnv } from "../../src/agents/adapter.js";
import type { ShellEnv } from "../../src/agents/shell-env.js";
import { createSkillInstaller } from "../../src/setup/skill-install.js";
import type { SkillInstaller } from "../../src/setup/skill-install.js";
import { SESSION_ENV, target, until, untilGone, untilPid } from "../helpers.js";

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

/** The `-a` name of each agent in the skills CLI. */
const SKILLS_AGENTS: Record<ChatAgent, string> = { claude: "claude-code", codex: "codex" };

const CLAUDE: SkillInstallRequest = { agents: ["claude"] };

const BOTH: SkillInstallRequest = { agents: ["claude", "codex"] };

const LONG_HOLD_MS = 10_000;

const SHORT_HOLD_MS = 200;

const STOPPED = "The daemon stopped.";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The skill file of a fake adapter in `home`. */
function skillFile(home: string, agent: ChatAgent): string {
  return join(home, `.${SKILLS_AGENTS[agent]}`, "skills", "tasma", "SKILL.md");
}

/** An adapter whose one skill file is in the `HOME` of the environment it gets. */
function fakeAdapter(agent: ChatAgent): AgentAdapter {
  return {
    agent,
    launch: () => ({ missing: "No agent binary" }),
    loggedIn: async () => true,
    skillFiles: (env) => [skillFile(env.HOME ?? "/nowhere", agent)],
    skillListed: async () => false,
    skillsAgent: SKILLS_AGENTS[agent],
    notLoggedIn: "Log in to the agent first",
    sessionGone: "The agent lost the chat",
    projectSessionGone: "The agent lost the project chat",
    filterUpdate: (update) => update,
  };
}

/** A shell line that sets `agent` to the last argument: the `-a` name of the command. */
const AGENT_ARG = "for agent; do :; done";

/** Shell lines that write the skill file of the agent that the command names, in `$HOME`. */
const WRITES_SKILL = `${AGENT_ARG}\n/bin/mkdir -p "$HOME/.$agent/skills/tasma" && : > "$HOME/.$agent/skills/tasma/SKILL.md"`;

function installed(agent: ChatAgent): AgentSkillInstall {
  return { agent, result: "installed" };
}

function agentFailed(agent: ChatAgent, output: string): AgentSkillInstall {
  return { agent, result: "failed", output };
}

function ended(...agents: AgentSkillInstall[]): SkillInstall {
  return { result: "ended", agents };
}

/** The output of the one entry of an install that ended. */
function entryOutput(answer: SkillInstall): string {
  const entry = answer.result === "ended" ? answer.agents[0] : undefined;
  if (entry?.result !== "failed") throw new Error(`the agent did not fail: ${JSON.stringify(answer)}`);
  return entry.output;
}

/** A directory that holds an executable `npx` that runs `script`. */
async function npxRunning(script: string): Promise<string> {
  const dir = await target();
  await writeFile(join(dir, "npx"), `#!/bin/sh\n${script}\n`);
  await chmod(join(dir, "npx"), 0o755);
  return dir;
}

type InstallerOptions = { workParent?: string; limitMs?: number; holdMs?: number; offered?: ChatAgent[] };

function installerWith(
  shellEnv: (signal: AbortSignal) => Promise<ShellEnv>,
  options: InstallerOptions = {},
): SkillInstaller {
  const installer = createSkillInstaller({
    adapters: (options.offered ?? ["claude", "codex"]).map(fakeAdapter),
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
    const answer = await installer.install({ run });
    if (answer.result !== "running") return answer;
  }
}

function runOf(answer: SkillInstall): string {
  if (answer.result !== "running") throw new Error(`the install ended: ${JSON.stringify(answer)}`);
  return answer.run;
}

describe("the skill install", () => {
  it.each<ChatAgent>(["claude", "codex"])("runs one command of the pinned skills CLI for %s alone, in a new empty folder in the Library/Caches of the daemon HOME that it removes, with stdin closed", async (agent) => {
    const out = await target();
    const { installer } = await installerRunning([
      // `read` gets the end of stdin at once only when stdin is closed.
      `if read -r line; then echo open >> '${out}/stdin'; else echo closed >> '${out}/stdin'; fi`,
      `printf '%s\\n' "$@" >> '${out}/args'`,
      `pwd > '${out}/cwd'`,
      `/bin/ls -A > '${out}/listing'`,
      WRITES_SKILL,
    ].join("\n"));

    await expect(installer.install({ agents: [agent] })).resolves.toEqual(ended(installed(agent)));

    expect((await readFile(join(out, "args"), "utf8")).split("\n")).toEqual([
      "--yes",
      "skills@1.7.6",
      "add",
      "https://github.com/mubinov/tasma-skill",
      "-g",
      "-y",
      "--json",
      "-a",
      SKILLS_AGENTS[agent],
      "",
    ]);
    expect(await readFile(join(out, "stdin"), "utf8")).toBe("closed\n");
    const cwd = (await readFile(join(out, "cwd"), "utf8")).trim();
    expect(dirname(cwd)).toBe(await realpath(join(homedir(), "Library", "Caches")));
    expect(await readFile(join(out, "listing"), "utf8")).toBe("");
    expect(existsSync(cwd)).toBe(false);
  });

  it("runs one command for each agent, in sequence, in the order of the request, each in its own working folder", async () => {
    const out = await target();
    const { installer } = await installerRunning([
      AGENT_ARG,
      `echo "start $agent" >> '${out}/log'`,
      `pwd >> '${out}/cwd'`,
      "/bin/sleep 0.2",
      WRITES_SKILL,
      `echo "end $agent" >> '${out}/log'`,
    ].join("\n"));

    await expect(installer.install({ agents: ["codex", "claude"] })).resolves.toEqual(ended(installed("codex"), installed("claude")));

    expect((await readFile(join(out, "log"), "utf8")).split("\n")).toEqual([
      "start codex",
      "end codex",
      "start claude-code",
      "end claude-code",
      "",
    ]);
    const folders = (await readFile(join(out, "cwd"), "utf8")).trim().split("\n");
    expect(new Set(folders).size).toBe(2);
  });

  it("keeps the entry of Claude when the command of Codex fails, and gives Codex its own entry", async () => {
    const { installer } = await installerRunning(
      `${AGENT_ARG}\nif [ "$agent" = codex ]; then echo 'Cloning failed' >&2; exit 1; fi\n${WRITES_SKILL}`,
    );

    await expect(installer.install(BOTH)).resolves.toEqual(ended(installed("claude"), agentFailed("codex", "Cloning failed\n")));
  });

  it("gives the environment of the login shell with no relative and no node_modules folder on PATH, no session variables, no telemetry or colour, and its working folder as TMPDIR", async () => {
    const out = await target();
    const home = await target();
    const packageBin = join(await target(), "node_modules", ".bin");
    await mkdir(packageBin, { recursive: true });
    await writeFile(join(packageBin, "npx"), `#!/bin/sh\n: > '${out}/wrong'\n`, { mode: 0o755 });
    const dir = await npxRunning(`/usr/bin/env > '${out}/env'\npwd > '${out}/cwd'\n${WRITES_SKILL}`);
    const installer = installerOver({
      ...SESSION_ENV,
      PATH: ["node_modules/.bin", packageBin, dir, "", "/usr/bin"].join(delimiter),
      HOME: home,
      CLAUDE_CONFIG_DIR: "/srv/agent",
      CODEX_HOME: "/srv/codex",
      ANTHROPIC_MODEL: "opus",
      TMPDIR: "/srv/shared-tmp",
    });

    await expect(installer.install(CLAUDE)).resolves.toEqual(ended(installed("claude")));

    const env = (await readFile(join(out, "env"), "utf8")).split("\n");
    expect(env).toContain(`PATH=${[dir, "/usr/bin"].join(delimiter)}`);
    expect(env).toContain(`HOME=${home}`);
    expect(env).toContain("CLAUDE_CONFIG_DIR=/srv/agent");
    expect(env).toContain("CODEX_HOME=/srv/codex");
    expect(env).toContain("ANTHROPIC_MODEL=opus");
    expect(env).toContain("DISABLE_TELEMETRY=1");
    expect(env).toContain("NO_COLOR=1");
    expect(env).toContain(`TMPDIR=${(await readFile(join(out, "cwd"), "utf8")).trim()}`);
    for (const name of Object.keys(SESSION_ENV)) expect(env.some((line) => line.startsWith(`${name}=`))).toBe(false);
    expect(existsSync(join(out, "wrong"))).toBe(false);
  });

  it("gives the agent failed with stderr, then stdout, for an exit code other than 0, also when the skill file exists", async () => {
    const { installer } = await installerRunning(`${WRITES_SKILL}\nprintf 'Cloning failed' >&2\necho '{"ok":false}'\nexit 1`);

    await expect(installer.install(CLAUDE)).resolves.toEqual(ended(agentFailed("claude", 'Cloning failed\n{"ok":false}\n')));
  });

  it("gives the agent failed with the output for a command that a signal ends", async () => {
    const { installer } = await installerRunning(`${WRITES_SKILL}\necho 'Cloning' >&2\nkill -9 $$`);

    await expect(installer.install(CLAUDE)).resolves.toEqual(ended(agentFailed("claude", "Cloning\n")));
  });

  it("checks only the skill file of the agent of each command, and gives a line that names the file the command did not write", async () => {
    const { installer, home } = await installerRunning([
      AGENT_ARG,
      'if [ "$agent" = claude-code ]; then /bin/mkdir -p "$HOME/.$agent/skills/tasma" && : > "$HOME/.$agent/skills/tasma/SKILL.md"; fi',
      "echo '{\"ok\":true}'",
    ].join("\n"));

    await expect(installer.install(BOTH)).resolves.toEqual(ended(
      installed("claude"),
      agentFailed("codex", `{"ok":true}\nThe command ended, but the skill is not in ${skillFile(home, "codex")}.`),
    ));
  });

  it("does not take a folder as the skill file", async () => {
    const { installer, home } = await installerRunning(`${WRITES_SKILL}\n/bin/rm "$HOME/.$agent/skills/tasma/SKILL.md"\n/bin/mkdir "$HOME/.$agent/skills/tasma/SKILL.md"`);

    await expect(installer.install(CLAUDE)).resolves.toEqual(ended(
      agentFailed("claude", `The command ended, but the skill is not in ${skillFile(home, "claude")}.`),
    ));
  });

  it("keeps the last 64 KiB of the output", async () => {
    const { installer } = await installerRunning(
      "/usr/bin/head -c 70000 /dev/zero | /usr/bin/tr '\\0' x >&2\n/usr/bin/head -c 70000 /dev/zero | /usr/bin/tr '\\0' y\necho END\nexit 1",
    );

    const output = entryOutput(await installer.install(CLAUDE));

    expect(Buffer.byteLength(output)).toBe(64 * 1024);
    expect(output).toMatch(/^y+END\n$/);
  });

  it("starts the last 64 KiB of the output at the first byte of a character", async () => {
    // The cut lands on the second byte of a character of 4 bytes.
    const { installer } = await installerRunning("/usr/bin/yes '😀' | /usr/bin/head -n 20000 | /usr/bin/tr -d '\\n' >&2\nprintf x >&2\nexit 1");

    expect(entryOutput(await installer.install(CLAUDE))).toBe(`${"😀".repeat(16_383)}x`);
  });

  it("keeps at most 64 KiB of an output that is not UTF-8", async () => {
    const { installer } = await installerRunning("/usr/bin/head -c 70000 /dev/zero | /usr/bin/tr '\\0' '\\377'\nexit 1");

    expect(entryOutput(await installer.install(CLAUDE))).toBe("\uFFFD".repeat(21_845));
  });

  it("gives the result of an install when its working folder cannot be removed", async () => {
    const out = await target();
    const { installer } = await installerRunning(`${WRITES_SKILL}\npwd > '${out}/cwd'\n/bin/mkdir locked && : > locked/file && /bin/chmod 500 locked`);
    onTestFinished(async () => {
      const cwd = (await readFile(join(out, "cwd"), "utf8")).trim();
      await chmod(join(cwd, "locked"), 0o700);
      await rm(cwd, { recursive: true, force: true });
    });

    await expect(installer.install(CLAUDE)).resolves.toEqual(ended(installed("claude")));
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

    await expect(installer.install(BOTH)).resolves.toEqual({ result: "npx-missing" });
  });

  it("gives failed with the message of a login-shell read that failed, and starts no command", async () => {
    const message = "Tasma could not read the environment of your login shell (/bin/zsh): it did not finish in 10 seconds";
    const installer = installerWith(async () => ({ failed: message }));

    await expect(installer.install(BOTH)).resolves.toEqual({ result: "failed", output: message });
  });

  it("gives failed with the cause of a login-shell read that throws", async () => {
    const installer = installerWith(() => Promise.reject(new Error("the read broke")));

    await expect(installer.install(BOTH)).resolves.toEqual({ result: "failed", output: "the read broke" });
  });

  it("gives the agent failed with the error of a command that the system cannot start", async () => {
    const dir = await target();
    // No `#!` line: the exec fails with ENOEXEC.
    await writeFile(join(dir, "npx"), "echo started\n", { mode: 0o755 });
    const installer = installerOver({ PATH: dir, HOME: dir });

    expect(entryOutput(await installer.install(CLAUDE))).toContain("ENOEXEC");
  });

  it("gives the agent failed with the error of a spawn that fails after the call", async () => {
    const dir = await npxRunning("exit 0");
    const failedSpawn = { pid: undefined, stdout: null, stderr: null };
    const child = Object.assign(new EventEmitter(), failedSpawn) as unknown as ChildProcess;
    spawning.next = child;
    const installer = installerOver({ PATH: dir, HOME: dir });

    const answer = installer.install(CLAUDE);
    await until(() => spawning.next === undefined, "the installer spawned the command");
    child.emit("error", new Error("spawn EAGAIN"));

    await expect(answer).resolves.toEqual(ended(agentFailed("claude", "spawn EAGAIN")));
  });

  it("gives the agent failed with the error that a started command emits", async () => {
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

    const answer = installer.install(CLAUDE);
    await until(() => spawning.next === undefined, "the installer spawned the command");
    child.emit("error", new Error("kill EPERM"));

    await expect(answer).resolves.toEqual(ended(agentFailed("claude", "kill EPERM")));
  });

  it.each([
    ["the first", 1, [agentFailed("claude", "EMFILE: too many open files"), installed("codex")]],
    ["the second", 2, [installed("claude"), agentFailed("codex", "EMFILE: too many open files")]],
  ])("gives failed with the cause to %s agent when its step throws, and keeps the entry of the other", async (_name, failing, entries) => {
    const { installer } = await installerRunning(WRITES_SKILL);
    let made = 0;
    making.before = () => {
      made += 1;
      if (made === failing) throw new Error("EMFILE: too many open files");
    };
    onTestFinished(() => (making.before = undefined));

    await expect(installer.install(BOTH)).resolves.toEqual(ended(...entries));
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
    const { installer } = await installerRunning(`pwd > '${out}/cwd'\n${WRITES_SKILL}`, { workParent });

    await expect(installer.install(CLAUDE)).resolves.toEqual(ended(installed("claude")));

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

    await expect(installer.install(BOTH)).resolves.toEqual({
      result: "failed",
      output: `Tasma did not run the command, because ${workParent} is not a safe folder for it. `
        + "A folder is safe when it exists and no other account can write to it or to a folder above it.",
    });
    expect(existsSync(join(out, "started"))).toBe(false);
  });
});

describe("the limit of the skill install", () => {
  it("ends the command and the processes it started, also when it ignores SIGTERM, and gives the agent failed with a line", async () => {
    const out = await target();
    // Long enough for npx to start its child, as the first run of a new executable is slow on macOS.
    const { installer } = await installerRunning(lingeringNpx(out, "echo 'Cloning' >&2"), { limitMs: 2000 });

    await expect(installer.install(CLAUDE)).resolves.toEqual(ended(
      agentFailed("claude", "Cloning\nTasma stopped the command after 2 seconds."),
    ));

    await untilGone(out, "npx", "inner");
  });
});

describe("the stop of the skill install", () => {
  it("ends the command and the processes it started, gives failed to its agent and to each agent after it, and to each request that waits", async () => {
    const out = await target();
    const { installer } = await installerRunning(
      `${AGENT_ARG}\nif [ "$agent" = codex ]; then : > '${out}/second'; fi\n${lingeringNpx(out, "echo 'Cloning' >&2")}`,
    );

    const first = installer.install(BOTH);
    const second = installer.install(BOTH);
    await untilPid(join(out, "inner"), "npx started its child");
    installer.stop();

    const stopped = ended(agentFailed("claude", `Cloning\n${STOPPED}`), agentFailed("codex", STOPPED));
    await expect(first).resolves.toEqual(stopped);
    await expect(second).resolves.toEqual(stopped);
    await untilGone(out, "npx", "inner");
    expect(existsSync(join(out, "second"))).toBe(false);
  });

  it("starts no command after a stop during the login-shell read", async () => {
    const out = await target();
    const dir = await npxRunning(`: > '${out}/started'`);
    const installer = installerWith(async (signal) => {
      await once(signal, "abort");
      return { env: { PATH: dir, HOME: dir } };
    });

    const answer = installer.install(BOTH);
    installer.stop();

    await expect(answer).resolves.toEqual({ result: "failed", output: STOPPED });
    expect(existsSync(join(out, "started"))).toBe(false);
  });

  it("starts no command after a stop while it makes the working folder, and gives failed to each agent", async () => {
    const out = await target();
    const dir = await npxRunning(`: > '${out}/started'`);
    const installer = installerOver({ PATH: dir, HOME: dir });
    making.before = () => installer.stop();
    onTestFinished(() => (making.before = undefined));

    await expect(installer.install(BOTH)).resolves.toEqual(ended(agentFailed("claude", STOPPED), agentFailed("codex", STOPPED)));
    expect(existsSync(join(out, "started"))).toBe(false);
  });

  it("gives failed to a request after the stop, and starts no command", async () => {
    const out = await target();
    const { installer } = await installerRunning(`: > '${out}/started'`);
    installer.stop();

    await expect(installer.install(BOTH)).resolves.toEqual({ result: "failed", output: STOPPED });
    expect(existsSync(join(out, "started"))).toBe(false);
  });
});

describe("the runs of the skill install", () => {
  /** An `npx` that counts its starts in `out/starts` and ends when `out/go` exists. */
  function waitingNpx(out: string): string {
    return [
      `echo start >> '${out}/starts'`,
      `while [ ! -e '${out}/go' ]; do /bin/sleep 0.05; done`,
      WRITES_SKILL,
    ].join("\n");
  }

  async function startsOf(out: string): Promise<number> {
    return (await readFile(join(out, "starts"), "utf8")).split("\n").filter(Boolean).length;
  }

  it("answers running with the id of the run after the hold, and starts one install for two requests for the same agents", async () => {
    const out = await target();
    const { installer } = await installerRunning(waitingNpx(out), { holdMs: SHORT_HOLD_MS });

    const [first, second] = await Promise.all([installer.install(CLAUDE), installer.install(CLAUDE)]);

    expect(first).toEqual({ result: "running", run: expect.stringMatching(RUN_ID) as string });
    expect(second).toEqual(first);
    await writeFile(join(out, "go"), "");
    await expect(settled(installer, runOf(first))).resolves.toEqual(ended(installed("claude")));
    expect(await startsOf(out)).toBe(1);
  });

  it("joins the install that runs for the same agents in another order, which keeps the order of the first request", async () => {
    const out = await target();
    const { installer } = await installerRunning(waitingNpx(out), { holdMs: SHORT_HOLD_MS });
    const run = runOf(await installer.install({ agents: ["codex", "claude"] }));

    await expect(installer.install(BOTH)).resolves.toEqual({ result: "running", run });
    await writeFile(join(out, "go"), "");
    await expect(settled(installer, run)).resolves.toEqual(ended(installed("codex"), installed("claude")));
    expect(await startsOf(out)).toBe(2);
  });

  it("refuses a request for other agents with skill-install-running while an install runs, and names its agents", async () => {
    const out = await target();
    const { installer } = await installerRunning(waitingNpx(out), { holdMs: SHORT_HOLD_MS });
    const run = runOf(await installer.install(BOTH));

    await expect(installer.install(CLAUDE)).rejects.toMatchObject({
      code: "skill-install-running",
      message: "an install of the skill for claude, codex runs now",
    });
    await expect(installer.install({ agents: ["codex"] })).rejects.toMatchObject({ code: "skill-install-running" });
    await writeFile(join(out, "go"), "");
    await expect(settled(installer, run)).resolves.toEqual(ended(installed("claude"), installed("codex")));
    expect(await startsOf(out)).toBe(2);
  });

  it("refuses an agent that it does not offer with agent-not-supported, before it looks at the install that runs", async () => {
    const out = await target();
    const { installer } = await installerRunning(waitingNpx(out), { holdMs: SHORT_HOLD_MS, offered: ["claude"] });

    await expect(installer.install(BOTH)).rejects.toMatchObject({ code: "agent-not-supported", message: "Tasma cannot run codex yet" });
    expect(existsSync(join(out, "starts"))).toBe(false);

    const run = runOf(await installer.install(CLAUDE));
    await expect(installer.install({ agents: ["codex"] })).rejects.toMatchObject({ code: "agent-not-supported" });
    await writeFile(join(out, "go"), "");
    await expect(settled(installer, run)).resolves.toEqual(ended(installed("claude")));
  });

  it("answers the end of the last run at once, and starts a new run with a new id for a request with agents", async () => {
    const out = await target();
    const { installer } = await installerRunning(waitingNpx(out), { holdMs: SHORT_HOLD_MS });
    const run = runOf(await installer.install(CLAUDE));
    await writeFile(join(out, "go"), "");
    await settled(installer, run);

    await expect(installer.install({ run })).resolves.toEqual(ended(installed("claude")));
    expect(await startsOf(out)).toBe(1);

    await rm(join(out, "go"));
    const next = runOf(await installer.install({ agents: ["codex"] }));
    expect(next).not.toBe(run);
    await writeFile(join(out, "go"), "");
    await expect(settled(installer, next)).resolves.toEqual(ended(installed("codex")));
    expect(await startsOf(out)).toBe(2);
  });

  it("joins the running install for a run that is not the running one, also the run before it", async () => {
    const out = await target();
    const { installer } = await installerRunning(waitingNpx(out), { holdMs: SHORT_HOLD_MS });
    const before = runOf(await installer.install(CLAUDE));
    await writeFile(join(out, "go"), "");
    await settled(installer, before);
    await rm(join(out, "go"));
    const running = runOf(await installer.install(CLAUDE));

    await expect(installer.install({ run: before })).resolves.toEqual({ result: "running", run: running });
    await expect(installer.install({ run: "an unknown run" })).resolves.toEqual({ result: "running", run: running });
    await writeFile(join(out, "go"), "");
    await settled(installer, running);
    expect(await startsOf(out)).toBe(2);
  });

  it("answers failed for a run that it does not know while no install runs, and starts no command", async () => {
    const out = await target();
    const { installer } = await installerRunning(`: > '${out}/started'`);

    await expect(installer.install({ run: "a run of a daemon before this one" })).resolves.toEqual({ result: "failed", output: STOPPED });
    expect(existsSync(join(out, "started"))).toBe(false);
  });
});
