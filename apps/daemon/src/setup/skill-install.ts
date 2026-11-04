// The install of the tasma skill into the skills folder of each agent, with
// the skills CLI that `npx` downloads. One install runs at a time, and a
// request waits for it at most for the hold of the daemon.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { SkillInstall } from "@tasma/protocol";
import type { AgentAdapter, AgentEnv } from "../agents/adapter.js";
import { childEnv, childPath, isExecutableFile, killGroup } from "../agents/process.js";
import { readShellEnv } from "../agents/shell-env.js";
import type { ShellEnv } from "../agents/shell-env.js";
import { HOLD_MS } from "../events/hold.js";
import { causeOf } from "../http/failure.js";
import { skillFileIn } from "./checks.js";

/**
 * A new pin needs a check of the code of that version: that `-a` with `-y`
 * installs only into the named agents, the install folder, and exit code 1 on
 * a failure with `--json`.
 */
const SKILLS_CLI = "skills@1.7.6";

/** The full URL, because `GH_HOST` changes the host of the `owner/repo` form. */
const SKILL_SOURCE = "https://github.com/mubinov/tasma-skill";

/** `-a` takes all the words after it, so the agents come last. */
const COMMAND = ["--yes", SKILLS_CLI, "add", SKILL_SOURCE, "-g", "-y", "--json", "-a"];

const LIMIT_MS = 2 * 60_000;

const STOPPED = "The daemon stopped.";

const OUTPUT_LIMIT = 64 * 1024;

/** A UTF-8 character has at most 3 bytes after its first byte. */
const MAX_CONTINUATION_BYTES = 3;

export type SkillInstaller = {
  /**
   * Starts an install, or joins the one that runs, and answers at its end or at
   * the end of the hold. Never rejects.
   */
  install(run?: string): Promise<SkillInstall>;
  /** Ends the install that runs, so a request does not hold the daemon stop. */
  stop(): void;
};

type InstallRun = { id: string; ended: Promise<SkillInstall> };

type CommandEnd = {
  /** The command exited with code 0. */
  ok: boolean;
  output: string;
};

/** The last 64 KiB, from the first byte of a UTF-8 character. */
function lastBytes(bytes: Buffer): Buffer {
  if (bytes.length <= OUTPUT_LIMIT) return bytes;
  let start = bytes.length - OUTPUT_LIMIT;
  const end = start + MAX_CONTINUATION_BYTES;
  while (start < end && (bytes.readUInt8(start) & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start);
}

/** The cut comes after the decode, which gives U+FFFD (3 bytes) for each byte that is not UTF-8. */
function failed(output: string): SkillInstall {
  return { result: "failed", output: lastBytes(Buffer.from(output)).toString("utf8") };
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
  agents: string[],
  options: { cwd: string; env: AgentEnv; limitMs: number; signal: AbortSignal },
): Promise<CommandEnd> {
  const { cwd, env, limitMs, signal } = options;
  if (signal.aborted) return Promise.resolve({ ok: false, output: STOPPED });
  let child: ChildProcess;
  try {
    child = spawn(npx, [...COMMAND, ...agents], {
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

/** The skill paths of the first adapter that has a file in none of them. */
async function missingSkill(adapters: readonly AgentAdapter[], env: AgentEnv): Promise<string[] | undefined> {
  for (const adapter of adapters) {
    const paths = adapter.skillFiles(env);
    if ((await skillFileIn(paths)) !== "found") return paths;
  }
  return undefined;
}

/**
 * The real path of the folder, when this user or root owns it and each folder
 * above it, and no other account can write to them. `npm` reads the `.npmrc`
 * and the `node_modules` of each folder above its working folder, and puts each
 * `node_modules/.bin` on the `PATH` of the CLI.
 */
async function safeFolder(folder: string): Promise<string | undefined> {
  const path = await realpath(folder).catch(() => undefined);
  if (path === undefined) return undefined;
  const uid = process.getuid?.();
  for (let dir = path; ; dir = dirname(dir)) {
    const info = await stat(dir);
    if ((info.uid !== uid && info.uid !== 0) || (info.mode & 0o022) !== 0) return undefined;
    if (dirname(dir) === dir) return path;
  }
}

export function createSkillInstaller(options: {
  adapters: readonly AgentAdapter[];
  /** The environment of the daemon, which the login shell starts from. */
  env: AgentEnv;
  shellEnv?: (signal: AbortSignal) => Promise<ShellEnv>;
  /**
   * The folder that holds the working folder of the command, made when it does
   * not exist. Not the temporary folder: an agent sandbox of this user can
   * usually write to it.
   */
  workParent?: string;
  limitMs?: number;
  holdMs?: number;
}): SkillInstaller {
  const {
    adapters,
    env,
    workParent = join(env.HOME ?? homedir(), "Library", "Caches"),
    limitMs = LIMIT_MS,
    holdMs = HOLD_MS,
  } = options;
  const shellEnv = options.shellEnv ?? ((signal) => readShellEnv(env, { signal }));
  const stopping = new AbortController();
  const { signal } = stopping;
  let running: InstallRun | undefined;
  /** The end of the last run, kept until the next run starts. */
  let last: { id: string; result: SkillInstall } | undefined;

  async function runInstall(): Promise<SkillInstall> {
    const shell = await shellEnv(signal);
    if (signal.aborted) return failed(STOPPED);
    if ("failed" in shell) return failed(shell.failed);
    const path = childPath(shell.env.PATH);
    const npx = path.map((dir) => join(dir, "npx")).find(isExecutableFile);
    if (npx === undefined) return { result: "npx-missing" };
    // Under a umask of 002, the default mode gives the group write access, which the check refuses.
    await mkdir(workParent, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const parent = await safeFolder(workParent);
    if (parent === undefined) {
      return failed(
        `Tasma did not run the command, because ${workParent} is not a safe folder for it. `
        + "A folder is safe when it exists and no other account can write to it or to a folder above it.",
      );
    }

    // An empty folder has no `node_modules/.bin/skills` and no `.npmrc` that `npx` would prefer to the pin.
    const cwd = await mkdtemp(join(parent, "tasma-skill-"));
    try {
      const agents = adapters.map((adapter) => adapter.skillsAgent);
      const commandEnv = {
        ...childEnv(shell.env, path),
        DISABLE_TELEMETRY: "1",
        // It also wins over `FORCE_COLOR` and `CI` in the colour library of the CLI.
        NO_COLOR: "1",
        // The CLI clones the skill into `TMPDIR`, and an agent sandbox can usually write to the one of the login shell.
        TMPDIR: cwd,
      };
      const end = await runCommand(npx, agents, { cwd, env: commandEnv, limitMs, signal });
      if (!end.ok) return failed(end.output);
      // The CLI can exit with code 0 after an install that failed.
      const missing = await missingSkill(adapters, shell.env);
      if (missing === undefined) return { result: "installed" };
      return failed(linesOf([end.output, `The command ended, but the skill is not in ${missing.join(" or ")}.`]));
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  function start(): InstallRun {
    const id = randomUUID();
    last = undefined;
    const ended = runInstall()
      .catch((error: unknown) => failed(causeOf(error)))
      .then((result) => {
        running = undefined;
        last = { id, result };
        return result;
      });
    return { id, ended };
  }

  function answerWithin(install: InstallRun): Promise<SkillInstall> {
    let timer: NodeJS.Timeout | undefined;
    const held = new Promise<SkillInstall>((resolve) => {
      timer = setTimeout(() => resolve({ result: "running", run: install.id }), holdMs);
    });
    return Promise.race([install.ended, held]).finally(() => clearTimeout(timer));
  }

  return {
    install(run) {
      if (running !== undefined) return answerWithin(running);
      if (run === undefined) {
        running = start();
        return answerWithin(running);
      }
      // A run of a daemon before this one, or a run that ended before the last one started.
      return Promise.resolve(last?.id === run ? last.result : failed(STOPPED));
    },

    stop() {
      stopping.abort();
    },
  };
}
