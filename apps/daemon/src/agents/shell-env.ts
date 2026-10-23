// The environment of the user's login shell. A daemon that the app starts from
// Finder or the Dock has the `PATH` of launchd, where no agent binary is.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";
import { causeOf } from "../http/failure.js";
import type { AgentEnv } from "./adapter.js";
import { isExecutableFile, killGroup } from "./process.js";

const TIMEOUT_MS = 10_000;

const OUTPUT_LIMIT = 4 * 1024 * 1024;

const STOPPING = "the daemon is stopping";

/**
 * Set for the shell alone. The first lets an init file skip slow parts; the
 * others stop oh-my-zsh from asking about an update and from starting tmux.
 */
const PROBE: Readonly<Record<string, string>> = {
  TASMA_RESOLVING_ENVIRONMENT: "1",
  DISABLE_AUTO_UPDATE: "true",
  ZSH_TMUX_AUTOSTART: "false",
  ZSH_TMUX_AUTOSTARTED: "true",
};

/** Variables of the shell process, not of the user. */
const SHELL_OWN = ["SHLVL", "PWD", "OLDPWD", "_"];

/** The flags before the script, by the base name of the shell. */
const FLAGS = new Map([
  ["fish", ["-l", "-c"]],
  ["csh", ["-i", "-c"]],
  ["tcsh", ["-i", "-c"]],
  ["pwsh", ["-Login", "-Command"]],
]);

const DEFAULT_FLAGS = ["-l", "-i", "-c"];

export type ShellEnv = { env: AgentEnv } | { failed: string };

type UserShell = () => string | null | undefined;

function isShell(path: string | null | undefined): path is string {
  return typeof path === "string" && isAbsolute(path) && isExecutableFile(path);
}

function shellOf(base: AgentEnv, userShell: UserShell): string {
  if (isShell(base.SHELL)) return base.SHELL;
  let user: string | null | undefined;
  try {
    user = userShell();
  } catch {
    // `os.userInfo()` throws when the user id has no entry in the user database, for example in a container.
    user = undefined;
  }
  return isShell(user) ? user : "/bin/zsh";
}

function envOf(base: AgentEnv, entries: string): AgentEnv {
  const env = { ...base };
  for (const entry of entries.split("\0")) {
    const at = entry.indexOf("=");
    if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  for (const name of SHELL_OWN) delete env[name];
  for (const name of Object.keys(PROBE)) {
    const value = base[name];
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/**
 * Runs the login shell of the user in `HOME` and gives its environment over
 * `base`. Never rejects. `base` is the environment of the daemon.
 */
export function readShellEnv(
  base: AgentEnv,
  options: { timeoutMs?: number; userShell?: UserShell; signal?: AbortSignal } = {},
): Promise<ShellEnv> {
  const { timeoutMs = TIMEOUT_MS, userShell = () => userInfo().shell, signal } = options;
  const shell = shellOf(base, userShell);
  const failed = (cause: string): ShellEnv => ({
    failed: `Tasma could not read the environment of your login shell (${shell}): ${cause}`,
  });
  if (signal?.aborted) return Promise.resolve(failed(STOPPING));

  const marker = `TASMA_ENV_${randomBytes(8).toString("hex")}`;
  // Absolute paths and `;` alone, so that the script is valid in every shell, fish and pwsh included.
  const script = `/bin/echo ${marker}; /usr/bin/env -0; /bin/echo ${marker}`;
  let child: ChildProcess;
  try {
    child = spawn(shell, [...FLAGS.get(basename(shell)) ?? DEFAULT_FLAGS, script], {
      cwd: base.HOME ?? homedir(),
      env: { ...base, ...PROBE },
      stdio: ["ignore", "pipe", "ignore"],
      // A session of its own, so that an interactive shell cannot take a terminal.
      detached: true,
    });
  } catch (error) {
    // Node throws most errors of the system call, for example E2BIG.
    return Promise.resolve(failed(causeOf(error)));
  }

  const { pid, stdout } = child;
  // The spawn failed, and `error` comes next. At EMFILE and ENFILE, there is no stdout either.
  if (pid === undefined || stdout === null) {
    return new Promise((resolve) => child.once("error", (error) => resolve(failed(error.message))));
  }

  return new Promise((resolve) => {
    const opening = Buffer.from(`${marker}\n`);
    const closing = Buffer.from(`\0${marker}\n`);
    let output = Buffer.alloc(0);

    /**
     * Does not kill the shell: a program that an init file starts in the
     * background, or a slow exit of the shell, then holds neither the read nor
     * the daemon.
     */
    const finish = (result: ShellEnv): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      stdout.destroy();
      child.unref();
      resolve(result);
    };
    const stop = (cause: string): void => {
      killGroup(child, pid);
      finish(failed(cause));
    };
    const onAbort = (): void => stop(STOPPING);
    const timer = setTimeout(() => stop(`it did not finish in ${timeoutMs / 1000} seconds`), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    stdout.on("data", (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      const start = output.indexOf(opening);
      const end = start === -1 ? -1 : output.indexOf(closing, start + opening.length);
      // The bytes before the closing marker, or the fewest it can have when it has not come yet.
      const before = end === -1 ? output.length - closing.length + 1 : end;
      if (before > OUTPUT_LIMIT) stop("it printed more than 4 MiB");
      else if (end !== -1) finish({ env: envOf(base, output.subarray(start + opening.length, end).toString("utf8")) });
    });
    // A kill that fails emits `error`.
    child.on("error", (error) => finish(failed(error.message)));
    // Not `exit`: stdout can still hold data after it.
    child.on("close", (code, exitSignal) => {
      finish(failed(`it printed no environment (${exitSignal === null ? `exit code ${String(code)}` : `signal ${exitSignal}`})`));
    });
  });
}
