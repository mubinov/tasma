// The four write verbs of the `project` noun. Each prints the tag of the project
// it wrote, one line, so `tag=$(tasma project create …)` holds the tag.
//
// Whether a tag is well formed or taken, and whether a path names a folder, is
// the daemon's to say: a second copy of either rule here could disagree with it.

import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ProjectChange, ProjectInput } from "@tasma/protocol";
import { attempt, refuseAnswer } from "../failure.js";
import { fieldsOf } from "../output.js";
import { reportUsage, wireText } from "../shell.js";
import type { Command, Io, Options, Target } from "../types.js";
import { applyClears, flagsGiven, refuseClears, refuseEmpty, refuseNoChange } from "./change.js";
import type { Fields } from "./change.js";
import { readProjectTagArgument } from "./task-id.js";
import { HELP_OPTION, readVerb, usageBlock } from "./verb.js";

const CREATE_OPTIONS = {
  path: { type: "string" },
  name: { type: "string" },
  tag: { type: "string" },
  ...HELP_OPTION,
} as const satisfies Options;

const EDIT_OPTIONS = {
  path: { type: "string" },
  name: { type: "string" },
  clear: { type: "string", multiple: true },
  ...HELP_OPTION,
} as const satisfies Options;

const RENAME_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const DELETE_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const CREATE_HELP = [
  "Usage: tasma project create --path <path> [options]",
  "",
  "      --path <path>   The folder the project stands for, required; relative to the working directory",
  "      --name <name>   The display name; the folder name otherwise",
  "      --tag <tag>     The tag; generated from the folder name otherwise",
  "  -h, --help          Print this help",
];

const EDIT_HELP = [
  "Usage: tasma project edit <tag> [options]",
  "",
  "      --path <path>     The folder the project stands for; relative to the working directory",
  "      --name <name>     The display name",
  "      --clear <field>   Remove a field: name",
  "  -h, --help            Print this help",
];

const RENAME_HELP = usageBlock("project rename <old> <new>");

const DELETE_HELP = usageBlock("project delete <tag>");

/** The flags of a create that may not be empty once `--path` is known to hold a value. */
const CREATE_FIELDS: Fields = { flags: ["name", "tag"], clearable: [] };

/** The fields an edit sets, of which only the name can be removed: every project states a path. */
const EDIT_FIELDS: Fields = { flags: ["path", "name"], clearable: ["name"] };

/**
 * The path to send, or the code the fault in it reported with.
 *
 * A relative path is joined to the working directory and nothing more: `~/` is
 * the daemon's to expand, and no link is resolved.
 */
function absolutePath(io: Io, path: string, cwd: string): string | number {
  if (isAbsolute(path) || path.startsWith("~/")) return path;

  // The entry point read no directory, which is the one thing the empty value means.
  if (cwd === "") return reportUsage(io, "the working directory could not be read; state --path as an absolute path");

  return resolve(cwd, path);
}

/**
 * How every write reports what it did: the receipt's tag, one line, and nothing
 * else on stdout. A rename answers the new tag and a delete the removed one.
 */
function receiptPrinter(io: Io): (data: unknown, url: string) => number {
  return (data, url) => {
    const { tag } = fieldsOf(data);

    if (typeof tag !== "string") return refuseAnswer(io, url, "a write receipt");

    io.stdout.write(`${wireText(tag)}\n`);
    return 0;
  };
}

async function create(args: string[], io: Io, target: Target, cwd: string): Promise<number> {
  const parsed = readVerb(io, args, { command: "project create", help: CREATE_HELP, takes: 0 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: CREATE_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const { values } = parsed;

  if (values.path === undefined || values.path === "") return reportUsage(io, "project create needs --path <path>");

  const refused = refuseEmpty(io, CREATE_FIELDS, values, false);

  if (refused !== undefined) return refused;

  const path = absolutePath(io, values.path, cwd);

  if (typeof path === "number") return path;

  const input: ProjectInput = { path };

  if (values.name !== undefined) input.name = values.name;
  if (values.tag !== undefined) input.tag = values.tag;

  return attempt(io, target, (client) => client.createProject(input), receiptPrinter(io), { prove: true });
}

async function edit(args: string[], io: Io, target: Target, cwd: string): Promise<number> {
  const parsed = readVerb(io, args, { command: "project edit", help: EDIT_HELP, takes: 1 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: EDIT_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const tag = readProjectTagArgument(io, "project edit", parsed.positionals[0]);

  if (typeof tag === "number") return tag;

  const { values } = parsed;
  const clears = values.clear ?? [];
  const refused = refuseEmpty(io, EDIT_FIELDS, values, true)
    ?? refuseClears(io, EDIT_FIELDS, clears, flagsGiven(values));

  if (refused !== undefined) return refused;

  const change: ProjectChange = {};

  if (values.path !== undefined) {
    const path = absolutePath(io, values.path, cwd);

    if (typeof path === "number") return path;

    change.path = path;
  }

  if (values.name !== undefined) change.name = values.name;

  applyClears(change, clears);

  const changeFault = refuseNoChange(io, "project edit", change, undefined);

  if (changeFault !== undefined) return changeFault;

  return attempt(io, target, (client) => client.updateProject(tag, change), receiptPrinter(io), { prove: true });
}

async function rename(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "project rename", help: RENAME_HELP, takes: 2 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: RENAME_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const old = readProjectTagArgument(io, "project rename", parsed.positionals[0]);

  if (typeof old === "number") return old;

  // Not held to one path component: it travels in the body, and the daemon's
  // tag rule is the one that judges it.
  const next = parsed.positionals[1];

  if (next === undefined || next === "") return reportUsage(io, "project rename needs a new tag");

  return attempt(io, target, (client) => client.renameProject(old, { tag: next }), receiptPrinter(io), {
    prove: true,
  });
}

async function remove(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "project delete", help: DELETE_HELP, takes: 1 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: DELETE_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const tag = readProjectTagArgument(io, "project delete", parsed.positionals[0]);

  if (typeof tag === "number") return tag;

  return attempt(io, target, (client) => client.deleteProject(tag), receiptPrinter(io), { prove: true });
}

export const WRITE_VERBS: Command[] = [
  {
    name: "create",
    summary: "Create a project for a folder",
    usage: { help: CREATE_HELP, options: CREATE_OPTIONS },
    run: create,
  },
  {
    name: "edit",
    summary: "Change the name or the path of a project",
    usage: { help: EDIT_HELP, options: EDIT_OPTIONS },
    run: edit,
  },
  {
    name: "rename",
    summary: "Change the tag of a project and of all its tasks",
    usage: { help: RENAME_HELP, options: RENAME_OPTIONS },
    run: rename,
  },
  {
    name: "delete",
    summary: "Remove a project and all its tasks",
    usage: { help: DELETE_HELP, options: DELETE_OPTIONS },
    run: remove,
  },
];
