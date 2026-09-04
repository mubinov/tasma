import { ProtocolError, TransportError } from "@tasma/protocol";
import type { Diagnostic, Success } from "@tasma/protocol";
import { RequestTimeoutError } from "./daemon/transport.js";
import { printable, wireText } from "./shell.js";
import type { Io } from "./types.js";

/** A call that produced no answer this CLI can act on. */
const UNREACHABLE = 3;

/** The daemon answered, and refused. */
const REFUSED = 1;

/**
 * Why a call produced no answer, in the terms the remedy differs on: a status
 * means something answered that was not a Tasma daemon, and the budget carried
 * on the fault means the call ran out of time rather than the connection
 * failing.
 *
 * The number of seconds is read off that fault rather than off the constant, so
 * the sentence cannot describe a budget other than the one the call ran under.
 */
function transportText(error: TransportError, url: string): string {
  if (error.status !== undefined) {
    return `${url} answered ${error.status}, but not as a Tasma daemon`;
  }

  if (error.cause instanceof RequestTimeoutError) {
    return `the daemon at ${url} did not answer within ${error.cause.timeoutMs / 1000} seconds`;
  }

  return `no daemon answered at ${url}`;
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

/**
 * One daemon call, with every way the call itself can fail already written, so
 * no command handles a transport or a protocol fault.
 *
 * `print` returns the exit code because `attempt` classifies the call and not
 * the content: a command that has to refuse a well-formed answer says so by
 * returning a code of its own, and one with nothing to reject returns 0.
 *
 * Nothing else is caught. An unexpected throw escapes to Node, which prints a
 * stack a hand-written wrapper would replace with a worse message.
 */
export async function attempt<T>(
  io: Io,
  url: string,
  call: () => Promise<Success<T>>,
  print: (data: T) => number,
): Promise<number> {
  let success: Success<T>;

  try {
    success = await call();
  } catch (error) {
    if (error instanceof TransportError) {
      io.stderr.write(`tasma: ${transportText(error, url)}\n`);
      return UNREACHABLE;
    }

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
  const code = print(success.data);

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
