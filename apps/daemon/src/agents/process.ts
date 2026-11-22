// The `PATH` and the environment of a process that the daemon starts for the
// user, the lookup of an agent binary, the launch of an ACP adapter, a short
// command of an agent and its output, the check of a working folder, and the
// kill and the end of a process group.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ChatAgent } from "@tasma/protocol";
import { causeOf } from "../http/failure.js";
import { AGENT_MODE } from "./adapter.js";
import type { AgentEnv, LaunchResult } from "./adapter.js";

/**
 * The variables a running Claude Code session (the CLI or the IDE extension)
 * sets for its children. The daemon often inherits them, because the first
 * `tasma` call that starts it often comes from an agent inside Claude Code.
 */
const CLAUDE_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_CODE_ENABLE_TASKS",
  "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
  "CLAUDE_CODE_EMIT_STARTUP_TIMING",
  "MCP_CONNECTION_NONBLOCKING",
] as const;

/**
 * The variables that Codex sets for the commands it runs, and that its npm
 * launcher sets. A nested `codex` with `CODEX_SANDBOX` builds direct HTTP
 * clients, and one with `CODEX_MANAGED_BY_*` gives wrong update hints.
 */
const CODEX_SESSION_VARIABLES = [
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_TOOL_CALL_ID",
  "CODEX_VERSION",
  "CODEX_PERMISSION_PROFILE",
  "CODEX_CI",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_MANAGED_BY_BUN",
  "CODEX_MANAGED_BY_PNPM",
  "CODEX_MANAGED_PACKAGE_ROOT",
] as const;

/**
 * The options of `claude-agent-acp`. An ACP client sets them for the adapter,
 * and the commands of its agent inherit them.
 */
const CLAUDE_ACP_OPTIONS = ["CLAUDE_AGENT_LOGS", "CLAUDE_AGENT_ACP_EXPERIMENTAL_V2"] as const;

/** Each variable that `childEnv` removes. */
export const REMOVED_VARIABLES: readonly string[] = [
  ...CLAUDE_SESSION_VARIABLES,
  ...CODEX_SESSION_VARIABLES,
  ...CLAUDE_ACP_OPTIONS,
];

/** `compiled` is a binary that `bun build --compile` made, which holds the adapters in its own file system. */
export type AgentHost = { runtime: "node" | "bun" | "compiled"; resolve(specifier: string): string };

function runtimeOf(): AgentHost["runtime"] {
  // A compiled binary has argv ["bun", "/$bunfs/root/<name>", ...].
  if (process.argv[1]?.includes("$bunfs")) return "compiled";
  return process.versions.bun === undefined ? "node" : "bun";
}

export function thisHost(): AgentHost {
  return { runtime: runtimeOf(), resolve: (specifier) => import.meta.resolve(specifier) };
}

export const COMMAND_TIMEOUT_MS = 5000;

/** The id of the plugin that holds the tasma skill, in the plugin list of an agent. */
export const SKILL_PLUGIN = "tasma@tasma";

const COMMAND_OUTPUT_LIMIT = 64 * 1024;

/** How long the group of an agent has to end by itself, from the close of its stdin or its exit. */
const GROUP_GRACE_MS = 3000;

const GROUP_POLL_MS = 100;

/** How long the end waits for the group after the kill, so a process that `SIGKILL` cannot end does not hold it. */
const KILLED_WAIT_MS = 500;

/**
 * The absolute `PATH` directories outside `node_modules`. A relative directory
 * resolves in the working folder of the process. A directory inside
 * `node_modules` holds the bins of one repository: a package script puts them
 * first on `PATH`, and the daemon it starts keeps that `PATH`.
 */
export function childPath(path: string | undefined): string[] {
  return (path ?? "").split(delimiter).filter((dir) => isAbsolute(dir) && !dir.split(sep).includes("node_modules"));
}

/** `env` with `path` as its `PATH` and with no variable of an agent session or of the Claude adapter. */
export function childEnv(env: AgentEnv, path: string[]): AgentEnv {
  const kept = Object.entries(env).filter(([name]) => !REMOVED_VARIABLES.includes(name));
  return { ...Object.fromEntries(kept), PATH: path.join(delimiter) };
}

export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first `<dir>/<name>` that this user can run, as found: a link is not
 * resolved, so a self-update of the agent reaches the next chat.
 */
export function findBinary(dirs: string[], name: string): string | undefined {
  return dirs.map((dir) => join(dir, name)).find(isExecutableFile);
}

export function adapterLaunch(host: AgentHost, agent: ChatAgent, entry: string, env: AgentEnv): LaunchResult {
  // `process.execPath` is the compiled daemon itself.
  if (host.runtime === "compiled") return { command: process.execPath, args: [AGENT_MODE, agent], env };
  let path: string;
  try {
    path = fileURLToPath(host.resolve(entry));
  } catch (error) {
    return { failed: `The agent could not start: ${causeOf(error)}` };
  }
  // bun reads `bunfig.toml` and `.env` of its working directory, which is the folder of the chat.
  const flags = host.runtime === "bun" ? ["--no-env-file", "--config=/dev/null"] : [];
  return { command: process.execPath, args: [...flags, path], env };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function jsonOf(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/**
 * The exit code and the stdout of a short command of an agent, or `undefined`
 * when no answer can come from it.
 */
export function commandOutput(
  binary: string,
  args: string[],
  env: AgentEnv,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ code: number; stdout: string } | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  let child: ChildProcess;
  try {
    child = spawn(binary, args, {
      cwd: env.HOME ?? homedir(),
      env,
      stdio: ["ignore", "pipe", "ignore"],
      // A group of its own, so that the kill also ends the processes that the command starts.
      detached: true,
    });
  } catch {
    // Node throws most errors of the system call, for example ENOEXEC.
    return Promise.resolve(undefined);
  }

  const { pid, stdout } = child;
  // The spawn failed, and `error` comes next. At EMFILE and ENFILE, there is no stdout either.
  if (pid === undefined || stdout === null) return new Promise((resolve) => child.once("error", () => resolve(undefined)));

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (output: { code: number; stdout: string } | undefined): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve(output);
    };
    const stop = (): void => {
      killGroup(child, pid);
      stdout.destroy();
      finish(undefined);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });

    stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > COMMAND_OUTPUT_LIMIT) stop();
      else chunks.push(chunk);
    });
    // A kill that fails emits `error`.
    child.on("error", () => finish(undefined));
    child.on("close", (code) => finish(code === null ? undefined : { code, stdout: Buffer.concat(chunks).toString("utf8") }));
  });
}

/**
 * The folder that holds the working folder of a command that the daemon runs
 * for the user. Not the temporary folder: an agent sandbox of this user can
 * usually write to it.
 */
export function cachesFolder(env: AgentEnv): string {
  return join(env.HOME ?? homedir(), "Library", "Caches");
}

/**
 * Makes the folder when it does not exist. Gives its real path when this user
 * or root owns it and each folder above it, and no other account can write to
 * them. A tool can read files of each folder above its working folder: `npm`
 * reads `.npmrc` and `node_modules`, Claude Code reads `CLAUDE.md`.
 */
export async function safeWorkParent(folder: string): Promise<string | undefined> {
  // Under a umask of 002, the default mode gives the group write access, which the check refuses.
  await mkdir(folder, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const path = await realpath(folder).catch(() => undefined);
  if (path === undefined) return undefined;
  const uid = process.getuid?.();
  for (let dir = path; ; dir = dirname(dir)) {
    const info = await stat(dir);
    if ((info.uid !== uid && info.uid !== 0) || (info.mode & 0o022) !== 0) return undefined;
    if (dirname(dir) === dir) return path;
  }
}

/** Kills the process and the processes it started that stay in its group. */
export function killGroup(child: ChildProcess, pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Unlike `child.kill`, `process.kill` throws, for example when the group has no live process left.
    child.kill("SIGKILL");
  }
}

function groupLives(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM: a member lives that this user cannot signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitWhile(holds: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (holds()) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    await sleep(Math.min(GROUP_POLL_MS, left));
  }
}

/**
 * Waits until `child` and every process of its group have ended, and kills the
 * group when the grace time ends. A `claude` that gets `SIGKILL` cannot stop
 * the commands it runs in groups of their own, so the kill comes last.
 */
export async function endGroup(child: ChildProcess, pid: number): Promise<void> {
  const lives = () => (child.exitCode === null && child.signalCode === null) || groupLives(pid);
  await waitWhile(lives, GROUP_GRACE_MS);
  if (!lives()) return;
  killGroup(child, pid);
  await waitWhile(lives, KILLED_WAIT_MS);
}
