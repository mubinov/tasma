// The frame every verb below a noun shares: how its arguments are read, how a
// request for its usage is answered, and how an argument it does not take is
// refused.
//
// The parse itself stays with the verb, so each keeps the types its own option
// table gives it and a flag is declared where it is used.

import { readArgs, reportUsage } from "../shell.js";
import type { Io } from "../types.js";

/**
 * The flag every verb answers its usage to, declared once so the short form has
 * a single home and no table can spell it differently.
 */
export const HELP_OPTION = { help: { type: "boolean", short: "h" } } as const;

/** How a command names the number of arguments it takes, indexed by that number. */
const TAKES = ["no arguments", "one argument", "two arguments"] as const;

/** What every verb's parser answers, whatever its own table adds to it. */
type Parsed = { values: { help?: boolean | undefined }; positionals: string[] };

/** How a verb is read: the name a refusal quotes, the block `--help` prints, and how many arguments it takes. */
type Frame = { command: string; help: string[]; takes: 0 | 1 | 2 };

/**
 * The usage block of a verb whose only flag is the one that prints it.
 *
 * The whole invocation is named, the arguments included, so a block states what
 * the verb takes as well as what it accepts.
 */
export function usageBlock(invocation: string): string[] {
  return [`Usage: tasma ${invocation}`, "", "  -h, --help  Print this help"];
}

/**
 * Answers a request for a verb's usage, and says whether it did.
 *
 * It is answered before the verb checks anything of its own, so a verb missing a
 * flag it requires still prints the block naming that flag.
 */
function wroteHelp(io: Io, help: string[], asked: boolean | undefined): boolean {
  if (asked !== true) return false;

  io.stdout.write(`${help.join("\n")}\n`);
  return true;
}

/**
 * The fault where a command was handed more arguments than it takes, or nothing
 * where it was not.
 *
 * A verb is handed every token after it, so an argument meant for the top level
 * lands here; ignored rather than refused it would leave the caller reading an
 * answer to something other than what was typed.
 */
function refuseExtra(io: Io, command: string, positionals: string[], takes: 0 | 1 | 2): number | undefined {
  const extra = positionals[takes];

  return extra === undefined ? undefined : reportUsage(io, `${command} takes ${TAKES[takes]}: ${extra}`);
}

/**
 * A verb's arguments, or the code the fault in them reported with.
 *
 * The order is the invariant this holds: the usage block is written before an
 * argument is refused, so `tasma task view x y --help` prints the block rather
 * than refusing the second argument.
 */
export function readVerb<T extends Parsed>(io: Io, args: string[], frame: Frame, parse: () => T): T | number {
  const parsed = readArgs(io, args, parse);

  if (typeof parsed === "number") return parsed;
  if (wroteHelp(io, frame.help, parsed.values.help)) return 0;

  return refuseExtra(io, frame.command, parsed.positionals, frame.takes) ?? parsed;
}
