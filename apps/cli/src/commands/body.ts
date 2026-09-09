// How a body reaches a write verb: the two flags it may arrive through, the
// three sources they name, and the rule that joins one body to another.
//
// Its own module because every write verb the CLI gains states a body the same
// way, and a second copy of the rule is what would let two of them differ.
//
// An append is two calls with nothing between them: the stored body is read,
// and the join is written back. No route carries a precondition, so a write
// landing between the two is overwritten without an error.

import { readFile } from "node:fs/promises";
import { fieldsOf } from "../output.js";
import { errorText, reportUsage } from "../shell.js";
import type { Io, Options, Source } from "../types.js";

/** The path that names standard input rather than a file. */
const STANDARD_INPUT = "-";

/** The two flags a body arrives through, spread into a verb's option table. */
export const BODY_OPTIONS = {
  "body": { type: "string" },
  "body-file": { type: "string" },
} as const satisfies Options;

/** Their two help rows, spliced into a verb's usage block. */
export const BODY_HELP = [
  "      --body <text>       The body, inline",
  "      --body-file <path>  The body, read from a file; - reads standard input",
];

/** What the two flags parsed to. */
export type BodyFlags = { "body"?: string; "body-file"?: string };

/** A source read to its end, the chunks that carry bytes decoded as UTF-8. */
async function readSource(source: Source): Promise<string> {
  // One decoder over the whole read: a chunk boundary falls wherever the writer's
  // buffer ended, so a multi-byte character can be split across two of them.
  const decoder = new TextDecoder();
  let text = "";

  for await (const chunk of source) {
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }

  return text + decoder.decode();
}

/** Why a read failed, as the errno code where it carries one and as its message otherwise. */
function readFault(error: unknown): string {
  const { code } = fieldsOf(error);

  return typeof code === "string" ? code : errorText(error);
}

/**
 * The body the flags state, nothing where they state none, or the code a fault
 * in them reported with.
 *
 * Standard input is read only where `-` was typed, so no verb blocks on a
 * terminal it was not asked to read.
 *
 * A file is taken as it stands: nothing is trimmed, no line break is normalised,
 * and an empty file is an empty body, because a file the caller pointed at is a
 * deliberate value where an empty flag is a shell variable that went unset. The
 * CLI caps no size; the daemon's own limit answers `request-too-large`.
 */
export async function readBody(io: Io, values: BodyFlags): Promise<string | undefined | number> {
  const inline = values.body;
  const path = values["body-file"];

  if (inline !== undefined && path !== undefined) {
    return reportUsage(io, "--body and --body-file exclude each other");
  }

  if (inline === "") return reportUsage(io, "--body needs a value");
  if (inline !== undefined) return inline;
  if (path === undefined) return undefined;
  if (path === "") return reportUsage(io, "--body-file needs a path");

  try {
    return path === STANDARD_INPUT ? await readSource(io.stdin) : await readFile(path, "utf8");
  } catch (error) {
    // The path was typed, so a source that cannot be read is a fault in the
    // invocation rather than an answer the daemon gave.
    return reportUsage(io, `cannot read ${path}: ${readFault(error)}`);
  }
}

/**
 * Where the stored body ends once the line breaks closing it are left off, a
 * carriage return counted with the break it precedes and never on its own.
 *
 * Walked from the end rather than matched: the body is text the daemon answered,
 * and a pattern for a run of breaks retries from every position inside a run
 * that stops short of the end, which a body holding thousands of them turns into
 * seconds of backtracking.
 */
function endBeforeBreaks(stored: string): number {
  let end = stored.length;

  while (stored[end - 1] === "\n") {
    end -= stored[end - 2] === "\r" ? 2 : 1;
  }

  return end;
}

/**
 * A body with text added after it, as one string: the stored body, one empty
 * line, the text as given.
 *
 * A stored body that strips to nothing answers the text alone, so an append to
 * an empty body does not open with a blank line. An empty text answers the
 * stored body as it stands: an empty file and an empty pipe are both bodies, and
 * adding nothing may not leave a blank line behind.
 */
export function appended(stored: string, text: string): string {
  if (text === "") return stored;

  const trimmed = stored.slice(0, endBeforeBreaks(stored));

  return trimmed === "" ? text : `${trimmed}\n\n${text}`;
}
