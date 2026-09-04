import { DEFAULT_DAEMON_URL } from "@tasma/protocol";
import type { Command } from "./types.js";

/**
 * A registry as an aligned name-and-summary table, one line per entry.
 *
 * Shared, because a noun lists its verbs with the same table and none of the
 * blocks around it.
 */
export function commandTable(commands: Command[]): string[] {
  const width = Math.max(0, ...commands.map((command) => command.name.length));
  const table = commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`);

  return table.length === 0 ? ["  (none yet)"] : table;
}

/**
 * The usage text, with the command table rendered from the registry it is given.
 *
 * It documents the variable beside the flag and the address both fall back to,
 * because the address is resolved from all three and this is the only
 * documentation the CLI carries.
 */
export function helpText(commands: Command[]): string {
  return [
    "tasma - local task engine",
    "",
    "Usage:",
    "  tasma <command> [options]",
    "",
    "Commands:",
    ...commandTable(commands),
    "",
    "Options:",
    "  -h, --help          Print this help",
    "  -v, --version       Print the version",
    "      --daemon <url>  Where the daemon listens",
    "",
    "Environment:",
    "  TASMA_DAEMON_URL    Where the daemon listens, unless --daemon says otherwise",
    "",
    `Both default to ${DEFAULT_DAEMON_URL}.`,
    "",
  ].join("\n");
}
