import type { Stats } from "node:fs";
import { constants, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { errnoOf } from "./errors.js";
import { tempPath } from "./paths.js";

/**
 * The open flags every rule of this layer rests on. A flag a platform does not
 * define is `undefined`, and `flags | undefined` is `flags`, so a missing one
 * would drop its rule with no fault; the check runs at load, so a platform that
 * cannot hold the rules never reaches a read.
 */
export function checkOpenFlags(defined: Record<string, unknown>): void {
  for (const name of ["O_NOFOLLOW", "O_NONBLOCK", "O_DIRECTORY"]) {
    if (typeof defined[name] !== "number") {
      throw new Error(`this platform defines no ${name}, which @tasma/engine needs to read a file safely`);
    }
  }
}

checkOpenFlags(constants);

/** The mode of a file this layer creates: readable by the account that owns the tree alone. */
export const FILE_MODE = 0o600;

/** The same for a directory this layer creates on demand. */
const DIRECTORY_MODE = 0o700;

/** Removes a file the caller no longer wants. The write that led here already failed. */
async function discard(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // The file either never existed or cannot be removed here.
  }
}

/** What one name holds, without following a symbolic link, or `undefined` when it does not exist. */
export async function entryAt(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The text of one file: `absent` when the name does not exist, `irregular` when
 * it holds a directory, a device or a pipe — and, unless `follow` is set, a
 * symbolic link. The type comes from the open handle rather than from a stat of
 * the name, so a name replaced between the two decides nothing, and `O_NONBLOCK`
 * keeps the open of a pipe from waiting for a writer while holding a thread.
 *
 * `follow` is set for the two configuration files, which the user places
 * anywhere. Every other name this layer reads is one it wrote itself, so a
 * symbolic link there points outside the tree the caller named.
 */
export async function readRegularFile(
  path: string,
  follow = false,
): Promise<{ text: string } | "absent" | "irregular"> {
  let flags = constants.O_RDONLY | constants.O_NONBLOCK;
  if (!follow) flags |= constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT") return "absent";
    // What `O_NOFOLLOW` reports for a symbolic link.
    if (code === "ELOOP") return "irregular";
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) return "irregular";
    return { text: await handle.readFile("utf8") };
  } finally {
    await handle.close();
  }
}

/**
 * Creates a directory that may already exist. `recursive` is not set, because it
 * also accepts a symbolic link under the name; an existing name therefore
 * reports `EEXIST`, and the caller checks what holds it.
 */
export async function makeDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (errnoOf(error) !== "EEXIST") throw error;
  }
}

/**
 * Flushes the directory entry a create or a rename installed: a flush of a file
 * makes its content durable but not the entry that names it. The open is
 * confined to a directory and never waits, and a fault is passed over: the
 * content is already durable, and a platform that does not open a directory for
 * reading cannot order the two entries at all.
 */
export async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_DIRECTORY);
    await handle.sync();
  } catch {
    // The filesystem then chooses the order of the two entries.
  } finally {
    await handle?.close();
  }
}

/**
 * The mode the replacement of `path` takes. A permission bit is carried over
 * only where it is narrower than `FILE_MODE`, so a mode a user restricted by
 * hand survives while a widened mode, the setuid bit and the setgid bit are
 * never installed by this layer.
 */
async function carriedMode(path: string): Promise<number> {
  const entry = await entryAt(path);
  return entry?.isFile() === true ? entry.mode & FILE_MODE : FILE_MODE;
}

/**
 * Writes a file that must not exist yet. The exclusive open is itself the guard
 * against a task counter lower than the highest file name, so `EEXIST` is passed
 * to the caller unchanged. A write that fails once the file exists leaves
 * nothing behind: a partial file there never became a task, and it would feed
 * the id rebuild as an unreadable file forever.
 */
export async function createExclusive(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", FILE_MODE);
  let written = false;
  try {
    await handle.writeFile(text, "utf8");
    // The content is durable before the counter that issued the id is written.
    await handle.sync();
    written = true;
  } finally {
    await handle.close();
    if (!written) await discard(path);
  }
  await syncDirectory(dirname(path));
}

/**
 * Replaces a file that already exists. The new text goes into a temp file in the
 * same directory — the same filesystem, which is what makes the rename atomic —
 * and the rename installs it in one step, so a reader gets either the whole old
 * file or the whole new one. An in-place write interrupted by a crash would
 * instead destroy a task file, which holds its whole history.
 */
export async function replaceFile(path: string, text: string): Promise<void> {
  const mode = await carriedMode(path);
  const temp = tempPath(path);
  let renamed = false;
  try {
    const handle = await open(temp, "wx", FILE_MODE);
    try {
      await handle.writeFile(text, "utf8");
      // The target takes the mode of the temp file, and only a chmod sets it
      // exactly: the umask narrows the mode an open declares.
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    renamed = true;
  } finally {
    if (!renamed) await discard(temp);
  }
  await syncDirectory(dirname(path));
}

export async function removeFile(path: string): Promise<void> {
  await unlink(path);
}
