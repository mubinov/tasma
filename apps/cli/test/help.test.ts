import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { helpText } from "../src/help.js";

describe("helpText", () => {
  it("lists every command in the registry, aligned on the longest name", () => {
    const text = helpText([
      { name: "add", summary: "Add a task", run: () => 0 },
      { name: "remove", summary: "Remove a task", run: () => 0 },
    ]);

    expect(text).toContain("  add     Add a task\n");
    expect(text).toContain("  remove  Remove a task\n");
  });

  it("says so when the registry is empty", () => {
    expect(helpText([])).toContain("none yet");
  });
});
