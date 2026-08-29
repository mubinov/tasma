import { fail, type Faults } from "./errors.js";
import { COMMENT, type FieldSpec, FRONTMATTER, UNWRITABLE, WRITABLE, writableCopy } from "./schema.js";
import { type CommentSnapshot, type FrontmatterSnapshot, SNAPSHOT, type Task } from "./types.js";
import { isRecord } from "./values.js";

/** One comment as the writer reads it, with every value copied out of the caller's object. */
export type PinnedComment = { fields: Record<string, unknown>; body: string; snapshot: CommentSnapshot | undefined };

/** One comment whose shape holds, held back until the copy pass reads its values. */
type CheckedComment = { source: Record<string, unknown>; body: string; snapshot: CommentSnapshot | undefined };

/** The whole task in that form. Nothing downstream reads the caller's object again. */
export type PinnedTask = {
  frontmatter: Record<string, unknown>;
  body: string;
  comments: PinnedComment[];
  snapshot: FrontmatterSnapshot | undefined;
};

/**
 * A deep copy of the values one region holds, read from the caller's object once
 * per key. Every step below reads the copy, so an object that answers a second
 * read with another value cannot pass a check as one value and be written as
 * another. Each key starts a node budget of its own, the way the reader bounds
 * each key of a region on its own.
 *
 * The keys walked are the schema's. A writer states the keys this format
 * defines and takes every other key of a region from the source it writes back,
 * so a key of any other name on the caller's object names nothing that is
 * written and is read by nothing here.
 *
 * The record holds no prototype, so no key name it is ever given can reach a
 * setter of the object model instead of storing a value.
 */
function pinValues(
  source: Record<string, unknown>,
  schema: Record<string, FieldSpec>,
  faults: Faults,
): Record<string, unknown> {
  const pinned = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(schema)) {
    const value = source[key];
    // A key that names no value is an absent key, so it holds nothing to copy.
    if (value === undefined) continue;
    const copy = writableCopy(value);
    if (copy === UNWRITABLE) {
      fail("key-type", 1, `${faults.label} key "${key}" ${WRITABLE.expectation}`, key, faults.filename);
    }
    pinned[key] = copy;
  }
  return pinned;
}

/**
 * Reads the caller's task into a copy of its own. A caller outside TypeScript
 * can hand over any value, so the shape of the task is checked before any field
 * of it is dereferenced, and every value is copied before it is validated — a
 * value validated after the copy is not the value the copy holds. The retained
 * source is carried across by reference: it cannot be copied, because a walk
 * over the entries of a task drops a symbol key.
 */
export function pinTask(task: Task, filename: string | undefined): PinnedTask {
  if (!isRecord(task)) fail("key-type", 1, "the task must be a mapping", undefined, filename);
  const frontmatter = task.frontmatter;
  const body = task.body;
  const comments = task.comments;
  if (!isRecord(frontmatter)) fail("key-type", 1, 'task key "frontmatter" must be a mapping', "frontmatter", filename);
  if (typeof body !== "string") fail("key-type", 1, 'task key "body" must be a string', "body", filename);
  if (!Array.isArray(comments)) fail("key-type", 1, 'task key "comments" must be a list', "comments", filename);

  const checked: CheckedComment[] = [];
  for (const [index, comment] of comments.entries()) {
    const path = `comments[${index}]`;
    if (!isRecord(comment)) fail("key-type", 1, `task key "${path}" must be a mapping`, path, filename);
    const commentBody = comment.body;
    if (typeof commentBody !== "string") {
      fail("key-type", 1, `task key "${path}.body" must be a string`, `${path}.body`, filename);
    }
    checked.push({ source: comment, body: commentBody, snapshot: comment[SNAPSHOT] });
  }

  const markerFaults: Faults = { label: "marker", filename };
  return {
    frontmatter: pinValues(frontmatter, FRONTMATTER, { label: "frontmatter", filename }),
    body,
    comments: checked.map((comment) => ({
      fields: pinValues(comment.source, COMMENT, markerFaults),
      body: comment.body,
      snapshot: comment.snapshot,
    })),
    snapshot: task[SNAPSHOT],
  };
}
