import { parseArgs } from "node:util";
import manifest from "../package.json" with { type: "json" };
import { helpText } from "./help.js";
import type { Command, Io } from "./types.js";

/**
 * Every command the CLI answers to.
 *
 * Empty on purpose, and read by both consumers already: help renders it and
 * dispatch looks up in it, so a command name added here needs no other change.
 */
const COMMANDS: Command[] = [];

const HINT = "Run 'tasma --help' for usage.\n";

// Characters a reader of this output acts on rather than prints: a terminal
// takes an escape sequence as a command to clear the screen, retitle the window
// or overwrite the line so a failure reads as success, and a program splitting
// the output into lines takes a Unicode line separator as a line of its own.
// Either way an argument can forge output the CLI never wrote.
const OPAQUE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** argv split at the first token that is not a flag. */
export type Invocation = { globals: string[]; name?: string; args: string[] };

/** Text safe to print, with every character a reader would act on shown as its escape. */
export function printable(text: string): string {
  return text.replace(OPAQUE, (match) =>
    // By code unit rather than code point, so an astral character keeps both halves.
    match
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
}

/**
 * The global flags, the command name and the command's own arguments.
 *
 * The command token is found before parsing, so a command's own flags never
 * reach the global parser: `tasma create --title x` is not an unknown option.
 */
export function splitInvocation(argv: string[]): Invocation {
  const commandIndex = argv.findIndex((arg) => !arg.startsWith("-"));

  if (commandIndex === -1) {
    return { globals: argv, args: [] };
  }

  return { globals: argv.slice(0, commandIndex), name: argv[commandIndex], args: argv.slice(commandIndex + 1) };
}

/** The text of a throw, which the language types as `unknown` however narrow the thrower is. */
export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "invalid arguments";
}

/** The one path that prints argv-derived text, so it is escaped in exactly one place. */
function reportUsage(io: Io, detail: string): number {
  io.stderr.write(`tasma: ${printable(detail)}\n${HINT}`);
  return 2;
}

/** Runs the named command, or reports that no command claims the name. */
export function dispatch(commands: Command[], name: string, args: string[], io: Io): number {
  const command = commands.find((candidate) => candidate.name === name);

  if (command === undefined) {
    return reportUsage(io, `unknown command: ${name}`);
  }

  return command.run(args, io);
}

/**
 * The whole CLI: arguments in, exit code out, every byte through `io`.
 *
 * Reads no global and touches no file, so the entry point is the only place
 * that knows a process exists.
 */
export function run(argv: string[], io: Io): number {
  const invocation = splitInvocation(argv);

  let values;

  try {
    // Positionals are not enabled: the split above has already removed them.
    values = parseArgs({
      args: invocation.globals,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    }).values;
  } catch (error) {
    return reportUsage(io, errorText(error));
  }

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

  return dispatch(COMMANDS, invocation.name, invocation.args, io);
}
