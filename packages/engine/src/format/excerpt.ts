/**
 * Cutting the text of a task file by its parse: the file less the body of every
 * collapsed comment, or the region of one comment alone.
 *
 * Every cut is an offset into the text as it was read, so a file whose lines end
 * with CRLF comes back carrying its carriage returns, and what is kept is kept
 * byte for byte.
 */

import { type Line, splitLines } from "./text.js";
import { SNAPSHOT, type Task, type TaskComment } from "./types.js";

/** Where one comment sits in the text: its marker, its body, and the end of both. */
type Region = { start: number; bodyStart: number; end: number };

/** The offset a 1-based line starts at, or the end of the text past the last line. */
function startOf(text: string, lines: Line[], line: number): number {
  return lines[line - 1]?.start ?? text.length;
}

/**
 * Where a comment stands in the text it was parsed from.
 *
 * The snapshot and `lines` are optional on the type and set together by the
 * parser, so a comment carrying neither — one that went through JSON, or one a
 * caller wrote as a literal — has nothing that places its body. It is an
 * invariant of this layer rather than a refusal a caller can cause: the store
 * cuts only the text it just parsed.
 */
function regionOf(text: string, lines: Line[], comment: TaskComment): Region {
  const snapshot = comment[SNAPSHOT];
  const span = comment.lines;
  if (snapshot === undefined || span === undefined) {
    throw new Error(`comment ${comment.id} carries no parsed source, so its body cannot be placed`);
  }
  const start = startOf(text, lines, span.start);
  return { start, bodyStart: start + snapshot.raw.length, end: startOf(text, lines, span.end + 1) };
}

/**
 * The text with the body of every collapsed comment left out, and the ids of
 * those comments in file order.
 *
 * The markers stay, so the result is a task file in which each collapsed comment
 * carries an empty body. `hidden` names every comment the marker states
 * collapsed, whether or not its body was already empty: it reports what the
 * reader is not being shown, not which bytes were removed.
 */
export function withoutCollapsedBodies(text: string, task: Task): { text: string; hidden: number[] } {
  const lines = splitLines(text);
  const hidden: number[] = [];
  const kept: string[] = [];
  let at = 0;
  for (const comment of task.comments) {
    if (comment.collapsed !== true) continue;
    const region = regionOf(text, lines, comment);
    hidden.push(comment.id);
    kept.push(text.slice(at, region.bodyStart));
    at = region.end;
  }
  kept.push(text.slice(at));
  return { text: kept.join(""), hidden };
}

/** The region of one comment: its marker and its body, as the text holds them. */
export function commentRegion(text: string, comment: TaskComment): string {
  const lines = splitLines(text);
  const region = regionOf(text, lines, comment);
  return text.slice(region.start, region.end);
}
