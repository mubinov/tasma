// The `workflow` noun. It reads the workflows of a tree and writes none of them.
//
// Neither verb names a project: one definition is shared by the whole tree, so
// there is nothing to resolve from the working directory.

import { parseArgs } from "node:util";
import { attempt, refuseAnswer } from "../failure.js";
import { cell, fieldsOf, table } from "../output.js";
import { isPathComponent, noun, reportUsage } from "../shell.js";
import type { Io, Options, Target } from "../types.js";
import { HELP_OPTION, readVerb, usageBlock } from "./verb.js";

const LIST_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const SHOW_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const LIST_HELP = usageBlock("workflow list");

const SHOW_HELP = usageBlock("workflow show <name>");

/** What the second block carries in its first column, on every row it holds. */
const INSTRUCTIONS = "instructions";

/**
 * The workflow one argument names, or the code the fault in it reported with.
 *
 * One path component is the whole rule: the name becomes a path parameter, and
 * `buildPath` throws on a value a URL would resolve away, outside `attempt`'s
 * reach. The format's own name rule lives in the engine, and a second copy here
 * could disagree with it, so a name that passes this and names no workflow is
 * refused by the daemon.
 *
 * An empty value is no value: an unset shell variable names no workflow rather
 * than one called "".
 */
function readWorkflowName(io: Io, text: string | undefined): string | number {
  if (text === undefined || text === "") return reportUsage(io, "workflow show needs a workflow name");

  return isPathComponent(text) ? text : reportUsage(io, `not a workflow name: ${text}`);
}

/** Whether an answer is a workflow, tested over the two lists its blocks are built from. */
function isWorkflow(answer: unknown): answer is { steps: unknown[]; instructions: unknown[] } {
  const { steps, instructions } = fieldsOf(answer);

  return Array.isArray(steps) && Array.isArray(instructions);
}

/** One step as a row: what it is called, who performs it, and the file stating its rules. */
function stepRow(entry: unknown): string[] {
  const { name, owner, file } = fieldsOf(entry);

  return [cell(name), cell(owner), cell(file)];
}

/**
 * One workflow as three blocks: what it calls itself, the documents that apply
 * to every step, and the steps themselves.
 *
 * Each block is padded over its own rows, so the columns of one do not line up
 * with another's. A block that holds no row is dropped before the join rather
 * than after: joining an empty block would leave the blank line that separates
 * it from its neighbour.
 */
function workflowText(answer: { steps: unknown[]; instructions: unknown[] }): string {
  const { name, title } = fieldsOf(answer);

  const blocks = [
    table([[cell(name), cell(title)]]),
    table(answer.instructions.map((path) => [INSTRUCTIONS, cell(path)])),
    table(answer.steps.map(stepRow)),
  ];

  return blocks.filter((block) => block !== "").join("\n");
}

async function list(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "workflow list", help: LIST_HELP, takes: 0 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: LIST_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  return attempt(io, target, (client) => client.listWorkflows(), (data, url) => {
    const answer: unknown = data;

    if (!Array.isArray(answer)) return refuseAnswer(io, url, "a workflow listing");

    io.stdout.write(table(answer.map((entry) => [cell(entry)])));
    return 0;
  });
}

async function show(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "workflow show", help: SHOW_HELP, takes: 1 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: SHOW_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const name = readWorkflowName(io, parsed.positionals[0]);

  if (typeof name === "number") return name;

  return attempt(io, target, (client) => client.readWorkflow(name), (data, url) => {
    const answer: unknown = data;

    if (!isWorkflow(answer)) return refuseAnswer(io, url, "a workflow");

    io.stdout.write(workflowText(answer));
    return 0;
  });
}

export const workflow = noun("workflow", "Work with workflows", [
  {
    name: "list",
    summary: "List the workflows in the data directory",
    usage: { help: LIST_HELP, options: LIST_OPTIONS },
    run: list,
  },
  {
    name: "show",
    summary: "Print one workflow, its steps and its documents",
    usage: { help: SHOW_HELP, options: SHOW_OPTIONS },
    run: show,
  },
]);
