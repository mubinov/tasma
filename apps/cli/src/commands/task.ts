// The `task` noun: the listing, the two views of a task's text, and the three
// write verbs the file beside this one holds. Every comment operation is a verb
// of the `comment` noun.
//
// A task id carries its project tag, so only the listing states a project. The
// working directory names nothing here.

import { parseArgs } from "node:util";
import type { TaskFilter } from "@tasma/protocol";
import { attempt, refuseAnswer } from "../failure.js";
import { cell, fieldsOf, isTaskText, table, withLineBreak } from "../output.js";
import { noun, reportUsage, wireText } from "../shell.js";
import type { Io, Options, Target } from "../types.js";
import { readProjectTag, readTaskId } from "./task-id.js";
import { WRITE_VERBS } from "./task-write.js";
import { HELP_OPTION, readVerb } from "./verb.js";

const LIST_OPTIONS = {
  project: { type: "string", short: "p" },
  status: { type: "string" },
  priority: { type: "string" },
  label: { type: "string", multiple: true },
  parent: { type: "string" },
  step: { type: "string" },
  blocked: { type: "boolean" },
  unblocked: { type: "boolean" },
  ...HELP_OPTION,
} as const satisfies Options;

const LIST_HELP = [
  "Usage: tasma task list --project <tag> [options]",
  "",
  "  -p, --project <tag>  Which project to list, required",
  "      --status <s>     Only the tasks holding this status",
  "      --priority <p>   Only the tasks holding this priority",
  "      --label <l>      Only the tasks carrying this label; repeat it for every label",
  "      --parent <id>    Only the tasks under this parent",
  "      --step <s>       Only the tasks on this workflow step",
  "      --blocked        Only the tasks a blocker holds up",
  "      --unblocked      Only the tasks nothing holds up",
  "  -h, --help           Print this help",
];

const VIEW_OPTIONS = { full: { type: "boolean" }, ...HELP_OPTION } as const satisfies Options;

const VIEW_HELP = [
  "Usage: tasma task view <id> [options]",
  "",
  "      --full  Print the file whole, every collapsed comment body included",
  "  -h, --help  Print this help",
];

/**
 * The value a filter states, or nothing where it states none.
 *
 * An empty value reads as no filter at all, the rule `--project` stands under
 * and the one the daemon applies to a filter it does receive. Sent as it stands
 * it would widen the listing silently: an unset shell variable would answer
 * every task at exit 0 as though the filter had matched them.
 */
function stated(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

/** The labels stated, the empty ones dropped, and nothing where none is left. */
function statedLabels(values: string[] | undefined): string[] | undefined {
  const labels = values?.filter((label) => label !== "");

  return labels === undefined || labels.length === 0 ? undefined : labels;
}

/** Which value the `blocked` filter takes, or nothing where neither flag was given. */
function blockedFilter(blocked: boolean | undefined, unblocked: boolean | undefined): boolean | undefined {
  if (blocked === true) return true;

  return unblocked === true ? false : undefined;
}

function isTaskList(answer: unknown): answer is { entries: unknown[]; excluded: unknown[] } {
  const { entries, excluded } = fieldsOf(answer);

  return Array.isArray(entries) && Array.isArray(excluded);
}

/** One task as a row. Labels, parent and blockers are filters rather than columns. */
function taskRow(entry: unknown): string[] {
  const { id, status, priority, step, title } = fieldsOf(fieldsOf(entry).frontmatter);

  return [cell(id), cell(status), cell(priority), cell(step), cell(title)];
}

/** A file named as a task file that holds no entry, as the caveat it is. */
function excludedLine(file: unknown): string {
  const { path, code, message } = fieldsOf(file);

  return `tasma: excluded: ${cell(path)}: ${cell(code)}: ${cell(message)}\n`;
}

/** What a default view left out, and the two ways to read it. */
function collapsedLine(id: string, hidden: unknown[]): string {
  const comments = hidden.length === 1 ? "comment" : "comments";
  const ids = hidden.map((value) => wireText(value)).join(", ");

  return `tasma: ${hidden.length} ${comments} collapsed (${ids}): `
    + `comment view ${wireText(id)} <n> prints one, task view ${wireText(id)} --full prints all\n`;
}

async function list(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "task list", help: LIST_HELP, takes: 0 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: LIST_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const { values } = parsed;
  const tag = readProjectTag(io, "task list", values.project);

  if (typeof tag === "number") return tag;
  if (values.blocked === true && values.unblocked === true) {
    return reportUsage(io, "--blocked and --unblocked exclude each other");
  }

  // Every value a filter states travels as it was typed: the CLI lowercases
  // nothing, trims nothing and matches nothing.
  const filter: TaskFilter = {
    status: stated(values.status),
    priority: stated(values.priority),
    label: statedLabels(values.label),
    parent: stated(values.parent),
    step: stated(values.step),
    blocked: blockedFilter(values.blocked, values.unblocked),
  };

  return attempt(io, target, (client) => client.listTasks(tag, filter), (data, url) => {
    const answer: unknown = data;

    if (!isTaskList(answer)) return refuseAnswer(io, url, "a task listing");

    io.stdout.write(table(answer.entries.map(taskRow)));

    for (const file of answer.excluded) {
      io.stderr.write(excludedLine(file));
    }

    return 0;
  });
}

async function view(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "task view", help: VIEW_HELP, takes: 1 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: VIEW_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const task = readTaskId(io, "task view", parsed.positionals[0]);

  if (typeof task === "number") return task;

  const selection = parsed.values.full === true ? undefined : { collapsed: false };

  return attempt(io, target, (client) => client.readTaskText(task.tag, task.id, selection), (data, url) => {
    const answer: unknown = data;

    if (!isTaskText(answer)) return refuseAnswer(io, url, "a task's text");

    io.stdout.write(withLineBreak(answer.text));

    if (answer.hidden.length > 0) io.stderr.write(collapsedLine(task.id, answer.hidden));

    return 0;
  });
}

export const task = noun("task", "Work with tasks", [
  {
    name: "list",
    summary: "List the tasks of a project",
    usage: { help: LIST_HELP, options: LIST_OPTIONS },
    run: list,
  },
  {
    name: "view",
    summary: "Print the text of one task",
    usage: { help: VIEW_HELP, options: VIEW_OPTIONS },
    run: view,
  },
  ...WRITE_VERBS,
]);
