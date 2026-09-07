import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { COMMANDS } from "../../src/run.js";
import type { Command, Usage } from "../../src/types.js";

/** Every verb the registry holds, under the invocation that reaches it. */
const VERBS: { invocation: string; verb: Command }[] = COMMANDS.flatMap((noun) =>
  (noun.verbs ?? []).map((verb) => ({ invocation: `${noun.name} ${verb.name}`, verb })));

/** How a usage block names one option: the long spelling, the short form where it has one. */
function spelling(name: string, option: Usage["options"][string]): string {
  const spelled = option.short === undefined ? `--${name}` : `-${option.short}, --${name}`;

  return option.type === "string" ? `${spelled} <` : spelled;
}

describe("the usage block of every verb", () => {
  // The registry is the one list of verbs, so a verb added to a noun and left
  // undocumented is caught here rather than shipping with every test green.
  it("is carried by every verb the registry holds", () => {
    expect(VERBS.length).toBeGreaterThan(0);

    for (const { invocation, verb } of VERBS) {
      expect(verb.usage, `tasma ${invocation}`).toBeDefined();
    }
  });

  // Read off the parser's own table, the rule the globals stand under: a flag
  // added to a verb and left out of its block is one the CLI accepts and
  // documents nowhere.
  it("documents every option that verb's parser accepts", () => {
    for (const { invocation, verb } of VERBS) {
      // The option rows alone: the synopsis above them names a required flag of
      // its own, and matching the whole block would leave that option's row free
      // to disappear.
      const rows = (verb.usage?.help ?? []).slice(1).join("\n");

      for (const [name, option] of Object.entries(verb.usage?.options ?? {})) {
        expect(rows, `tasma ${invocation} documents --${name}`).toContain(spelling(name, option));
      }
    }
  });

  it("opens with the invocation it documents", () => {
    for (const { invocation, verb } of VERBS) {
      expect(verb.usage?.help[0], invocation).toContain(`Usage: tasma ${invocation}`);
    }
  });
});
