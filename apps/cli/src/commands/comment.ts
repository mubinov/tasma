// The `comment` noun: the map of a task's comments, one comment read alone, and
// the three writes that add, change and remove one.
//
// Every verb names its comment by the task it belongs to and a numeric id, so
// none of them states a project: the task id carries the tag.
//
// Reads and writes share this file, where the `task` noun splits them across
// two: `view`, `edit` and `delete` all name a comment by id, so a split would
// put the reader of that id in a third module to keep the halves from importing
// each other.

import { parseArgs } from "node:util";
import type { CommentInput } from "@tasma/protocol";
import { attempt, refuseAnswer, reportRefusal } from "../failure.js";
import { cell, fieldsOf, isTaskText, table, withLineBreak } from "../output.js";
import { noun, reportUsage, wireText } from "../shell.js";
import type { Io, Options, Target } from "../types.js";
import { appended, BODY_HELP, BODY_OPTIONS, readBody } from "./body.js";
import { applyClears, flagsGiven, refuseAppend, refuseClears, refuseEmpty, refuseNoChange } from "./change.js";
import type { Fields } from "./change.js";
import { readTaskId } from "./task-id.js";
import type { TaskId } from "./task-id.js";
import { HELP_OPTION, readVerb, usageBlock } from "./verb.js";

/** Every flag that states a field, in the order a fault in one is reported. */
const FIELD_FLAGS = ["title", "author", "collapsed"] as const satisfies readonly (keyof FieldValues)[];

/** The fields `--clear` removes. `title` is not among them: the format requires it. */
export const CLEARABLE: readonly string[] = ["author", "collapsed", "body"];

/** What this family states about its own fields. Every flag spells its key exactly, so it names no key map. */
const FIELDS: Fields = { flags: FIELD_FLAGS, clearable: CLEARABLE };

const FIELD_OPTIONS = {
  title: { type: "string" },
  author: { type: "string" },
  collapsed: { type: "boolean" },
} as const satisfies Options;

const LIST_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const LIST_HELP = usageBlock("comment list <task-id>");

const VIEW_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const VIEW_HELP = usageBlock("comment view <task-id> <n>");

const ADD_OPTIONS = { ...FIELD_OPTIONS, ...BODY_OPTIONS, ...HELP_OPTION } as const satisfies Options;

const ADD_HELP = [
  "Usage: tasma comment add <task-id> --title <title> [options]",
  "",
  "      --title <title>     The title, required",
  "      --author <name>     Who wrote the comment",
  "      --collapsed         Store the comment collapsed: the title prints, the body hides",
  ...BODY_HELP,
  "  -h, --help              Print this help",
];

const EDIT_OPTIONS = {
  ...FIELD_OPTIONS,
  ...BODY_OPTIONS,
  append: { type: "boolean" },
  clear: { type: "string", multiple: true },
  ...HELP_OPTION,
} as const satisfies Options;

const EDIT_HELP = [
  "Usage: tasma comment edit <task-id> <n> [options]",
  "",
  "      --title <title>     The title",
  "      --author <name>     Who wrote the comment",
  "      --collapsed         Store the comment collapsed: the title prints, the body hides",
  ...BODY_HELP,
  "      --append            Add the body after the stored one; reads the comment first",
  "      --clear <field>     Remove a field: author, collapsed or body; repeat it for every field",
  "  -h, --help              Print this help",
];

const DELETE_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const DELETE_HELP = usageBlock("comment delete <task-id> <n>");

/** What the field flags parsed to, which both writes read the same way. */
type FieldValues = { title?: string; author?: string; collapsed?: boolean };

/** A comment id as it may be typed: a decimal run, and nothing else. */
const DECIMAL = /^\d+$/;

/** The comment id one argument states, or nothing where it states none. */
function commentIdOf(text: string): number | undefined {
  if (!DECIMAL.test(text)) return undefined;

  const value = Number(text);

  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The comment the verb acts on, or the code the fault in its id reported with.
 *
 * The id is wrapped, because an exit code is a number as much as a comment id is
 * and the caller has to tell one from the other.
 */
function readCommentId(io: Io, command: string, text: string | undefined): { id: number } | number {
  if (text === undefined) return reportUsage(io, `${command} needs a comment id`);

  const id = commentIdOf(text);

  return id === undefined ? reportUsage(io, `not a comment id: ${text}`) : { id };
}

/** The 1-based inclusive range a comment header carries, or nothing where it carries none. */
function lineRange(lines: unknown): string | undefined {
  if (typeof lines !== "object" || lines === null) return undefined;

  const { start, end } = fieldsOf(lines);

  return `${cell(start)}-${cell(end)}`;
}

/** One comment as a row, its title last because it is the one column of unbounded width. */
function commentRow(header: unknown): string[] {
  const { id, lines, bytes, collapsed, created, author, title } = fieldsOf(header);

  return [
    cell(id),
    cell(lineRange(lines)),
    cell(bytes),
    cell(collapsed === true ? "collapsed" : undefined),
    cell(created),
    cell(author),
    cell(title),
  ];
}

/**
 * The change the field flags state: one key per flag typed, and none at all for
 * a flag left out, so an edit touches nothing it was not asked to touch.
 *
 * `collapsed` is never sent as `false`: the flag takes no value, so the parser
 * answers `true` or no key at all. The engine's reader tests for the key, so an
 * explicit `false` would leave a key in the marker meaning what no key means;
 * `--clear collapsed` is what removes it.
 */
function fieldsFrom(values: FieldValues): CommentInput {
  const change: CommentInput = {};

  for (const flag of FIELD_FLAGS) {
    const value = values[flag];

    if (value !== undefined) change[flag] = value;
  }

  return change;
}

/**
 * How every comment write reports what it did: the comment id, one line, and
 * nothing else on stdout, so `n=$(tasma comment add …)` holds the issued id.
 *
 * The task id is not printed beside it: the caller typed that one. What the
 * write stored is visible through `comment view`.
 */
function receiptPrinter(io: Io): (data: unknown, url: string) => number {
  return (data, url) => {
    const { commentId } = fieldsOf(data);

    if (typeof commentId !== "number") return refuseAnswer(io, url, "a comment write receipt");

    io.stdout.write(`${wireText(commentId)}\n`);
    return 0;
  };
}

async function list(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "comment list", help: LIST_HELP, takes: 1 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: LIST_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const task = readTaskId(io, "comment list", parsed.positionals[0]);

  if (typeof task === "number") return task;

  return attempt(io, target, (client) => client.listComments(task.tag, task.id), (data, url) => {
    const answer: unknown = data;

    if (!Array.isArray(answer)) return refuseAnswer(io, url, "a comment map");

    io.stdout.write(table(answer.map(commentRow)));
    return 0;
  });
}

async function view(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "comment view", help: VIEW_HELP, takes: 2 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: VIEW_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const task = readTaskId(io, "comment view", parsed.positionals[0]);

  if (typeof task === "number") return task;

  const chosen = readCommentId(io, "comment view", parsed.positionals[1]);

  if (typeof chosen === "number") return chosen;

  const selection = { comment: chosen.id };

  return attempt(io, target, (client) => client.readTaskText(task.tag, task.id, selection), (data, url) => {
    const answer: unknown = data;

    if (!isTaskText(answer)) return refuseAnswer(io, url, "a task's text");

    io.stdout.write(withLineBreak(answer.text));
    return 0;
  });
}

/**
 * The body the comment holds now, the code the read reported with, or the
 * refusal where the task carries no such comment.
 *
 * The whole task is read because that is the only call answering a comment's
 * body: the map answers headers with a byte count, and the text route answers
 * the marker and the body as one string.
 */
async function readStored(io: Io, target: Target, task: TaskId, commentId: number): Promise<string | number> {
  let stored: string | undefined;

  const code = await attempt(
    io,
    target,
    (client) => client.readTask(task.tag, task.id),
    (data, url) => {
      const answer: unknown = data;
      const { comments } = fieldsOf(answer);

      if (!Array.isArray(comments)) return refuseAnswer(io, url, "a task");

      const entries: unknown[] = comments;
      const found = entries.find((entry) => fieldsOf(entry).id === commentId);

      if (found === undefined) return 0;

      const { body } = fieldsOf(found);

      if (typeof body !== "string") return refuseAnswer(io, url, "a task");

      stored = body;
      return 0;
    },
    { prove: true },
  );

  if (code !== 0) return code;

  // The same mistake without --append reaches the daemon and comes back as this
  // very refusal, so the append path reports it in the shape the daemon gives it.
  if (stored === undefined) {
    return reportRefusal(io, "store", "comment-not-found", `this file carries no comment ${wireText(commentId)}`);
  }

  return stored;
}

async function add(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "comment add", help: ADD_HELP, takes: 1 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: ADD_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const task = readTaskId(io, "comment add", parsed.positionals[0]);

  if (typeof task === "number") return task;

  const { values } = parsed;

  if (values.title === undefined || values.title === "") return reportUsage(io, "comment add needs --title <title>");

  const refused = refuseEmpty(io, FIELDS, values, false);

  if (refused !== undefined) return refused;

  const body = await readBody(io, values);

  if (typeof body === "number") return body;

  const input = fieldsFrom(values);

  if (body !== undefined) input.body = body;

  return attempt(io, target, (client) => client.addComment(task.tag, task.id, input), receiptPrinter(io), {
    prove: true,
  });
}

async function edit(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "comment edit", help: EDIT_HELP, takes: 2 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: EDIT_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const task = readTaskId(io, "comment edit", parsed.positionals[0]);

  if (typeof task === "number") return task;

  const chosen = readCommentId(io, "comment edit", parsed.positionals[1]);

  if (typeof chosen === "number") return chosen;

  const { values } = parsed;
  const clears = values.clear ?? [];
  const refused = refuseEmpty(io, FIELDS, values, true) ?? refuseClears(io, FIELDS, clears, flagsGiven(values));

  if (refused !== undefined) return refused;

  const body = await readBody(io, values);

  if (typeof body === "number") return body;

  const append = values.append === true;
  const appendFault = refuseAppend(io, append, body, clears);

  if (appendFault !== undefined) return appendFault;

  const change = fieldsFrom(values);

  applyClears(change, clears);

  const changeFault = refuseNoChange(io, "comment edit", change, body);

  if (changeFault !== undefined) return changeFault;

  if (body !== undefined) {
    if (append) {
      const stored = await readStored(io, target, task, chosen.id);

      if (typeof stored === "number") return stored;

      change.body = appended(stored, body);
    } else {
      change.body = body;
    }
  }

  return attempt(
    io,
    target,
    (client) => client.updateComment(task.tag, task.id, chosen.id, change),
    receiptPrinter(io),
    { prove: true },
  );
}

async function remove(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "comment delete", help: DELETE_HELP, takes: 2 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: DELETE_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const task = readTaskId(io, "comment delete", parsed.positionals[0]);

  if (typeof task === "number") return task;

  const chosen = readCommentId(io, "comment delete", parsed.positionals[1]);

  if (typeof chosen === "number") return chosen;

  return attempt(
    io,
    target,
    (client) => client.deleteComment(task.tag, task.id, chosen.id),
    receiptPrinter(io),
    { prove: true },
  );
}

export const comment = noun("comment", "Work with comments", [
  {
    name: "list",
    summary: "List the comments of one task",
    usage: { help: LIST_HELP, options: LIST_OPTIONS },
    run: list,
  },
  {
    name: "view",
    summary: "Print one comment of a task",
    usage: { help: VIEW_HELP, options: VIEW_OPTIONS },
    run: view,
  },
  {
    name: "add",
    summary: "Add a comment to a task",
    usage: { help: ADD_HELP, options: ADD_OPTIONS },
    run: add,
  },
  {
    name: "edit",
    summary: "Change the fields or the body of a comment",
    usage: { help: EDIT_HELP, options: EDIT_OPTIONS },
    run: edit,
  },
  {
    name: "delete",
    summary: "Remove a comment from its task",
    usage: { help: DELETE_HELP, options: DELETE_OPTIONS },
    run: remove,
  },
]);
