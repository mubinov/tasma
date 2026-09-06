// Starting a daemon for this tree: where its executable is, where its output
// goes, and how long the CLI waits for it to answer.
//
// This is the one module below the entry point that reads `process.env` and
// `process.execPath`, because a spawn hands the process's own environment and
// runtime to the child.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { constants, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { printable } from "@tasma/protocol";
import { daemonUrl, probe, readRecord, recordPath } from "./record.js";

/** Where the spawned daemon's stdout and stderr are captured. Appended to and never rotated: it is stdio, not a log. */
export const OUTPUT_FILE = "tasma-daemon.out";

/** How long a start waits for a daemon to answer before it gives up on it. */
const START_BUDGET_MS = 10_000;

/** How often a wait looks again. Shared with the wait `daemon stop` runs. */
export const TICK_MS = 100;

/**
 * How long the wait holds after the child ended before it settles on that end.
 *
 * A daemon stands down for one already holding the port it asked for, having
 * seen that port answer and not a record; the daemon it stood down for binds
 * before it writes its record. The grace covers that gap, so an exit taken as
 * proof that no daemon serves this tree is one no late record can contradict.
 */
const STAND_DOWN_GRACE_MS = 500;

/** The mode the tree's own files carry: the account that owns them, alone. */
const FILE_MODE = 0o600;

/**
 * How much of what the child appended the failure line is read from. The daemon
 * writes one line before it exits, and the child is otherwise free to append
 * whatever it likes.
 */
const OUTPUT_TAIL_LIMIT = 4096;

/** The package that carries the daemon, and the executable it declares. */
const DAEMON_PACKAGE = "@tasma/daemon";
const DAEMON_BIN = "tasma-daemon";

export type StartOutcome = { url: string } | { failure: string };

export type StartOptions = {
  home: string;
  /** Where the daemon executable is. A parameter for the tests alone. */
  executable?: () => string;
  output?: string;
  budgetMs?: number;
};

/**
 * The daemon executable, found through module resolution of the package that
 * declares it rather than through `PATH` or a layout: a global link and a
 * hand-made `bin` entry are both things an install can be missing, and this
 * package is a declared dependency.
 *
 * `resolve` is a parameter for the tests alone.
 */
export function daemonExecutable(resolve: (specifier: string) => string = (s) => import.meta.resolve(s)): string {
  let manifest: string;

  try {
    manifest = fileURLToPath(resolve(`${DAEMON_PACKAGE}/package.json`));
  } catch {
    throw new Error(`the daemon package ${DAEMON_PACKAGE} is not installed`);
  }

  const directory = dirname(manifest);
  let target: unknown;

  try {
    const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: unknown };
    target = typeof bin === "object" && bin !== null ? (bin as Record<string, unknown>)[DAEMON_BIN] : undefined;
  } catch {
    target = undefined;
  }

  if (typeof target !== "string") {
    throw new Error(`no daemon executable at ${printable(directory)}`);
  }

  const executable = join(directory, target);

  // A build that did not run, which is worth its own sentence: every other way
  // this fails is an install that is not there at all.
  if (!existsSync(executable)) {
    throw new Error(`no daemon executable at ${printable(executable)}`);
  }

  return executable;
}

/** Holds for one tick of a wait. Shared with the wait `daemon stop` runs. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The text of a throw. Unlike `errorText`, a throw that is not an `Error` is
 * rendered rather than named: what is thrown here comes from a spawn or a
 * caller's own `executable`, so its own text is the only statement of the fault.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The last non-empty line the child appended after the mark, as text safe to
 * print, or an empty string where it appended nothing readable.
 *
 * Only the tail is read: the bytes are a child's output and their length is the
 * child's to decide, while the sentence they end up in holds one line.
 */
async function lastAppendedLine(path: string, mark: number): Promise<string> {
  let handle;

  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    const { size } = await handle.stat();
    const from = Math.max(mark, size - OUTPUT_TAIL_LIMIT);
    // Never negative: the name can hold a shorter file than the mark was taken
    // from, and a length below zero is not a size a buffer has.
    const buffer = Buffer.alloc(Math.max(0, size - from));

    // One read, because a short one costs a shorter quote and nothing else.
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);

    const lines = buffer
      .toString("utf8", 0, bytesRead)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");

    return printable(lines.at(-1) ?? "");
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

/** How a start ended, as the child reported it, or nothing while it is still running. */
type Ended = { code: number | null; signal: NodeJS.Signals | null };

/**
 * What a child that ended before a daemon answered came to.
 *
 * A child that exited 0 stood down for another daemon, and reaching here means
 * that daemon does not serve this tree — it holds the port this one asked for
 * and answers for another. The line it wrote is the only statement of which.
 */
async function endedFailure(ended: Ended, output: string, mark: number): Promise<string> {
  if (ended.signal !== null) return `${DAEMON_BIN} was ended by ${ended.signal}`;

  const line = await lastAppendedLine(output, mark);
  const said = line === "" ? "" : `: ${line}`;

  return ended.code === 0
    ? `${DAEMON_BIN} exited without serving this tree${said}`
    : `${DAEMON_BIN} exited with code ${ended.code}${said}`;
}

/**
 * Starts a daemon for the tree under `home` and waits until one answers.
 *
 * The spawned process is detached, so the terminal's signals never reach it and
 * the CLI can exit as soon as it has printed. Its output is captured in a file
 * because a daemon that dies before it answers has nowhere else to say why.
 *
 * The record decides ahead of the child. Two commands starting at once spawn two
 * daemons, of which one stands down for the other; the winner's record is the
 * answer, whichever process wrote it.
 */
export async function startDaemon(options: StartOptions): Promise<StartOutcome> {
  const { home } = options;
  const budgetMs = options.budgetMs ?? START_BUDGET_MS;
  const output = options.output ?? join(tmpdir(), OUTPUT_FILE);

  let executable: string;

  try {
    executable = (options.executable ?? daemonExecutable)();
  } catch (error) {
    return { failure: messageOf(error) };
  }

  let handle;
  let mark: number;

  try {
    // The name stands in a directory every account can write, so nothing planted
    // under it is followed or waited on: `O_NOFOLLOW` refuses a symbolic link,
    // `O_NONBLOCK` refuses a pipe rather than waiting for a reader that never
    // comes, and the type off the open handle refuses every other kind — a pipe
    // a reader already holds included. The flag is inert on a regular file, so
    // the descriptor the child is handed is an ordinary one.
    //
    // The chmod is what sets the mode exactly: the umask narrows the one an open
    // declares, and a file created read-only would refuse every later append.
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW
      | constants.O_NONBLOCK;

    handle = await open(output, flags, FILE_MODE);

    const stats = await handle.stat();

    // A second name is a link no open sees and no type states: `link(2)` asks
    // the target's owner for nothing, so the name can be another name for a file
    // this account owns, which the chmod below would then narrow and the child
    // would then append to. One link is the file this start created or the one a
    // start before it left.
    if (!stats.isFile() || stats.nlink !== 1) throw new Error("the name holds no file of this daemon's own");

    await handle.chmod(FILE_MODE);
    mark = stats.size;
  } catch {
    await handle?.close();

    return { failure: `the daemon output file could not be opened: ${printable(output)}` };
  }

  // One object rather than two variables: what the child reports arrives in a
  // callback, and a variable written there alone reads as never written.
  const child: { ended?: Ended; failure?: string } = {};

  try {
    const process_ = spawn(process.execPath, [executable], {
      detached: true,
      stdio: ["ignore", handle.fd, handle.fd],
      env: { ...process.env, HOME: home },
    });

    process_.on("error", (error) => {
      child.failure = `${DAEMON_BIN} could not be started: ${printable(messageOf(error))}`;
    });
    process_.on("exit", (code, signal) => {
      child.ended = { code, signal };
    });
    process_.unref();
  } catch (error) {
    return { failure: `${DAEMON_BIN} could not be started: ${printable(messageOf(error))}` };
  } finally {
    await handle.close();
  }

  const path = recordPath(home);
  const deadline = Date.now() + budgetMs;
  let settle: number | undefined;

  for (;;) {
    // Sampled before the record is read, so what settles a child that has ended
    // is a record read after it ended and not one read before.
    const { ended } = child;
    const record = await readRecord(path);

    if (record !== undefined) {
      const url = daemonUrl(record.port);

      if (await probe(url)) return { url };
    }

    if (child.failure !== undefined) return { failure: child.failure };

    if (ended !== undefined) {
      settle ??= Date.now() + STAND_DOWN_GRACE_MS;

      // A child that failed says so itself. One that exited 0 stood down, and
      // only the grace tells a record still to be written from one that is never
      // coming.
      if (ended.code !== 0 || Date.now() >= settle) return { failure: await endedFailure(ended, output, mark) };
    }

    if (Date.now() >= deadline) {
      return { failure: `${DAEMON_BIN} did not answer within ${budgetMs / 1000} seconds` };
    }

    await delay(TICK_MS);
  }
}
