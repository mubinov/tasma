// The install of the tasma skill into the skills folder of each agent of a
// request, with the skills CLI that `npx` downloads: one command for each
// agent. One install runs at a time, and a request waits for it at most for
// the hold of the daemon.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { AgentSkillInstall, ChatAgent, SkillInstall, SkillInstallRequest } from "@tasma/protocol";
import type { AgentAdapter, AgentEnv } from "../agents/adapter.js";
import { cachesFolder, childEnv, childPath, isExecutableFile, killGroup, safeWorkParent } from "../agents/process.js";
import { readShellEnv } from "../agents/shell-env.js";
import type { ShellEnv } from "../agents/shell-env.js";
import { HOLD_MS } from "../events/hold.js";
import { causeOf, DaemonError } from "../http/failure.js";
import { skillFileIn } from "./checks.js";

/**
 * A new pin needs a check of the code of that version: that one agent with
 * `-a` and `-y` installs a copy into the folder of that agent only, and that
 * the CLI exits with code 1 when an install fails with `--json`.
 */
const SKILLS_CLI = "skills@1.7.6";

/** The full URL, because `GH_HOST` changes the host of the `owner/repo` form. */
const SKILL_SOURCE = "https://github.com/mubinov/tasma-skill";

/** `-a` takes all the words after it, so the agent comes last. */
const COMMAND = ["--yes", SKILLS_CLI, "add", SKILL_SOURCE, "-g", "-y", "--json", "-a"];

const LIMIT_MS = 2 * 60_000;

const STOPPED = "The daemon stopped.";

const OUTPUT_LIMIT = 64 * 1024;

/** A UTF-8 character has at most 3 bytes after its first byte. */
const MAX_CONTINUATION_BYTES = 3;

export type SkillInstaller = {
  /**
   * Starts an install, or joins the one that runs, and answers at its end or at
   * the end of the hold. Rejects only with a `DaemonError`: `agent-not-supported`
   * for an agent with no adapter, and `skill-install-running` while an install
   * for other agents runs.
   */
  install(request: SkillInstallRequest): Promise<SkillInstall>;
  /** Ends the install that runs, so a request does not hold the daemon stop. */
  stop(): void;
};

type InstallRun = { id: string; agents: ChatAgent[]; ended: Promise<SkillInstall> };

type CommandEnd = {
  /** The command exited with code 0. */
  ok: boolean;
  output: string;
};

/** What the commands of all the agents of one install share. */
type CommandBase = { npx: string; parent: string; loginEnv: AgentEnv; commandEnv: AgentEnv };

/** The last 64 KiB, from the first byte of a UTF-8 character. */
function lastBytes(bytes: Buffer): Buffer {
  if (bytes.length <= OUTPUT_LIMIT) return bytes;
  let start = bytes.length - OUTPUT_LIMIT;
  const end = start + MAX_CONTINUATION_BYTES;
  while (start < end && (bytes.readUInt8(start) & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start);
}

/** The cut comes after the decode, which gives U+FFFD (3 bytes) for each byte that is not UTF-8. */
function lastOutput(output: string): string {
  return lastBytes(Buffer.from(output)).toString("utf8");
}

function failed(output: string): SkillInstall {
  return { result: "failed", output: lastOutput(output) };
}

function agentFailed(agent: ChatAgent, output: string): AgentSkillInstall {
  return { agent, result: "failed", output: lastOutput(output) };
}

/** Both lists have no duplicate. */
function sameAgents(running: readonly ChatAgent[], asked: readonly ChatAgent[]): boolean {
  return running.length === asked.length && asked.every((agent) => running.includes(agent));
}

/** The parts, each on a line of its own. */
function linesOf(parts: string[]): string {
  let text = "";
  for (const part of parts) {
    if (part === "") continue;
    if (text !== "" && !text.endsWith("\n")) text += "\n";
    text += part;
  }
  return text;
}

/** Keeps the last 64 KiB that the stream gives. */
function tailOf(stream: Readable): () => string {
  let kept: Buffer = Buffer.alloc(0);
  stream.on("data", (chunk: Buffer) => {
    kept = lastBytes(Buffer.concat([kept, chunk]));
  });
  return () => kept.toString("utf8");
}

function runCommand(
  npx: string,
  skillsAgent: string,
  options: { cwd: string; env: AgentEnv; limitMs: number; signal: AbortSignal },
): Promise<CommandEnd> {
  const { cwd, env, limitMs, signal } = options;
  if (signal.aborted) return Promise.resolve({ ok: false, output: STOPPED });
  let child: ChildProcess;
  try {
    child = spawn(npx, [...COMMAND, skillsAgent], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // A group of its own, so that the kill also ends the `node` and `git` processes under `npx`.
      detached: true,
    });
  } catch (error) {
    // Node throws most errors of the system call, for example ENOEXEC.
    return Promise.resolve({ ok: false, output: causeOf(error) });
  }

  const { pid, stdout, stderr } = child;
  // The spawn failed, and `error` comes next. At EMFILE and ENFILE, there is no stdout either.
  if (pid === undefined || stdout === null || stderr === null) {
    return new Promise((resolve) => child.once("error", (error) => resolve({ ok: false, output: error.message })));
  }

  return new Promise((resolve) => {
    const stderrTail = tailOf(stderr);
    const stdoutTail = tailOf(stdout);
    const outputWith = (line = ""): string => linesOf([stderrTail(), stdoutTail(), line]);
    const finish = (end: CommandEnd): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onStop);
      resolve(end);
    };
    // No SIGTERM first: the CLI can ignore the first SIGTERM while its spinner runs.
    const kill = (line: string): void => {
      killGroup(child, pid);
      stdout.destroy();
      stderr.destroy();
      finish({ ok: false, output: outputWith(line) });
    };
    const onStop = (): void => kill(STOPPED);
    const timer = setTimeout(() => kill(`Tasma stopped the command after ${limitMs / 1000} seconds.`), limitMs);
    signal.addEventListener("abort", onStop, { once: true });

    // A kill that fails emits `error`.
    child.on("error", (error) => finish({ ok: false, output: error.message }));
    child.on("close", (code) => finish({ ok: code === 0, output: outputWith() }));
  });
}

export function createSkillInstaller(options: {
  adapters: readonly AgentAdapter[];
  /** The environment of the daemon, which the login shell starts from. */
  env: AgentEnv;
  shellEnv?: (signal: AbortSignal) => Promise<ShellEnv>;
  /** The folder that holds the working folder of each command, made when it does not exist. */
  workParent?: string;
  limitMs?: number;
  holdMs?: number;
}): SkillInstaller {
  const {
    adapters,
    env,
    workParent = cachesFolder(env),
    limitMs = LIMIT_MS,
    holdMs = HOLD_MS,
  } = options;
  const shellEnv = options.shellEnv ?? ((signal) => readShellEnv(env, { signal }));
  const stopping = new AbortController();
  const { signal } = stopping;
  let running: InstallRun | undefined;
  /** The end of the last run, kept until the next run starts. */
  let last: { id: string; result: SkillInstall } | undefined;

  function adapterOf(agent: ChatAgent): AgentAdapter {
    const adapter = adapters.find((entry) => entry.agent === agent);
    if (adapter === undefined) throw new DaemonError("agent-not-supported", `Tasma cannot run ${agent} yet`);
    return adapter;
  }

  /** A fault gives this agent `failed`, and does not stop the agents after it. */
  async function installFor(adapter: AgentAdapter, base: CommandBase): Promise<AgentSkillInstall> {
    const { agent } = adapter;
    if (signal.aborted) return agentFailed(agent, STOPPED);
    try {
      // An empty folder has no `node_modules/.bin/skills` and no `.npmrc` that `npx` would prefer to the pin.
      const cwd = await mkdtemp(join(base.parent, "tasma-skill-"));
      try {
        // The CLI clones the skill into `TMPDIR`, and an agent sandbox can usually write to the one of the login shell.
        const end = await runCommand(base.npx, adapter.skillsAgent, {
          cwd,
          env: { ...base.commandEnv, TMPDIR: cwd },
          limitMs,
          signal,
        });
        if (!end.ok) return agentFailed(agent, end.output);
        // The CLI can exit with code 0 after an install that failed.
        const paths = adapter.skillFiles(base.loginEnv);
        if ((await skillFileIn(paths)) === "found") return { agent, result: "installed" };
        return agentFailed(agent, linesOf([end.output, `The command ended, but the skill is not in ${paths.join(" or ")}.`]));
      } finally {
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (error) {
      return agentFailed(agent, causeOf(error));
    }
  }

  async function runInstall(chosen: readonly AgentAdapter[]): Promise<SkillInstall> {
    const shell = await shellEnv(signal);
    if (signal.aborted) return failed(STOPPED);
    if ("failed" in shell) return failed(shell.failed);
    const path = childPath(shell.env.PATH);
    const npx = path.map((dir) => join(dir, "npx")).find(isExecutableFile);
    if (npx === undefined) return { result: "npx-missing" };
    const parent = await safeWorkParent(workParent);
    if (parent === undefined) {
      return failed(
        `Tasma did not run the command, because ${workParent} is not a safe folder for it. `
        + "A folder is safe when it exists and no other account can write to it or to a folder above it.",
      );
    }

    const base: CommandBase = {
      npx,
      parent,
      loginEnv: shell.env,
      commandEnv: {
        ...childEnv(shell.env, path),
        DISABLE_TELEMETRY: "1",
        // It also wins over `FORCE_COLOR` and `CI` in the colour library of the CLI.
        NO_COLOR: "1",
      },
    };
    const agents: AgentSkillInstall[] = [];
    // In sequence: each command writes the same lock file of the CLI.
    for (const adapter of chosen) agents.push(await installFor(adapter, base));
    return { result: "ended", agents };
  }

  function start(chosen: readonly AgentAdapter[]): InstallRun {
    const id = randomUUID();
    last = undefined;
    const ended = runInstall(chosen)
      .catch((error: unknown) => failed(causeOf(error)))
      .then((result) => {
        running = undefined;
        last = { id, result };
        return result;
      });
    return { id, agents: chosen.map((adapter) => adapter.agent), ended };
  }

  function answerWithin(install: InstallRun): Promise<SkillInstall> {
    let timer: NodeJS.Timeout | undefined;
    const held = new Promise<SkillInstall>((resolve) => {
      timer = setTimeout(() => resolve({ result: "running", run: install.id }), holdMs);
    });
    return Promise.race([install.ended, held]).finally(() => clearTimeout(timer));
  }

  return {
    async install(request) {
      if ("agents" in request) {
        const chosen = request.agents.map(adapterOf);
        running ??= start(chosen);
        if (!sameAgents(running.agents, request.agents)) {
          throw new DaemonError("skill-install-running", `an install of the skill for ${running.agents.join(", ")} runs now`);
        }
        return answerWithin(running);
      }
      if (running !== undefined) return answerWithin(running);
      // A run of a daemon before this one, or a run that ended before the last one started.
      return last?.id === request.run ? last.result : failed(STOPPED);
    },

    stop() {
      stopping.abort();
    },
  };
}
