// The checks and the kill that the agent launch and the shell read share, and
// the end of the process group of an agent.

import type { ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/** How long the group of an agent has to end by itself, from the close of its stdin or its exit. */
const GROUP_GRACE_MS = 3000;

const GROUP_POLL_MS = 100;

/** How long the end waits for the group after the kill, so a process that `SIGKILL` cannot end does not hold it. */
const KILLED_WAIT_MS = 500;

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
