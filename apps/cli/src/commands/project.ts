// The `project` noun: the listing, the view of one project, the project that
// holds the working directory, and the four write verbs the file beside this
// one holds.

import { parseArgs } from "node:util";
import type { Config, ProjectSummary } from "@tasma/protocol";
import { attempt, REFUSED, refuseAnswer } from "../failure.js";
import { cell, fieldsOf, table } from "../output.js";
import { noun, reportUsage, wireText } from "../shell.js";
import type { Io, Options, Target } from "../types.js";
import { resolvedTag } from "./project-tag.js";
import { WRITE_VERBS } from "./project-write.js";
import { readProjectTagArgument } from "./task-id.js";
import { HELP_OPTION, readVerb, usageBlock } from "./verb.js";

const LIST_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const VIEW_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const CURRENT_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const LIST_HELP = usageBlock("project list");

const VIEW_HELP = usageBlock("project view <tag>");

const CURRENT_HELP = usageBlock("project current");

/** The keys `view` reads off the project itself, then off its configuration, in the `config.yml` order. */
const PROJECT_KEYS = ["tag", "name", "path"] as const satisfies readonly (keyof ProjectSummary)[];
const CONFIG_KEYS = [
  "statuses",
  "default_status",
  "final_statuses",
  "priorities",
  "workflows",
  "instructions",
  "workflows_path",
] as const satisfies readonly (keyof Config)[];

/** One project as a row: what identifies it, and what it calls itself. */
function projectRow(summary: unknown): string[] {
  const { tag, name, path } = fieldsOf(summary);

  return [cell(tag), cell(name), cell(path)];
}

/** Whether an answer is a project, tested over the configuration its rows are read from. */
function isProject(answer: unknown): answer is Record<string, unknown> & { config: Record<string, unknown> } {
  const { config } = fieldsOf(answer);

  return typeof config === "object" && config !== null;
}

/**
 * One key as rows: a list holds its first value on the key's row and each
 * further value on a row of its own, and an empty one marks the key's row.
 */
function keyRows(key: string, value: unknown): string[][] {
  if (!Array.isArray(value)) return [[key, cell(value)]];

  const entries: unknown[] = value;
  const [first, ...rest] = entries;

  return [[key, cell(first)], ...rest.map((entry) => ["", cell(entry)])];
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

async function view(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "project view", help: VIEW_HELP, takes: 1 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: VIEW_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const tag = readProjectTagArgument(io, "project view", parsed.positionals[0]);

  if (typeof tag === "number") return tag;

  return attempt(io, target, (client) => client.readProject(tag), (data, url) => {
    const answer: unknown = data;

    if (!isProject(answer)) return refuseAnswer(io, url, "a project");

    const rows = [
      ...PROJECT_KEYS.flatMap((key) => keyRows(key, answer[key])),
      ...CONFIG_KEYS.flatMap((key) => keyRows(key, answer.config[key])),
    ];

    io.stdout.write(table(rows));

    if (answer.live === false) {
      io.stderr.write(
        `tasma: note: the index of ${wireText(tag)} is not following the disk; `
        + "what the daemon reports about this project can be older than the files\n",
      );
    }

    return 0;
  });
}

async function current(args: string[], io: Io, target: Target, cwd: string): Promise<number> {
  const parsed = readVerb(io, args, { command: "project current", help: CURRENT_HELP, takes: 0 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: CURRENT_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  // The route reads an empty query key as an absent one, and would call the
  // request malformed.
  if (cwd === "") return reportUsage(io, "the working directory could not be read");

  let found: string | undefined;

  const code = await attempt(io, target, (client) => client.resolveProject(cwd), (data, url) => {
    const tag = resolvedTag(io, url, data);

    if (typeof tag === "number") return tag;

    if (tag !== null) {
      found = tag;
      io.stdout.write(`${wireText(tag)}\n`);
    }

    return 0;
  });

  if (code !== 0 || found !== undefined) return code;

  // After the notes, which explain it. No usage hint: the invocation was right.
  io.stderr.write(`tasma: project not found for the directory ${wireText(cwd)}\n`);
  return REFUSED;
}

export const project = noun("project", "Work with projects", [
  {
    name: "list",
    summary: "List the projects in the data directory",
    usage: { help: LIST_HELP, options: LIST_OPTIONS },
    run: list,
  },
  {
    name: "view",
    summary: "Print the configuration of one project",
    usage: { help: VIEW_HELP, options: VIEW_OPTIONS },
    run: view,
  },
  {
    name: "current",
    summary: "Print the tag of the project that holds the working directory",
    usage: { help: CURRENT_HELP, options: CURRENT_OPTIONS },
    run: current,
  },
  ...WRITE_VERBS,
]);
