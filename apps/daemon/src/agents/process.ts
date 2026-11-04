// The `PATH` and the environment of a process that the daemon starts for the
// user, the check of an executable, and the kill and the end of a process group.

import type { ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentEnv } from "./adapter.js";

/**
 * The variables a running Claude Code session (the CLI or the IDE extension)
 * sets for its children. The daemon often inherits them, because the first
 * `tasma` call that starts it often comes from an agent inside Claude Code.
 */
export const CLAUDE_SESSION_VARIABLES = [
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

/** `env` with `path` as its `PATH` and with no variable of a Claude Code session. */
export function childEnv(env: AgentEnv, path: string[]): AgentEnv {
  const kept: AgentEnv = { ...env, PATH: path.join(delimiter) };
  for (const name of CLAUDE_SESSION_VARIABLES) delete kept[name];
  return kept;
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
