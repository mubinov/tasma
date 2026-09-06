// The file that states where the running daemon listens: what it holds, how it
// is written, and how one start of two takes the tree.
//
// A port and a path on disk meet in this module, which the placement rule
// otherwise keeps apart: reading the task store tree is the engine's work, but
// the daemon's own lifecycle files are written and read here. The engine
// contributes the root and nothing else.

import { randomUUID } from "node:crypto";
import { constants, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expandRoot } from "@tasma/engine";
import { DAEMON_RECORD_FILE } from "@tasma/protocol";
import type { DaemonRecord } from "@tasma/protocol";
import { isPortNumber } from "./port.js";

/** The modes the engine gives everything in the tree: the account that owns it, alone. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * How much of the name is read. A record is a few dozen bytes, and a process
 * that can write into the tree root could otherwise force the whole of a very
 * long file into memory on every start and every shutdown.
 */
const RECORD_LIMIT = 4096;

/**
 * How many times a claim clears a name that holds no daemon and tries it again.
 * Each round either takes the tree, finds a daemon holding it, or clears one
 * record, so only a name being retaken as fast as it is cleared runs out.
 */
const CLAIM_ROUNDS = 3;

/** A process a signal can be sent to. Zero names the caller's own group and a negative value names another. */
function isProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function recordPath(root?: string): string {
  return join(expandRoot(root), DAEMON_RECORD_FILE);
}

/** A name of one call's own making, beside the record so a rename onto it stays within the one directory. */
function scratch(directory: string, use: string): string {
  return join(directory, `.${DAEMON_RECORD_FILE}.${randomUUID()}.${use}`);
}

/**
 * The text under the name, or an empty string where the name holds no record to
 * read: absent, not a regular file, or longer than a record can be.
 *
 * This is a name the daemon writes itself, so it is read under the engine's rule
 * for such a name: `O_NOFOLLOW`, because a symbolic link there points outside
 * the tree, and `O_NONBLOCK`, because the open of a pipe would otherwise wait
 * for a writer — a wait that would hang the start before the bind and the
 * shutdown after it. The type comes from the open handle rather than from a stat
 * of the name, so a name replaced between the two decides nothing.
 *
 * The length is bounded by the read itself and never by a measure taken before
 * it: a file grows between the two calls, and a measure the read does not use is
 * no ceiling at all.
 */
async function readText(path: string): Promise<string> {
  let handle;

  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    if (!(await handle.stat()).isFile()) return "";

    // One byte past the ceiling, so a buffer the read fills states a file longer
    // than a record can be whatever it holds.
    const buffer = Buffer.alloc(RECORD_LIMIT + 1);
    let filled = 0;
    let read = 0;

    do {
      ({ bytesRead: read } = await handle.read(buffer, filled, buffer.length - filled, filled));
      filled += read;
    } while (read > 0 && filled < buffer.length);

    return filled > RECORD_LIMIT ? "" : buffer.toString("utf8", 0, filled);
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

/**
 * What the text states, or `undefined` for every way it states nothing: not
 * JSON, not an object, or holding a field that is not the number it has to be.
 *
 * None of those is a fault. The file is a hint about where to look, and the
 * claim is what decides which daemon serves the tree.
 */
function recordOf(text: string): DaemonRecord | undefined {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (typeof value !== "object" || value === null) return undefined;

  const { port, pid } = value as { port?: unknown; pid?: unknown };

  return isPortNumber(port) && isProcessId(pid) ? { port, pid } : undefined;
}

export async function readRecord(root?: string): Promise<DaemonRecord | undefined> {
  return recordOf(await readText(recordPath(root)));
}

/**
 * The root of the tree, created where it does not exist yet.
 *
 * `recursive` is not set, because it also reports success for a symbolic link
 * under the name, which would put the record and its mode wherever the link
 * points. An existing name reports `EEXIST` instead, and what holds it is
 * checked here.
 */
async function makeRoot(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: DIRECTORY_MODE });

    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  if (!(await lstat(directory)).isDirectory()) throw new Error(`${directory} is not a directory`);
}

/**
 * Writes the record into a file of its own, which the claim then installs. The
 * content is whole before any name a reader follows points at it, so a reader
 * never sees half a record.
 */
async function stage(path: string, record: DaemonRecord): Promise<void> {
  const handle = await open(path, "wx", FILE_MODE);

  try {
    await handle.writeFile(JSON.stringify(record), "utf8");
    // Only a chmod sets the mode exactly: the umask narrows the one an open declares.
    await handle.chmod(FILE_MODE);
  } finally {
    await handle.close();
  }
}

/**
 * Removes names of the daemon's own making, without letting the removal mask
 * what the call came to. `recursive`, because what a claim takes away is
 * whatever stood under the record's name, which is the daemon's to clear
 * whatever it is.
 */
async function discard(...paths: string[]): Promise<void> {
  for (const path of paths) await rm(path, { force: true, recursive: true }).catch(() => undefined);
}

/**
 * Installs `source` under a name that must not exist yet, answering whether it
 * took it.
 *
 * A name that already exists is another start's claim. Every other fault ends
 * the start: the link is the one call that installs a file without replacing
 * whatever stands under the name, so there is nothing to fall back to that would
 * still be exclusive.
 */
async function linkOnto(source: string, path: string): Promise<boolean> {
  try {
    await link(source, path);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    return false;
  }
}

/**
 * Takes the name away, and keeps what it took only where `mine` reads the text
 * as this daemon's to remove. Anything else is put back.
 *
 * Taking the name away in one call is what makes the removal exclusive: of two
 * processes acting on one record, only one takes the file, and neither can
 * delete a name it does not hold. Reading a record and then unlinking its name
 * would instead remove whatever stands there by the time the unlink runs, which
 * on a restart is the successor's record and not the one that was read.
 *
 * What was taken and is not this daemon's stands again, unless the name was
 * claimed in the meantime.
 */
async function takeAway(path: string, taken: string, mine: (text: string) => boolean): Promise<void> {
  try {
    await rename(path, taken);
  } catch (error) {
    // A name that is not there is a removal that already happened. Every other
    // fault is a tree this daemon cannot write, which the caller has to hear.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    return;
  }

  try {
    if (!mine(await readText(taken))) await linkOnto(taken, path);
  } finally {
    await discard(taken);
  }
}

/**
 * Takes the tree for this daemon, or answers the record of the daemon that holds
 * it.
 *
 * The claim is a hard link onto a name that must not exist yet, which is the
 * ordering the bind cannot give: a start on port zero binds a port of its own,
 * so without this both of two starts would serve one tree, and the write queue
 * that orders overlapping writes is per process.
 *
 * `serving` answers whether a daemon holds the port a record names, and a record
 * naming none holds no tree: it is cleared and the link tried again.
 */
export async function claimRecord(
  root: string | undefined,
  record: DaemonRecord,
  serving: (port: number) => Promise<boolean>,
): Promise<DaemonRecord | undefined> {
  const path = recordPath(root);
  const directory = dirname(path);
  await makeRoot(directory);
  const staged = scratch(directory, "tmp");
  const taken = scratch(directory, "taken");

  try {
    await stage(staged, record);

    for (let round = 0; round < CLAIM_ROUNDS; round += 1) {
      if (await linkOnto(staged, path)) return undefined;

      const text = await readText(path);
      const held = recordOf(text);

      if (held !== undefined && (await serving(held.port))) return held;

      // A record installed between the judgement and the take is not the record
      // that was judged, so only the judged text is cleared.
      await takeAway(path, taken, (found) => found === text);
    }

    throw new Error("the record is claimed again as fast as it is cleared");
  } finally {
    // Both stand at the root of the tree, which no scan reads, so nothing would
    // ever report one left behind.
    await discard(staged, taken);
  }
}

/**
 * Removes the record, and only where it holds the given process: a daemon never
 * deletes a record another process wrote. An absent record is not a fault.
 */
export async function removeRecord(root: string | undefined, pid: number): Promise<void> {
  const path = recordPath(root);

  // A name stating no record of this daemon's is left as it stands, whatever it
  // holds: a shutdown has no business taking away a name it does not own, and
  // what a link cannot put back a rename must not take. The take below is what
  // decides ownership; this decides nothing.
  if ((await readRecord(root))?.pid !== pid) return;

  await takeAway(path, scratch(dirname(path), "taken"), (text) => recordOf(text)?.pid === pid);
}
