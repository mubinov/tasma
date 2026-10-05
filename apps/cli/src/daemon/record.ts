// How a command finds the daemon of a tree: where the record stands, what it
// states, and whether a daemon still answers at the address it names.
//
// The CLI only ever reads the record. Writing it, replacing it and removing it
// are the daemon's own, so a stale record is reported and never repaired here.

import { constants, open } from "node:fs/promises";
import { join } from "node:path";
import {
  createClient, DAEMON_NAME, DAEMON_RECORD_FILE, parseDaemonRecord, TransportError, TREE_DIRNAME,
} from "@tasma/protocol";
import type { DaemonRecord, Transport } from "@tasma/protocol";
import { ranOutOfTime, replyText } from "./transport.js";

/**
 * How much of the name is read. A record is a few dozen bytes, and a process
 * that can write into the tree root could otherwise force the whole of a very
 * long file into memory on every command.
 */
export const RECORD_LIMIT = 4096;

/**
 * How long a probe waits. A loopback port either answers at once or refuses at
 * once; the budget bounds the one case that does neither, a process that accepts
 * the connection and never replies.
 */
export const PROBE_TIMEOUT_MS = 1000;

/**
 * How much of a reply is read. A health answer is two short fields, and the
 * budget alone would let whatever holds the recorded port send for the whole of
 * it.
 */
export const PROBE_BODY_LIMIT = 64 * 1024;

export function recordPath(home: string): string {
  return join(home, TREE_DIRNAME, DAEMON_RECORD_FILE);
}

/**
 * The text under the name, `undefined` where nothing stands at the name, or an
 * empty string where it holds no record to read: a link, not a regular file, or
 * longer than a record can be.
 *
 * `O_NOFOLLOW`, because a symbolic link there points outside the tree, and
 * `O_NONBLOCK`, because the open of a pipe would otherwise wait for a writer — a
 * wait that would hang the command reading it. The type comes from the open
 * handle rather than from a stat of the name, so a name replaced between the two
 * decides nothing.
 *
 * The length is bounded by the read itself and never by a measure taken before
 * it: a file grows between the two calls, and a measure the read does not use is
 * no ceiling at all.
 */
async function readText(path: string): Promise<string | undefined> {
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
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;

    return code === "ENOENT" || code === "ENOTDIR" ? undefined : "";
  } finally {
    await handle?.close();
  }
}

/** What stands at the name of the record: a record, nothing, or a file that states no record. */
export type RecordRead = DaemonRecord | "absent" | "unreadable";

export async function inspectRecord(path: string): Promise<RecordRead> {
  const text = await readText(path);

  return text === undefined ? "absent" : parseDaemonRecord(text) ?? "unreadable";
}

/**
 * What the record states, or `undefined` where it states nothing. That is not a
 * fault: the record is a hint about where to look, and a command that reaches
 * no daemon at the address it names says so.
 */
export async function readRecord(path: string): Promise<DaemonRecord | undefined> {
  const read = await inspectRecord(path);

  return typeof read === "string" ? undefined : read;
}

/**
 * What a probe found at an address: a Tasma daemon, a listener that had not
 * answered within the budget, or neither — nothing listening, an answer from
 * something that is not a daemon, and every other fault.
 *
 * The budget running out is its own answer because something accepted the
 * connection. A caller that starts a daemon where nothing answered would
 * otherwise start a second one over the tree a slow daemon already serves.
 */
export type Probed = "daemon" | "late" | "none";

/**
 * What answers at this address.
 *
 * The one field that identifies a daemon decides, because a stale record names a
 * port another program may hold and answer well-formed JSON on.
 *
 * The reply is bounded at what a health answer takes rather than at the ceiling
 * the client transport carries: the port is held by whatever now holds it, and
 * this call reaches it before anything has identified it as a daemon.
 *
 * Nothing in production passes `timeoutMs`; it is there so the budget can be
 * driven in milliseconds.
 */
export async function probe(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Probed> {
  // Health is the one route this transport carries: a read, so it sends no body
  // and needs no media type. A redirect is refused rather than followed, which
  // is what keeps the call on the loopback address it was given.
  const transport: Transport = async ({ method, path }) => {
    const response = await fetch(`${url}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });

    return { status: response.status, body: JSON.parse(await replyText(response, PROBE_BODY_LIMIT)) as unknown };
  };

  try {
    const { data } = await createClient(transport).readHealth();
    // Read as the wire carries it: the envelope check reads no further than its
    // discriminant, so the answer is whatever the port sent.
    const answer = data as { name?: unknown } | null | undefined;

    return answer?.name === DAEMON_NAME ? "daemon" : "none";
  } catch (error) {
    // The client wraps whatever the transport threw, so the budget is read off
    // the cause rather than off the error the call rejected with.
    return error instanceof TransportError && ranOutOfTime(error.cause) ? "late" : "none";
  }
}

/** Whether a Tasma daemon answers at this address. One that had not answered within the budget is not one yet. */
export async function daemonAnswers(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return (await probe(url, timeoutMs)) === "daemon";
}
