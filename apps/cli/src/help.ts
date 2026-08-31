import type { Command } from "./types.js";

/** The usage text, with the command table rendered from the registry it is given. */
export function helpText(commands: Command[]): string {
  const width = Math.max(0, ...commands.map((command) => command.name.length));
  const table = commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`);

  return [
    "tasma - local task engine",
    "",
    "Usage:",
    "  tasma <command> [options]",
    "",
    "Commands:",
    ...(table.length === 0 ? ["  (none yet)"] : table),
    "",
    "Options:",
    "  -h, --help     Print this help",
    "  -v, --version  Print the version",
    "",
  ].join("\n");
}
