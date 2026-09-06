import { printable } from "@tasma/protocol";
import { commandTable } from "./help.js";
import type { Command, Io } from "./types.js";

const HINT = "Run 'tasma --help' for usage.\n";

/**
 * A value an answer carried, as text safe to print.
 *
 * A field is whatever answered the port however the type reads, and rendering
 * one has two ways to throw inside the very code reporting the bad answer:
 * `JSON.parse` builds an own `toString` out of a wire field of that name, which
 * throws on coercion, and it nests iteratively while `JSON.stringify` recurses,
 * so it accepts a depth that overflows the stack rendering it. A value that
 * defeats both renderings is named as one rather than printed.
 */
export function wireText(value: unknown): string {
  try {
    return printable(typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined"));
  } catch {
    return "[unprintable]";
  }
}

/** The text of a throw, which the language types as `unknown` however narrow the thrower is. */
export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "invalid arguments";
}

/**
 * Writes a usage failure, then the hint pointing at help.
 *
 * A detail is one `tasma: ` line whatever it carries, so a break inside text
 * quoted back from argv or the environment is escaped rather than opening a
 * line of its own — a caller cannot leak a forged diagnostic by forgetting to
 * escape. Several lines are written only where the caller names the parts
 * itself: `parseArgs` answers an option that takes a value with three
 * sentences, which run together into one unreadable line.
 */
export function reportUsage(io: Io, detail: string | string[]): number {
  const parts = typeof detail === "string" ? [detail] : detail;
  const lines = parts.map((part) => `tasma: ${printable(part)}\n`);

  io.stderr.write(`${lines.join("")}${HINT}`);
  return 2;
}

/**
 * Runs the named command, or reports that no command claims the name.
 *
 * `parent` is the noun this table sits under, empty at the top level, so an
 * unknown verb is reported as the whole invocation rather than as a top-level
 * command that was never typed.
 */
export async function dispatch(
  commands: Command[],
  parent: string,
  name: string,
  args: string[],
  io: Io,
  daemonUrl: string,
): Promise<number> {
  const command = commands.find((candidate) => candidate.name === name);

  if (command === undefined) {
    return reportUsage(io, `unknown command: ${parent === "" ? name : `${parent} ${name}`}`);
  }

  return command.run(args, io, daemonUrl);
}

/**
 * A noun and the verbs under it, as one command: a verb has the same shape as a
 * command, so one dispatcher serves both levels.
 *
 * A bare noun, `--help` and `-h` all list the verbs — the three spellings of a
 * request for orientation the top level already answers, one level down.
 */
export function noun(name: string, summary: string, verbs: Command[]): Command {
  return {
    name,
    summary,
    run: (args, io, daemonUrl) => {
      const [verb, ...rest] = args;

      if (verb === undefined || verb === "--help" || verb === "-h") {
        io.stdout.write(`${commandTable(verbs).join("\n")}\n`);
        return Promise.resolve(0);
      }

      return dispatch(verbs, name, verb, rest, io, daemonUrl);
    },
  };
}
