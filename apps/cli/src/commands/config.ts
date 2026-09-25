// The `config` noun: the view and the edit of the user's configuration file,
// `~/.tasma/config.yml`.
//
// Whether a status, a path or a workflow is acceptable is the daemon's to say:
// it checks the result against every project before it writes.

import { parseArgs } from "node:util";
import type { UserConfig, UserConfigChange } from "@tasma/protocol";
import { attempt, refuseAnswer } from "../failure.js";
import { cell, fieldsOf, keyRows, table } from "../output.js";
import { noun, wireText } from "../shell.js";
import type { Io, Options, Target } from "../types.js";
import { absolutePath, applyClears, flagsGiven, keyOf, refuseClears, refuseEmpty, refuseNoChange } from "./change.js";
import type { Fields } from "./change.js";
import { HELP_OPTION, readVerb, usageBlock } from "./verb.js";

const VIEW_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const EDIT_OPTIONS = {
  "status": { type: "string", multiple: true },
  "default-status": { type: "string" },
  "final-status": { type: "string", multiple: true },
  "priority": { type: "string", multiple: true },
  "workflows-path": { type: "string" },
  "clear": { type: "string", multiple: true },
  ...HELP_OPTION,
} as const satisfies Options;

const VIEW_HELP = usageBlock("config view");

const EDIT_HELP = [
  "Usage: tasma config edit [options]",
  "",
  "      --status <s>             A status; repeat it for every status; the list replaces the stored one",
  "      --default-status <s>     The status a new task takes",
  "      --final-status <s>       A status that closes a task; repeat it for every one; the list replaces the stored one",
  "      --priority <p>           A priority; repeat it for every priority; the list replaces the stored one",
  "      --workflows-path <path>  The workflows directory; relative to the working directory",
  "      --clear <field>          Remove a field: statuses, default_status, final_statuses, priorities, workflows_path",
  "  -h, --help                   Print this help",
];

/** The keys `view` prints, in the order of the file. */
const KEYS = [
  "statuses",
  "default_status",
  "final_statuses",
  "priorities",
  "workflows_path",
] as const satisfies readonly (keyof UserConfig)[];

/** What `view` marks a key with whose value the file does not set. */
const BUILT_IN_MARK = "(built-in default)";

/** The key of the user's `config.yml` each flag of an edit sets. */
const FIELD_KEYS: Record<string, string> = {
  "status": "statuses",
  "default-status": "default_status",
  "final-status": "final_statuses",
  "priority": "priorities",
  "workflows-path": "workflows_path",
};

/** The fields an edit sets, every one of which can be removed. */
const EDIT_FIELDS: Fields = {
  flags: Object.keys(FIELD_KEYS),
  keys: FIELD_KEYS,
  clearable: Object.values(FIELD_KEYS),
};

/** The flags of an edit whose value the daemon takes as typed; `--workflows-path` is made absolute first. */
const SENT_AS_GIVEN = ["status", "default-status", "final-status", "priority"] as const;

/** Whether an answer is the user's configuration, tested over every field `view` reads. */
function isUserConfig(answer: unknown): answer is Record<string, unknown> & { path: string } {
  const fields = fieldsOf(answer);

  return typeof fields.path === "string" && KEYS.every((key) => typeof fieldsOf(fields[key]).set === "boolean");
}

async function view(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "config view", help: VIEW_HELP, takes: 0 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: VIEW_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  return attempt(io, target, (client) => client.readUserConfig(), (data, url) => {
    const answer: unknown = data;

    if (!isUserConfig(answer)) return refuseAnswer(io, url, "a configuration");

    const rows = [
      ["file", cell(answer.path)],
      ...KEYS.flatMap((key) => {
        const { value, set } = fieldsOf(answer[key]);

        return keyRows(key, value, set === true ? undefined : BUILT_IN_MARK);
      }),
    ];

    io.stdout.write(table(rows));
    return 0;
  });
}

async function edit(args: string[], io: Io, target: Target, cwd: string): Promise<number> {
  const parsed = readVerb(io, args, { command: "config edit", help: EDIT_HELP, takes: 0 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: EDIT_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const { values } = parsed;
  const clears = values.clear ?? [];
  const refused = refuseEmpty(io, EDIT_FIELDS, values, true)
    ?? refuseClears(io, EDIT_FIELDS, clears, flagsGiven(values));

  if (refused !== undefined) return refused;

  const change: UserConfigChange = {};

  for (const flag of SENT_AS_GIVEN) {
    const value = values[flag];

    if (value !== undefined) (change as Record<string, unknown>)[keyOf(EDIT_FIELDS, flag)] = value;
  }

  if (values["workflows-path"] !== undefined) {
    const path = absolutePath(io, "--workflows-path", values["workflows-path"], cwd);

    if (typeof path === "number") return path;

    change.workflows_path = path;
  }

  applyClears(change, clears);

  const changeFault = refuseNoChange(io, "config edit", change, undefined);

  if (changeFault !== undefined) return changeFault;

  return attempt(io, target, (client) => client.updateUserConfig(change), (data, url) => {
    const { path } = fieldsOf(data);

    if (typeof path !== "string") return refuseAnswer(io, url, "a configuration");

    io.stdout.write(`${wireText(path)}\n`);
    return 0;
  }, { prove: true });
}

export const config = noun("config", "Work with the main configuration", [
  {
    name: "view",
    summary: "Print the main configuration file",
    usage: { help: VIEW_HELP, options: VIEW_OPTIONS },
    run: view,
  },
  {
    name: "edit",
    summary: "Change the main configuration file",
    usage: { help: EDIT_HELP, options: EDIT_OPTIONS },
    run: edit,
  },
]);
