// The three write verbs of the `workflow` noun. Each prints the name of the
// workflow it wrote, one line.
//
// Whether a step name, an owner or a path is valid is the daemon's to say: a
// second copy of any of those rules here could disagree with it.

import { parseArgs } from "node:util";
import type { StepInput, StepOwner, WorkflowChange, WorkflowInput } from "@tasma/protocol";
import { attempt, refuseAnswer } from "../failure.js";
import { fieldsOf } from "../output.js";
import { isPathComponent, reportUsage, wireText } from "../shell.js";
import type { Command, Io, Options, Target } from "../types.js";
import { absolutePath, absolutePaths, applyClears, flagsGiven, refuseClears, refuseEmpty, refuseNoChange } from "./change.js";
import type { Fields } from "./change.js";
import { HELP_OPTION, readVerb, usageBlock } from "./verb.js";

const CREATE_OPTIONS = {
  step: { type: "string", multiple: true },
  title: { type: "string" },
  instruction: { type: "string", multiple: true },
  ...HELP_OPTION,
} as const satisfies Options;

const EDIT_OPTIONS = {
  title: { type: "string" },
  instruction: { type: "string", multiple: true },
  step: { type: "string", multiple: true },
  clear: { type: "string", multiple: true },
  ...HELP_OPTION,
} as const satisfies Options;

const DELETE_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const STEP_FLAG = "      --step <name>,<owner>,<file>";

const STEP_FORMAT = [
  "                             A step name never contains \",\"; the owner is agent or human; the file is",
  "                             relative to the working directory",
];

const CREATE_HELP = [
  "Usage: tasma workflow create <name> --step <name>,<owner>,<file> [options]",
  "",
  STEP_FLAG,
  "                             A step; repeat it for every step, in order.",
  ...STEP_FORMAT,
  "      --title <title>        The display name",
  "      --instruction <path>   A document for every step; repeat it for every one; relative to the working directory",
  "  -h, --help                 Print this help",
];

const EDIT_HELP = [
  "Usage: tasma workflow edit <name> [options]",
  "",
  STEP_FLAG,
  "                             A step; repeat it for every step, in order; the list replaces the stored one.",
  ...STEP_FORMAT,
  "      --title <title>        The display name",
  "      --instruction <path>   A document for every step; repeat it for every one; the list replaces the stored one",
  "      --clear <field>        Remove a field: title, instructions",
  "  -h, --help                 Print this help",
];

const DELETE_HELP = usageBlock("workflow delete <name>");

/** The flags that state a field, and the fields a clear removes. `steps` is never removed. */
const FIELDS: Fields = {
  flags: ["title", "instruction", "step"],
  keys: { instruction: "instructions", step: "steps" },
  clearable: ["title", "instructions"],
};

/**
 * The workflow one argument names, or the code the fault in it reported with.
 * One path component is the whole rule here; the name rule is the daemon's.
 */
function readName(io: Io, command: string, text: string | undefined): string | number {
  if (text === undefined || text === "") return reportUsage(io, `${command} needs a workflow name`);

  return isPathComponent(text) ? text : reportUsage(io, `not a workflow name: ${text}`);
}

/**
 * One `--step` value as the step it states, or the code the fault in it
 * reported with. The value is split at its first two commas, so the file may
 * hold a comma and the name and the owner never do.
 */
function readStep(io: Io, value: string, cwd: string): StepInput | number {
  const first = value.indexOf(",");
  const second = first === -1 ? -1 : value.indexOf(",", first + 1);

  if (second === -1) return reportUsage(io, `--step needs <name>,<owner>,<file>: ${value}`);

  const name = value.slice(0, first);
  const owner = value.slice(first + 1, second);
  const file = value.slice(second + 1);

  if (name === "" || owner === "" || file === "") return reportUsage(io, `--step needs <name>,<owner>,<file>: ${value}`);

  const path = absolutePath(io, "--step", file, cwd);

  if (typeof path === "number") return path;

  return { name, owner: owner as StepOwner, file: path };
}

/** Every `--step` value, in order, or the code the first fault reported with. */
function readSteps(io: Io, values: readonly string[], cwd: string): StepInput[] | number {
  const steps: StepInput[] = [];

  for (const value of values) {
    const step = readStep(io, value, cwd);

    if (typeof step === "number") return step;

    steps.push(step);
  }

  return steps;
}

/** How every write reports what it did: the workflow's name, one line, and nothing else on stdout. */
function receiptPrinter(io: Io): (data: unknown, url: string) => number {
  return (data, url) => {
    const { name } = fieldsOf(data);

    if (typeof name !== "string") return refuseAnswer(io, url, "a write receipt");

    io.stdout.write(`${wireText(name)}\n`);
    return 0;
  };
}

async function create(args: string[], io: Io, target: Target, cwd: string): Promise<number> {
  const parsed = readVerb(io, args, { command: "workflow create", help: CREATE_HELP, takes: 1 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: CREATE_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const name = readName(io, "workflow create", parsed.positionals[0]);

  if (typeof name === "number") return name;

  const { values } = parsed;
  const refused = refuseEmpty(io, FIELDS, values, false);

  if (refused !== undefined) return refused;

  if (values.step === undefined) return reportUsage(io, "workflow create needs --step <name>,<owner>,<file>");

  const steps = readSteps(io, values.step, cwd);

  if (typeof steps === "number") return steps;

  const input: WorkflowInput = { name, steps };

  if (values.title !== undefined) input.title = values.title;

  if (values.instruction !== undefined) {
    const instructions = absolutePaths(io, "--instruction", values.instruction, cwd);

    if (typeof instructions === "number") return instructions;

    input.instructions = instructions;
  }

  return attempt(io, target, (client) => client.createWorkflow(input), receiptPrinter(io), { prove: true });
}

async function edit(args: string[], io: Io, target: Target, cwd: string): Promise<number> {
  const parsed = readVerb(io, args, { command: "workflow edit", help: EDIT_HELP, takes: 1 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: EDIT_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const name = readName(io, "workflow edit", parsed.positionals[0]);

  if (typeof name === "number") return name;

  const { values } = parsed;
  const clears = values.clear ?? [];
  const refused = refuseEmpty(io, FIELDS, values, true) ?? refuseClears(io, FIELDS, clears, flagsGiven(values));

  if (refused !== undefined) return refused;

  const change: WorkflowChange = {};

  if (values.title !== undefined) change.title = values.title;

  if (values.instruction !== undefined) {
    const instructions = absolutePaths(io, "--instruction", values.instruction, cwd);

    if (typeof instructions === "number") return instructions;

    change.instructions = instructions;
  }

  if (values.step !== undefined) {
    const steps = readSteps(io, values.step, cwd);

    if (typeof steps === "number") return steps;

    change.steps = steps;
  }

  applyClears(change, clears);

  const changeFault = refuseNoChange(io, "workflow edit", change, undefined);

  if (changeFault !== undefined) return changeFault;

  return attempt(io, target, (client) => client.updateWorkflow(name, change), receiptPrinter(io), { prove: true });
}

async function remove(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "workflow delete", help: DELETE_HELP, takes: 1 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: DELETE_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const name = readName(io, "workflow delete", parsed.positionals[0]);

  if (typeof name === "number") return name;

  return attempt(io, target, (client) => client.deleteWorkflow(name), receiptPrinter(io), { prove: true });
}

export const WRITE_VERBS: Command[] = [
  {
    name: "create",
    summary: "Create a workflow",
    usage: { help: CREATE_HELP, options: CREATE_OPTIONS },
    run: create,
  },
  {
    name: "edit",
    summary: "Change the title, the instructions or the steps of a workflow",
    usage: { help: EDIT_HELP, options: EDIT_OPTIONS },
    run: edit,
  },
  {
    name: "delete",
    summary: "Remove a workflow that no project lists",
    usage: { help: DELETE_HELP, options: DELETE_OPTIONS },
    run: remove,
  },
];
