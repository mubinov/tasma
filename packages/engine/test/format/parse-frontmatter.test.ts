import { describe, expect, it } from "vitest";
import { parseFrontmatter, parseTask, TaskParseError } from "@tasma/engine";
import { fixture } from "./fixtures.js";
import { parseFault } from "./helpers.js";

/** The region of a fixture alone: everything up to and including the closing delimiter. */
function region(name: string): string {
  const text = fixture(name);
  const closing = text.indexOf("\n---\n", 1);
  return text.slice(0, closing + "\n---\n".length);
}

describe("parseFrontmatter", () => {
  it("reads the fields the whole parse reads", () => {
    expect(parseFrontmatter(fixture("valid/example.md"))).toEqual(parseTask(fixture("valid/example.md")).task.frontmatter);
  });

  it("reads a region handed over on its own, with nothing below the closing delimiter", () => {
    expect(parseFrontmatter(region("valid/example.md")).id).toBe("PROJ-42");
  });

  it("keeps a key the format does not define out of the fields", () => {
    expect(parseFrontmatter(fixture("valid/unknown-keys.md")).id).toBe("PROJ-3");
  });

  it("reads a region whose lines end with CRLF", () => {
    expect(parseFrontmatter(region("valid/example.md").replaceAll("\n", "\r\n")).id).toBe("PROJ-42");
  });

  it("reads a file the whole parse refuses below the frontmatter", () => {
    const text = fixture("invalid/marker-unterminated.md");

    expect(() => parseTask(text)).toThrow(TaskParseError);
    expect(parseFrontmatter(text).id).toBe("PROJ-16");
  });

  it.each([
    ["invalid/frontmatter-missing.md", "frontmatter-missing"],
    ["invalid/frontmatter-unterminated.md", "frontmatter-unterminated"],
    ["invalid/frontmatter-invalid.md", "frontmatter-invalid"],
    ["invalid/frontmatter-not-mapping.md", "frontmatter-invalid"],
    ["invalid/frontmatter-key-missing.md", "frontmatter-key-missing"],
    ["invalid/frontmatter-key-type.md", "frontmatter-key-type"],
    ["invalid/frontmatter-timestamp.md", "frontmatter-key-type"],
  ])("raises on %s the code and the line the whole parse raises", (name, code) => {
    const text = fixture(name);
    const alone = parseFault(() => parseFrontmatter(text), "parseFrontmatter");
    const whole = parseFault(() => parseTask(text), "parseTask");

    expect(alone.code).toBe(code);
    expect(alone.code).toBe(whole.code);
    expect(alone.line).toBe(whole.line);
  });

  it("names the file it was given in the error it raises", () => {
    const filename = "/tmp/tree/TASM-1.md";
    const text = fixture("invalid/frontmatter-missing.md");

    const error = parseFault(() => parseFrontmatter(text, { filename }), "parseFrontmatter");

    expect(error.filename).toBe("/tmp/tree/TASM-1.md");
    expect(error.message).toContain("/tmp/tree/TASM-1.md:1:");
  });
});
