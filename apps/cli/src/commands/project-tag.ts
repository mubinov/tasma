// How a verb learns which project it acts on: the tag the caller stated, or the
// project the daemon says holds the working directory. Its own module because
// the three verbs that resolve a project — `task list`, `task create` and
// `project current` — sit in three files and must read the answer the same way.
//
// No path is compared here. A directory is sent and a tag is read: the CLI
// expands no `~`, resolves no link and lists no project to compare itself.

import { attempt, refuseAnswer } from "../failure.js";
import { fieldsOf } from "../output.js";
import { isPathComponent, reportUsage, wireText } from "../shell.js";
import type { Io, Target } from "../types.js";
import { readProjectTag } from "./task-id.js";

/** What a verb states about the project it acts on, and how it acts on it. */
type Asked = { command: string; stated: string | undefined; cwd: string; prove?: boolean };

/**
 * The tag a resolve answered, `null` where no project holds the directory, or
 * the code the refusal of the answer reported with.
 *
 * No project holding the directory is an answer rather than a fault, so a
 * printer returns 0 for it: a non-zero code suppresses the diagnostics, and a
 * project the comparison could not read is exactly what explains the empty
 * answer.
 *
 * The tag is gated as a stated tag is: where it becomes the path parameter of a
 * later call, `buildPath` throws on a value no path component can hold, and
 * `attempt` does not catch it.
 */
export function resolvedTag(io: Io, url: string, answer: unknown): string | null | number {
  if (answer === null) return null;

  const { tag } = fieldsOf(answer);

  return typeof tag === "string" && isPathComponent(tag) ? tag : refuseAnswer(io, url, "a project");
}

/**
 * The project the verb acts on, or the code the fault in naming it reported
 * with — the convention `readProjectTag` and `readTaskId` already answer under.
 *
 * A stated flag decides on its own and sends nothing: a caller who typed a tag
 * is naming a project rather than asking which one holds the directory, and an
 * empty value is refused there as it is everywhere else.
 *
 * The line naming the project is written only where this resolved it, and to
 * stderr: stdout carries the table of a listing and the receipt id of a write.
 */
export async function actingProject(io: Io, target: Target, asked: Asked): Promise<string | number> {
  if (asked.stated !== undefined) return readProjectTag(io, asked.command, asked.stated);

  // The entry point read no directory, which is the one thing the empty value
  // means. The route reads an empty query key as an absent one, so sending it
  // would have the daemon call the request malformed instead.
  if (asked.cwd === "") {
    return reportUsage(io, "the working directory could not be read; state a project with --project <tag>");
  }

  let found: string | undefined;

  const code = await attempt(io, target, (client) => client.resolveProject(asked.cwd), (data, url) => {
    const tag = resolvedTag(io, url, data);

    if (typeof tag === "number") return tag;

    if (tag !== null) {
      found = tag;
      io.stderr.write(`tasma: project ${wireText(tag)}, from ${wireText(asked.cwd)}\n`);
    }

    return 0;
  }, { prove: asked.prove });

  if (code !== 0) return code;
  if (found !== undefined) return found;

  return reportUsage(io, `no project holds ${wireText(asked.cwd)}; state one with --project <tag>`);
}
