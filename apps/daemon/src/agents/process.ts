// The checks and the kill that the agent launch and the shell read share.

import type { ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";

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
