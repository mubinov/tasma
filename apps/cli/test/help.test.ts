import { DEFAULT_DAEMON_URL } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { commandTable, helpText } from "../src/help.js";
import { GLOBAL_OPTIONS } from "../src/run.js";
import type { Command } from "../src/types.js";

const COMMANDS: Command[] = [
  { name: "add", summary: "Add a task", run: () => Promise.resolve(0) },
  { name: "remove", summary: "Remove a task", run: () => Promise.resolve(0) },
];

describe("commandTable", () => {
  it("renders one line per command, aligned on the longest name", () => {
    expect(commandTable(COMMANDS)).toEqual(["  add     Add a task", "  remove  Remove a task"]);
  });

  it("says so when the registry is empty", () => {
    expect(commandTable([])).toEqual(["  (none yet)"]);
  });
});

describe("helpText", () => {
  it("lists every command in the registry", () => {
    const text = helpText(COMMANDS);

    expect(text).toContain("  add     Add a task\n");
    expect(text).toContain("  remove  Remove a task\n");
  });

  it("says so when the registry is empty", () => {
    expect(helpText([])).toContain("none yet");
  });

  // Read off the parser's own table, against the Options block alone: the
  // environment line below names --daemon too, so matching the whole text would
  // leave the option's own row free to disappear.
  it("documents every global option the parser accepts", () => {
    const text = helpText(COMMANDS);
    const options = text.slice(text.indexOf("Options:"), text.indexOf("Environment:"));

    for (const [name, option] of Object.entries(GLOBAL_OPTIONS)) {
      expect(options).toContain(option.type === "string" ? `--${name} <` : `-${option.short}, --${name}`);
    }
  });

  // The variable is held to the same rule as the flag, and this text is the
  // only documentation the CLI carries.
  it("documents the variable resolved beside the flag, and the address both fall back to", () => {
    const text = helpText(COMMANDS);

    expect(text).toContain("TASMA_DAEMON_URL");
    expect(text).toContain(DEFAULT_DAEMON_URL);
  });
});
