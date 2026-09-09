// The three write verbs of the `task` noun: one flag per writable field, a body
// from a flag, a file or standard input, and one way to remove a field.
//
// Every value travels as it was typed. The CLI lowercases nothing, trims nothing
// and deduplicates nothing: the engine does all three and reports each as a note,
// and a second copy of any of those rules here is one that could disagree.

import { parseArgs } from "node:util";
import type { TaskInput } from "@tasma/protocol";
import { attempt, refuseAnswer } from "../failure.js";
import { fieldsOf } from "../output.js";
import { reportUsage, wireText } from "../shell.js";
import type { Command, Io, Options, Target } from "../types.js";
import { appended, BODY_HELP, BODY_OPTIONS, readBody } from "./body.js";
import { applyClears, flagsGiven, keyOf, refuseAppend, refuseClears, refuseEmpty, refuseNoChange } from "./change.js";
import type { Fields } from "./change.js";
import { readProjectTag, readTaskId } from "./task-id.js";
import type { TaskId } from "./task-id.js";
import { HELP_OPTION, readVerb, usageBlock } from "./verb.js";

/** An integer as `--order` may be typed. A negative one needs `--order=-1`, which the parser reads as one token. */
const INTEGER = /^-?\d+$/;

/** Every flag that states a field, in the order a fault in one is reported. */
const FIELD_FLAGS = [
  "title",
  "status",
  "priority",
  "parent",
  "step",
  "workflow",
  "order",
  "label",
  "blocked-by",
] as const satisfies readonly (keyof FieldValues)[];

/** The key a field flag sets, where the flag and the field are spelled differently. */
const FIELD_KEYS: Record<string, string> = { "label": "labels", "blocked-by": "blocked_by" };

/** The fields `--clear` removes. `title` and `status` are not among them: the format requires both. */
export const CLEARABLE: readonly string[] = ["priority", "labels", "parent", "blocked_by", "step", "workflow", "order", "body"];

const FIELD_OPTIONS = {
  "status": { type: "string" },
  "priority": { type: "string" },
  "label": { type: "string", multiple: true },
  "parent": { type: "string" },
  "blocked-by": { type: "string", multiple: true },
  "step": { type: "string" },
  "workflow": { type: "string" },
  "order": { type: "string" },
} as const satisfies Options;

const CREATE_OPTIONS = {
  project: { type: "string", short: "p" },
  title: { type: "string" },
  ...FIELD_OPTIONS,
  ...BODY_OPTIONS,
  ...HELP_OPTION,
} as const satisfies Options;

const EDIT_OPTIONS = {
  title: { type: "string" },
  ...FIELD_OPTIONS,
  ...BODY_OPTIONS,
  append: { type: "boolean" },
  clear: { type: "string", multiple: true },
  ...HELP_OPTION,
} as const satisfies Options;

const DELETE_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const CREATE_HELP = [
  "Usage: tasma task create --project <tag> --title <title> [options]",
  "",
  "  -p, --project <tag>     Which project the task joins, required",
  "      --title <title>     The title, required",
  "      --status <s>        The status; the project's default otherwise",
  "      --priority <p>      The priority",
  "      --label <l>         A label; repeat it for every label",
  "      --parent <id>       The task this one sits under",
  "      --blocked-by <id>   A task that blocks this one; repeat it for every blocker",
  "      --step <s>          The workflow step",
  "      --workflow <w>      The workflow",
  "      --order <n>         The position inside the status, an integer; negative as --order=-1",
  ...BODY_HELP,
  "  -h, --help              Print this help",
];

const EDIT_HELP = [
  "Usage: tasma task edit <id> [options]",
  "",
  "      --title <title>     The title",
  "      --status <s>        The status",
  "      --priority <p>      The priority",
  "      --label <l>         A label; repeat it for every label; the list replaces the stored one",
  "      --parent <id>       The task this one sits under",
  "      --blocked-by <id>   A task that blocks this one; repeat it for every blocker; the list replaces the stored one",
  "      --step <s>          The workflow step",
  "      --workflow <w>      The workflow",
  "      --order <n>         The position inside the status, an integer; negative as --order=-1",
  ...BODY_HELP,
  "      --append            Add the body after the stored one; reads the task first",
  "      --clear <field>     Remove a field: priority, labels, parent, blocked_by, step,",
  "                          workflow, order or body; repeat it for every field",
  "  -h, --help              Print this help",
];

const DELETE_HELP = usageBlock("task delete <id>");

/** What the field flags parsed to, which both writes read the same way. */
type FieldValues = {
  "title"?: string;
  "status"?: string;
  "priority"?: string;
  "parent"?: string;
  "step"?: string;
  "workflow"?: string;
  "order"?: string;
  "label"?: string[];
  "blocked-by"?: string[];
};

/** What this family states about its own fields, which the two shared rules read. */
const FIELDS: Fields = { flags: FIELD_FLAGS, keys: FIELD_KEYS, clearable: CLEARABLE };

/** The fault where `--order` states something the format cannot hold as a position. */
function refuseOrder(io: Io, order: string | undefined): number | undefined {
  if (order === undefined || (INTEGER.test(order) && Number.isSafeInteger(Number(order)))) return undefined;

  return reportUsage(io, `not an integer: ${order}`);
}

/**
 * The change the field flags state: one key per flag typed, and none at all for
 * a flag left out, so the engine's own defaults apply to every field the caller
 * said nothing about.
 */
function fieldsFrom(values: FieldValues): TaskInput {
  const change: TaskInput = {};

  for (const flag of FIELD_FLAGS) {
    const value = values[flag];

    if (value !== undefined) change[keyOf(FIELDS, flag)] = value;
  }

  // `order` is the one field the format holds as a number, and the flag carried
  // it as text.
  if (values.order !== undefined) change.order = Number(values.order);

  return change;
}

/**
 * How every write reports what it did: the receipt's id, one line, and nothing
 * else on stdout, so `id=$(tasma task create …)` holds the id.
 *
 * No other field of the receipt is read. What the write stored is visible
 * through `task view`, and a correction the engine made arrives as a note on
 * stderr already.
 */
function receiptPrinter(io: Io): (data: unknown, url: string) => number {
  return (data, url) => {
    const { id } = fieldsOf(data);

    if (typeof id !== "string") return refuseAnswer(io, url, "a write receipt");

    io.stdout.write(`${wireText(id)}\n`);
    return 0;
  };
}

/** The body the task holds now, or the code the read reported with. */
async function readStored(io: Io, target: Target, task: TaskId): Promise<string | number> {
  let stored = "";

  const code = await attempt(
    io,
    target,
    (client) => client.readTask(task.tag, task.id, { comments: false }),
    (data, url) => {
      const answer: unknown = data;
      const { body } = fieldsOf(answer);

      if (typeof body !== "string") return refuseAnswer(io, url, "a task");

      stored = body;
      return 0;
    },
    { prove: true },
  );

  return code === 0 ? stored : code;
}

async function create(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "task create", help: CREATE_HELP, takes: 0 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: CREATE_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const { values } = parsed;
  const tag = readProjectTag(io, "task create", values.project);

  if (typeof tag === "number") return tag;
  if (values.title === undefined || values.title === "") return reportUsage(io, "task create needs --title <title>");

  const refused = refuseEmpty(io, FIELDS, values, false) ?? refuseOrder(io, values.order);

  if (refused !== undefined) return refused;

  const body = await readBody(io, values);

  if (typeof body === "number") return body;

  const input = fieldsFrom(values);

  if (body !== undefined) input.body = body;

  return attempt(io, target, (client) => client.createTask(tag, input), receiptPrinter(io), { prove: true });
}

async function edit(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "task edit", help: EDIT_HELP, takes: 1 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: EDIT_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const task = readTaskId(io, "task edit", parsed.positionals[0]);

  if (typeof task === "number") return task;

  const { values } = parsed;
  const clears = values.clear ?? [];
  const refused = refuseEmpty(io, FIELDS, values, true)
    ?? refuseOrder(io, values.order)
    ?? refuseClears(io, FIELDS, clears, flagsGiven(values));

  if (refused !== undefined) return refused;

  const body = await readBody(io, values);

  if (typeof body === "number") return body;

  const append = values.append === true;
  const appendFault = refuseAppend(io, append, body, clears);

  if (appendFault !== undefined) return appendFault;

  const change = fieldsFrom(values);

  applyClears(change, clears);

  const changeFault = refuseNoChange(io, "task edit", change, body);

  if (changeFault !== undefined) return changeFault;

  if (body !== undefined) {
    if (append) {
      const stored = await readStored(io, target, task);

      if (typeof stored === "number") return stored;

      change.body = appended(stored, body);
    } else {
      change.body = body;
    }
  }

  return attempt(io, target, (client) => client.updateTask(task.tag, task.id, change), receiptPrinter(io), {
    prove: true,
  });
}

async function remove(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "task delete", help: DELETE_HELP, takes: 1 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: DELETE_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const task = readTaskId(io, "task delete", parsed.positionals[0]);

  if (typeof task === "number") return task;

  return attempt(io, target, (client) => client.deleteTask(task.tag, task.id), receiptPrinter(io), { prove: true });
}

export const WRITE_VERBS: Command[] = [
  {
    name: "create",
    summary: "Create a task in a project",
    usage: { help: CREATE_HELP, options: CREATE_OPTIONS },
    run: create,
  },
  {
    name: "edit",
    summary: "Change the fields or the body of a task",
    usage: { help: EDIT_HELP, options: EDIT_OPTIONS },
    run: edit,
  },
  {
    name: "delete",
    summary: "Remove a task from its project",
    usage: { help: DELETE_HELP, options: DELETE_OPTIONS },
    run: remove,
  },
];
