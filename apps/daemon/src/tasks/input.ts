// What a request carries into a write: the body as a change, and the comment id
// the path names.
//
// No field rule lives here. A caller naming `id`, `created`, `updated` or
// `next_comment_id` is refused by the engine's `field-not-writable`; a bad
// label, an unknown status, an unknown step, an unresolvable blocker and a body
// that is not a string are all refused by the engine too. The daemon adds no
// second copy of any of them.

import { DaemonError } from "../http/failure.js";

/** A decimal integer, in either sign, and nothing a number literal also admits. */
const DECIMAL_INTEGER = /^-?\d+$/;

/**
 * The fields one write sets, which is what the engine's `TaskChange` and its
 * `CommentChange` each are. Named apart from both, because one conversion feeds
 * the task writes and the comment writes alike and neither call site should read
 * as if it were about the other.
 */
type WriteFields = { body?: string } & Record<string, unknown>;

/**
 * The body as the change the engine takes.
 *
 * An absent body is a change that sets nothing: a route that requires a field
 * is refused by the engine's own `field-required`, which reads better than
 * anything written here.
 *
 * Every top-level `null` becomes `undefined`, which is what makes the clearing
 * rule work: the engine clears a field for a key present with `undefined` and
 * leaves it alone for a key that is absent, so `{ "priority": null }` removes
 * the key from the file. The pass is shallow, over the body's own keys alone,
 * so a `null` nested under `custom` is stored as a real null.
 *
 * The change carries no prototype, and one pass fills it. A prototype would make
 * the assignment of a `__proto__` key set the prototype rather than the field
 * the caller sent, and a second pass over a body at the size limit would hold
 * the whole of it again.
 */
export function toChange(body: unknown): WriteFields {
  if (body === undefined) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DaemonError("malformed-request", "the request body must be a JSON object");
  }

  const fields = body as Record<string, unknown>;
  const change = Object.create(null) as WriteFields;
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    change[key] = value === null ? undefined : value;
  }
  return change;
}

/**
 * The comment id one path names. It is refused here rather than passed on,
 * because everything a path holds is text and the engine takes a number.
 */
export function commentIdOf(raw: string): number {
  const id = Number(raw);
  if (!DECIMAL_INTEGER.test(raw) || !Number.isSafeInteger(id)) {
    throw new DaemonError("malformed-request", "a comment id must be a decimal integer a number carries exactly");
  }
  return id;
}
