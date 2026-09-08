// How a task and a project are named on the command line. Its own module
// because the reads and the writes of the `task` noun sit in two files and both
// name the same things the same way.

import { isPathComponent, reportUsage } from "../shell.js";
import type { Io } from "../types.js";

/** A task id, and the project tag it carries. */
export type TaskId = { tag: string; id: string };

/**
 * The task id one argument states, or nothing where it states none.
 *
 * The tag is what stands before the first `-`, which the engine's own name rule
 * makes unambiguous: a tag holds letters and digits alone, so the first `-` of
 * an id ends it. Whether that tag names a project, and whether the rest names a
 * task, is the daemon's to say.
 */
export function taskIdOf(text: string): TaskId | undefined {
  const dash = text.indexOf("-");

  if (dash <= 0 || dash === text.length - 1) return undefined;

  const tag = text.slice(0, dash);

  return isPathComponent(tag) && isPathComponent(text) ? { tag, id: text } : undefined;
}

/** The task the verb acts on, or the code the fault in its id reported with. */
export function readTaskId(io: Io, command: string, text: string | undefined): TaskId | number {
  if (text === undefined) return reportUsage(io, `${command} needs a task id`);

  return taskIdOf(text) ?? reportUsage(io, `not a task id: ${text}`);
}

/**
 * The project a verb acts on, or the code the fault in its tag reported with.
 *
 * An empty value is no value: an unset shell variable states no project rather
 * than one named "". The tag stands as one path component of the tree, which is
 * what keeps `buildPath` from ever being handed a value a URL would resolve away.
 */
export function readProjectTag(io: Io, command: string, text: string | undefined): string | number {
  if (text === undefined || text === "") return reportUsage(io, `${command} needs --project <tag>`);

  return isPathComponent(text) ? text : reportUsage(io, `not a project tag: ${text}`);
}
