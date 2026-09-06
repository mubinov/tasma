import { DEFAULT_DAEMON_URL, printable, ProtocolError, TransportError } from "@tasma/protocol";
import type { Client, DaemonRecord, Diagnostic, Success } from "@tasma/protocol";
import { daemonUrl, readRecord, recordPath } from "./daemon/record.js";
import { startDaemon } from "./daemon/start.js";
import type { StartOutcome } from "./daemon/start.js";
import { createDaemonClient, RequestTimeoutError } from "./daemon/transport.js";
import { wireText } from "./shell.js";
import type { Io, Target } from "./types.js";

/** A call that produced no answer this CLI can act on. */
export const UNREACHABLE = 3;

/** The daemon answered, and refused. */
const REFUSED = 1;

/**
 * Everything `attempt` needs from the tree that a test drives itself: where the
 * daemon of a tree is recorded, and how one is started.
 */
export type Reach = {
  readRecord: (path: string) => Promise<DaemonRecord | undefined>;
  start: (options: { home: string }) => Promise<StartOutcome>;
};

const REACH: Reach = { readRecord, start: startDaemon };

/**
 * The budget a call ran out of, or nothing where it failed some other way. A
 * call that ran out of time reached something: the connection was accepted and
 * the answer never came.
 */
function ranOut(error: TransportError): RequestTimeoutError | undefined {
  return error.cause instanceof RequestTimeoutError ? error.cause : undefined;
}

/**
 * Why a call produced no answer, in the terms the remedy differs on: a status
 * means something answered that was not a Tasma daemon, a budget means the call
 * ran out of time, and neither means nothing was there at all.
 *
 * The number of seconds is read off the fault rather than off the constant, so
 * the sentence cannot describe a budget other than the one the call ran under.
 */
function transportText(error: TransportError, url: string): string {
  if (error.status !== undefined) {
    return `${url} answered ${error.status}, but not as a Tasma daemon`;
  }

  const timeout = ranOut(error);

  return timeout === undefined
    ? `no daemon answered at ${url}`
    : `the daemon at ${url} did not answer within ${timeout.timeoutMs / 1000} seconds`;
}

/**
 * Where a diagnostic happened, in whichever of the three forms its fields
 * support. A line without a path prints nothing: a number on its own names no
 * location.
 */
function location(diagnostic: Diagnostic): string {
  if (diagnostic.path === undefined) return "";

  const path = wireText(diagnostic.path);

  return diagnostic.line === undefined ? ` (${path})` : ` (${path}:${wireText(diagnostic.line)})`;
}

/**
 * Whether a note is one there is anything to write. The envelope check reads the
 * diagnostics as an array and no further, so an element is whatever answered the
 * port, and one that is not an object carries neither a code nor a message.
 */
function isNote(value: unknown): value is Diagnostic {
  return typeof value === "object" && value !== null;
}

/** A well-formed answer from a process that is not a Tasma daemon. */
export function reportForeign(io: Io, url: string, name: unknown): number {
  io.stderr.write(`tasma: ${url} answered as "${wireText(name)}", not a Tasma daemon\n`);
  return UNREACHABLE;
}

/** The address to call, and the record it came from where one named it. */
type Located = { url: string; recorded?: string };

/**
 * Where a target is reached. A tree is reached at the port its record names,
 * and at the built-in default where it holds no record — the fallback for a
 * daemon whose record was removed by hand.
 *
 * No probe runs first: the command's own call is the probe, and a port that
 * gives no usable answer is what makes a record stale.
 */
async function locate(target: Target, reach: Reach): Promise<Located> {
  if (target.kind === "explicit") return { url: target.url };

  const path = recordPath(target.home);
  const record = await reach.readRecord(path);

  return record === undefined ? { url: DEFAULT_DAEMON_URL } : { url: daemonUrl(record.port), recorded: path };
}

/**
 * One daemon call, with every way the call itself can fail already written, so
 * no command handles a transport or a protocol fault.
 *
 * `print` returns the exit code because `attempt` classifies the call and not
 * the content: a command that has to refuse a well-formed answer says so by
 * returning a code of its own, and one with nothing to reject returns 0. It is
 * handed the address that answered, which a start on demand decides.
 *
 * A tree target no daemon answered for is started on demand and the call is
 * retried once, except where the call ran out of time; an address stated by hand
 * is never started, because a caller who named one is pointing at a daemon that
 * is meant to be there already.
 *
 * Nothing else is caught. An unexpected throw escapes to Node, which prints a
 * stack a hand-written wrapper would replace with a worse message.
 */
export async function attempt<T>(
  io: Io,
  target: Target,
  call: (client: Client) => Promise<Success<T>>,
  print: (data: T, url: string) => number,
  options: { start?: boolean; reach?: Reach } = {},
): Promise<number> {
  const reach = options.reach ?? REACH;

  async function once(url: string): Promise<number | TransportError> {
    let success: Success<T>;

    try {
      success = await call(createDaemonClient(url));
    } catch (error) {
      if (error instanceof TransportError) return error;

      if (error instanceof ProtocolError) {
        // The client admits a refusal only where all three of these are strings,
        // so a refusal that reached here carries no value to coerce.
        const { kind, code, message } = error.failure;
        io.stderr.write(`tasma: ${printable(`${kind}/${code}: ${message}`)}\n`);
        return REFUSED;
      }

      throw error;
    }

    // The answer before the diagnostics: where output is truncated it is the head
    // that survives, and the data is what was asked for.
    const code = print(success.data, url);

    // Nothing behind a refusal: a non-zero code is `print` declining the answer,
    // and the notes came from whatever sent it.
    if (code === 0) {
      for (const diagnostic of success.diagnostics) {
        if (!isNote(diagnostic)) continue;

        const note = `${wireText(diagnostic.code)}: ${wireText(diagnostic.message)}${location(diagnostic)}`;

        io.stderr.write(`tasma: note: ${note}\n`);
      }
    }

    return code;
  }

  const located = await locate(target, reach);
  const first = await once(located.url);

  if (!(first instanceof TransportError)) return first;

  // A call that ran out of time is never started behind, whatever the target:
  // something accepted it, and that something may be this tree's own daemon with
  // its event loop held. A second daemon over one tree is what the daemon's
  // per-process write queue cannot order.
  const timedOut = ranOut(first) !== undefined;

  if (target.kind === "explicit" || options.start === false || timedOut) {
    // Named only where the address came from a record and nothing was there to
    // answer: the port answering nothing is what makes that record stale, while
    // a call that ran out of time reached something the record may well name.
    const staleNote = located.recorded === undefined || timedOut
      ? ""
      : `; the record at ${printable(located.recorded)} is stale`;

    io.stderr.write(`tasma: ${transportText(first, located.url)}${staleNote}\n`);
    return UNREACHABLE;
  }

  const started = await reach.start({ home: target.home });

  if ("failure" in started) {
    io.stderr.write(`tasma: ${started.failure}\n`);
    return UNREACHABLE;
  }

  // The one retry, against the address the new record names. Its outcome is
  // final: a second start would spawn a daemon for a tree that just produced one.
  const second = await once(started.url);

  if (second instanceof TransportError) {
    io.stderr.write(`tasma: ${transportText(second, started.url)}\n`);
    return UNREACHABLE;
  }

  return second;
}
