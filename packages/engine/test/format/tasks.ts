import { parseTask, serializeTask, type Task, TaskSerializeError } from "@tasma/engine";
import { fixture } from "./fixtures.js";

export const TIMESTAMP = "2026-07-01T12:00:00+03:00";

/** A task built from typed fields alone, the way a caller creates a new file. */
export function newTask(overrides: Partial<Task> = {}): Task {
  return {
    frontmatter: {
      id: "PROJ-99",
      title: "New",
      status: "To Do",
      created: TIMESTAMP,
      updated: TIMESTAMP,
      next_comment_id: 1,
    },
    body: "\nBody.\n",
    comments: [],
    ...overrides,
  };
}

/** The minimal file with `insert` written in place of `find`. */
export function frontmatterWith(find: string, insert: string): Task {
  return parseTask(fixture("valid/minimal.md").replace(find, insert)).task;
}

/** A task whose one comment carries a block marker, so a regeneration keeps that style. */
export function taskWithBlockMarker(): Task {
  const text = `${fixture("valid/minimal.md")}
<!-- task:comment
id: 1
title: t
created: "${TIMESTAMP}"
-->
`;
  return parseTask(text).task;
}

/** Runs `serializeTask` and returns the `TaskSerializeError` it must throw. */
export function serializeError(task: Task): TaskSerializeError {
  try {
    serializeTask(task);
  } catch (error) {
    if (error instanceof TaskSerializeError) return error;
    throw error;
  }
  throw new Error("serializeTask did not throw");
}
