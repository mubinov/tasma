import { parseArgs } from "node:util";
import manifest from "../package.json" with { type: "json" };
import { comment } from "./commands/comment.js";
import { daemon } from "./commands/daemon.js";
import { project } from "./commands/project.js";
import { task } from "./commands/task.js";
import { resolveTarget } from "./daemon/transport.js";
import { helpText } from "./help.js";
import { dispatch, errorText, readArgs, reportUsage } from "./shell.js";
import type { Command, Io, Target } from "./types.js";

/**
 * Every command the CLI answers to, and through each noun's own verbs every verb
 * as well.
 *
 * Read by all three consumers: help renders it, dispatch looks up in it and the
 * usage blocks are checked against it, so a command added here needs no other
 * change.
 */
export const COMMANDS: Command[] = [comment, daemon, project, task];

/** argv split at the first token that is neither a global flag nor the value of one. */
export type Invocation = { globals: string[]; name?: string; args: string[] };

/**
 * Every global option, as the one description the parser, the split below and
 * the help text are all read against.
 *
 * A global taking a value carries no short form, by the type: the walk skips
 * such a value by the long spelling alone, and `-d <url>` would leave the URL to
 * become the command name.
 */
export const GLOBAL_OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  daemon: { type: "string" },
} as const satisfies Record<string, { type: "boolean"; short?: string } | { type: "string"; short?: never }>;

/**
 * The globals that consume the token after them, so the walk does not read a
 * value as the command.
 *
 * Derived rather than written: a second list would let a global be declared as
 * taking a value without being added to it, and its value would then silently
 * become the command name.
 */
const VALUED_GLOBALS = new Set(
  Object.entries(GLOBAL_OPTIONS)
    .filter(([, option]) => option.type === "string")
    .map(([name]) => `--${name}`),
);

/**
 * The global flags, the command name and the command's own arguments.
 *
 * The command token is found before parsing, so a command's own flags never
 * reach the global parser: `tasma create --title x` is not an unknown option.
 */
export function splitInvocation(argv: string[]): Invocation {
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];
    if (!arg?.startsWith("-")) break;
    index += VALUED_GLOBALS.has(arg) ? 2 : 1;
  }

  // A trailing valued global walks past the end, leaving no command name, and
  // parseArgs reports the missing argument.
  if (index >= argv.length) {
    return { globals: argv, args: [] };
  }

  return { globals: argv.slice(0, index), name: argv[index], args: argv.slice(index + 1) };
}

/**
 * The whole CLI: arguments in, exit code out, every byte through `io`, every
 * variable through `env` and the working directory through `cwd`.
 *
 * Reads no global and touches no file, so the entry point is the only place
 * that knows a process exists.
 */
export async function run(
  argv: string[],
  io: Io,
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<number> {
  const invocation = splitInvocation(argv);

  // Positionals are not enabled: the split above has already removed them.
  const parsed = readArgs(io, invocation.globals, () =>
    parseArgs({ args: invocation.globals, strict: true, options: GLOBAL_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const { values } = parsed;

  if (values.version === true) {
    io.stdout.write(`tasma ${manifest.version}\n`);
    return 0;
  }

  // A bare `tasma`, which carries no command name, is a request for
  // orientation rather than an error.
  if (values.help === true || invocation.name === undefined) {
    io.stdout.write(helpText(COMMANDS));
    return 0;
  }

  let target: Target;

  // Resolved once and handed down. A refused value is a fault in the
  // invocation, so it reports through the same usage path as a bad flag.
  try {
    target = resolveTarget(values.daemon, env);
  } catch (error) {
    return reportUsage(io, errorText(error));
  }

  return dispatch(COMMANDS, "", invocation.name, invocation.args, io, target, cwd);
}
