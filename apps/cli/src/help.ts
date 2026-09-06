import { DAEMON_RECORD_FILE, DEFAULT_DAEMON_URL } from "@tasma/protocol";
import { TREE_DIRNAME } from "./daemon/record.js";
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
 * It documents the variable beside the flag, where a command looks when neither
 * states an address, and that an address stated by hand turns start-on-demand
 * off, because this is the only documentation the CLI carries.
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
    `Without either, tasma reads ~/${TREE_DIRNAME}/${DAEMON_RECORD_FILE} and falls back to ${DEFAULT_DAEMON_URL}.`,
    "A command that needs a daemon starts one there when none answers; daemon status never does.",
    "An address given either way is never started, and daemon start and daemon stop refuse one.",
    "",
  ].join("\n");
}
