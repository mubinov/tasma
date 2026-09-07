// The `project` noun. It reads the projects of a tree and writes none of them.

import { parseArgs } from "node:util";
import { attempt, refuseAnswer } from "../failure.js";
import { cell, fieldsOf, table } from "../output.js";
import { noun } from "../shell.js";
import type { Io, Options, Target } from "../types.js";
import { HELP_OPTION, readVerb, usageBlock } from "./verb.js";

const LIST_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const LIST_HELP = usageBlock("project list");

/** One project as a row: what identifies it, and what it calls itself. */
function projectRow(summary: unknown): string[] {
  const { tag, name, path } = fieldsOf(summary);

  return [cell(tag), cell(name), cell(path)];
}

async function list(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "project list", help: LIST_HELP, takes: 0 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: LIST_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  return attempt(io, target, (client) => client.listProjects(), (data, url) => {
    const answer: unknown = data;

    if (!Array.isArray(answer)) return refuseAnswer(io, url, "a project listing");

    io.stdout.write(table(answer.map(projectRow)));
    return 0;
  });
}

export const project = noun("project", "Work with projects", [
  {
    name: "list",
    summary: "List the projects of this tree",
    usage: { help: LIST_HELP, options: LIST_OPTIONS },
    run: list,
  },
]);
