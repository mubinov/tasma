import { describe, expect, it, vi } from "vitest";
import { parseTask, TaskParseError } from "@tasma/engine";
import { fixture } from "./fixtures.js";

// The YAML library reports a fault in the syntax through `errors` and throws
// only on the limits it sets for itself, which no input reaches on the version
// this package resolves. The reader still converts such a throw, because the
// range in the catalog admits other versions and a caller matches on the code.
vi.mock("yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yaml")>();
  return {
    ...actual,
    parseDocument: (source: string) => {
      if (source.includes("explode")) throw new Error("the YAML library gave up");
      return actual.parseDocument(source);
    },
  };
});

describe("a throw from the YAML library", () => {
  it("comes back as a read error on the frontmatter", () => {
    const text = fixture("valid/minimal.md").replace("title: Minimal", "title: explode");

    try {
      parseTask(text);
      throw new Error("parseTask did not throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskParseError);
      expect((error as TaskParseError).code).toBe("frontmatter-invalid");
      expect((error as TaskParseError).message).toBe("line 2: Error: the YAML library gave up");
    }
  });
});
