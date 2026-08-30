import { describe, expect, it } from "vitest";
import { parseTask, TaskFormatError, TaskParseError } from "@tasma/engine";
import { fixture } from "./fixtures.js";
import { parseFault } from "./helpers.js";
import { withoutSnapshot } from "./snapshot.js";

/** The `TaskParseError` `parseTask` must throw for this text. */
function parseError(text: string, filename?: string): TaskParseError {
  return parseFault(() => parseTask(text, { filename }), "parseTask");
}

describe("parseTask", () => {
  it("reads the reference example", () => {
    const { task, diagnostics } = parseTask(fixture("valid/example.md"));

    expect(diagnostics).toEqual([]);
    expect(task.frontmatter).toEqual({
      id: "PROJ-42",
      title: "Import the address book from a CSV file",
      status: "In Progress",
      workflow: "delivery",
      step: "build",
      priority: "high",
      order: 4200,
      labels: ["import"],
      parent: "PROJ-30",
      created: "2024-05-06T09:15:00+02:00",
      updated: "2024-05-08T16:30:00+02:00",
      next_comment_id: 3,
      custom: { workflow: { attempts: 2 } },
    });
    expect(task.body).toBe(
      "\n# Goal\n\nThis is the body: free markdown. It runs from the end of the\n"
      + "frontmatter to the first comment marker. The format defines no\nsections inside it.\n\n",
    );
    expect(task.comments.map(withoutSnapshot)).toEqual([
      {
        id: 1,
        title: "Separator agreed",
        created: "2024-05-07T10:05:00+02:00",
        author: "alex",
        body: "\nBody of comment 1: free markdown. It runs to the next marker.\n\n",
        lines: { start: 25, end: 28 },
      },
      {
        id: 2,
        title: "Rows with an empty column",
        created: "2024-05-08T14:20:00+02:00",
        updated: "2024-05-08T14:52:00+02:00",
        author: "alex",
        collapsed: true,
        custom: { workflow: { attempt: 1, outcome: "retry" } },
        body: "\nBody of comment 2. The last comment runs to the end of the file.\n",
        lines: { start: 29, end: 40 },
      },
    ]);
  });

  it("reads a file that carries the required keys only", () => {
    const { task, diagnostics } = parseTask(fixture("valid/minimal.md"));

    expect(diagnostics).toEqual([]);
    expect(task.frontmatter).toEqual({
      id: "PROJ-1",
      title: "Minimal",
      status: "To Do",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      next_comment_id: 1,
    });
    expect(task.body).toBe("");
    expect(task.comments).toEqual([]);
  });

  it("reads a file with a body and no comments", () => {
    const { task } = parseTask(fixture("valid/no-comments.md"));

    expect(task.frontmatter.workflow).toBe("intake");
    expect(task.frontmatter.labels).toEqual(["design", "research"]);
    expect(task.comments).toEqual([]);
    expect(task.body.endsWith("the end of the file.\n")).toBe(true);
  });

  it("keeps unknown keys out of the typed fields", () => {
    const { task } = parseTask(fixture("valid/unknown-keys.md"));

    expect(Object.keys(task.frontmatter)).not.toContain("external_ref");
    expect(Object.keys(withoutSnapshot(task.comments[0]!))).not.toContain("reactions");
  });

  it("treats marker-shaped lines inside a fence as text", () => {
    const { task, diagnostics } = parseTask(fixture("valid/self-referential.md"));

    expect(diagnostics).toEqual([]);
    expect(task.comments).toHaveLength(1);
    expect(task.comments[0]!.title).toBe("Only this marker is real");
  });

  it("tracks fences through the body and the comment bodies", () => {
    const { task, diagnostics } = parseTask(fixture("valid/fences.md"));

    expect(diagnostics).toEqual([]);
    expect(task.comments).toHaveLength(1);
    expect(task.comments[0]!.id).toBe(1);
  });

  it("accepts a marker as the last line of a file with no final newline", () => {
    const text = fixture("valid/minimal.md") + '\n<!-- task:comment {id: 1, title: "t", created: "2026-01-01T00:00:00Z"} -->';
    const { task } = parseTask(text);

    expect(task.comments).toHaveLength(1);
    expect(task.comments[0]!.body).toBe("");
    expect(task.comments[0]!.lines).toEqual({ start: 10, end: 10 });
  });

  describe("read errors", () => {
    it.each([
      ["invalid/frontmatter-missing.md", "frontmatter-missing", 1],
      ["invalid/frontmatter-unterminated.md", "frontmatter-unterminated", 1],
      ["invalid/frontmatter-invalid.md", "frontmatter-invalid", 3],
      ["invalid/frontmatter-not-mapping.md", "frontmatter-invalid", 2],
      ["invalid/frontmatter-key-missing.md", "frontmatter-key-missing", 1],
      ["invalid/frontmatter-key-type.md", "frontmatter-key-type", 7],
      ["invalid/frontmatter-timestamp.md", "frontmatter-key-type", 5],
      ["invalid/marker-unterminated.md", "marker-unterminated", 12],
      ["invalid/marker-invalid.md", "marker-invalid", 12],
      ["invalid/marker-key-missing.md", "marker-key-missing", 12],
      ["invalid/marker-key-type.md", "marker-key-type", 12],
      ["invalid/comment-id-duplicate.md", "comment-id-duplicate", 16],
    ])("rejects %s", (name, code, line) => {
      const error = parseError(fixture(name));

      expect(error.code).toBe(code);
      expect(error.line).toBe(line);
    });

    it("rejects an empty file", () => {
      expect(parseError("").code).toBe("frontmatter-missing");
    });

    it.each([
      ["a day the month does not have", '"2026-02-30T00:00:00Z"'],
      ["a time out of range", '"2026-01-01T25:00:00Z"'],
      ["an offset out of range", '"2026-01-01T00:00:00+25:00"'],
      ["a value that is not a string", "20260101"],
    ])("rejects a timestamp with %s", (_case, written) => {
      const text = fixture("valid/minimal.md").replace('"2026-01-01T00:00:00Z"', written);

      expect(parseError(text).code).toBe("frontmatter-key-type");
    });

    it("rejects an optional frontmatter key of the wrong type", () => {
      const text = fixture("valid/minimal.md").replace("next_comment_id: 1", "order: soon\nnext_comment_id: 1");
      const error = parseError(text);

      expect(error.code).toBe("frontmatter-key-type");
      expect(error.line).toBe(7);
    });

    it("rejects an optional marker key of the wrong type", () => {
      const text = `${fixture("valid/minimal.md")}
<!-- task:comment {id: 1, title: "t", created: "2026-01-01T00:00:00Z", collapsed: yes} -->
`;
      const error = parseError(text);

      expect(error.code).toBe("marker-key-type");
      expect(error.message).toBe('line 10: marker key "collapsed" must be a boolean');
    });

    it("rejects a block marker interrupted by the next marker", () => {
      const text = `${fixture("valid/minimal.md")}
<!-- task:comment
id: 1
<!-- task:comment {id: 2, title: "t", created: "2026-01-01T00:00:00Z"} -->
`;
      const error = parseError(text);

      expect(error.code).toBe("marker-unterminated");
      expect(error.line).toBe(10);
    });

    it("rejects text after the closing arrow of a flow marker", () => {
      const text = `${fixture("valid/minimal.md")}
<!-- task:comment {id: 1, title: "t", created: "2026-01-01T00:00:00Z"} --> trailing
`;
      expect(parseError(text).code).toBe("marker-invalid");
    });

    it("rejects text on the opening line of a block marker", () => {
      const text = `${fixture("valid/minimal.md")}
<!-- task:comment id: 1
title: "t"
-->
`;
      expect(parseError(text).code).toBe("marker-invalid");
    });

    it("rejects invalid YAML inside a marker and names the line of the fault", () => {
      const text = `${fixture("valid/minimal.md")}
<!-- task:comment
id: 1
id: 2
-->
`;
      const error = parseError(text);

      expect(error.code).toBe("marker-invalid");
      expect(error.line).toBe(12);
    });

    it("names the file and the line in the message", () => {
      expect(parseError(fixture("invalid/frontmatter-key-type.md"), "proj-14.md").message).toBe(
        'proj-14.md:7: frontmatter key "next_comment_id" must be an integer',
      );
    });

    it("names the line alone when no filename is given", () => {
      expect(parseError(fixture("invalid/frontmatter-key-type.md")).message).toBe(
        'line 7: frontmatter key "next_comment_id" must be an integer',
      );
    });

    it("carries the filename on the error", () => {
      expect(parseError(fixture("invalid/frontmatter-missing.md"), "a.md").filename).toBe("a.md");
    });

    it("is catchable as a format error and keeps the YAML fault as its cause", () => {
      const error = parseError(fixture("invalid/frontmatter-invalid.md"));

      expect(error).toBeInstanceOf(TaskFormatError);
      expect(error.cause).toBeInstanceOf(Error);
    });

    it("rejects a block marker that carries the closing arrow inside a value", () => {
      const text = `${fixture("valid/minimal.md")}
<!-- task:comment
id: 1
title: "a --> b"
created: "2026-01-01T00:00:00Z"
-->
`;
      const error = parseError(text);

      expect(error.code).toBe("marker-invalid");
      expect(error.line).toBe(12);
    });

    it("rejects a frontmatter key whose YAML alias defeats the position lookup", () => {
      const text = fixture("valid/minimal.md").replace(
        "next_comment_id: 1",
        "x: &a next_comment_id\n*a : nope",
      );
      const error = parseError(text);

      expect(error.code).toBe("frontmatter-key-type");
      expect(error.line).toBe(1);
    });

    it("rejects a frontmatter that expands to more aliases than the YAML library allows", () => {
      const rows = Array.from({ length: 12 }, (_row, index) =>
        index === 0 ? "a0: &a0 [x, x]" : `a${index}: &a${index} [*a${index - 1}, *a${index - 1}]`,
      ).join("\n");
      const text = fixture("valid/minimal.md").replace("next_comment_id: 1", `next_comment_id: 1\n${rows}`);

      expect(parseError(text).code).toBe("frontmatter-invalid");
    });

    /** The same extra keys written into the frontmatter and into a marker. */
    function withKeys(region: string, keys: string): string {
      const minimal = fixture("valid/minimal.md");
      return region === "frontmatter"
        ? minimal.replace("next_comment_id: 1", `next_comment_id: 1\n${keys}`)
        : `${minimal}
<!-- task:comment
id: 1
title: t
created: "2026-01-01T00:00:00Z"
${keys}
-->
`;
    }

    /** A flow mapping nested `depth` levels deep, on one line. */
    function deepFlow(depth: number): string {
      let text = "1";
      for (let level = 0; level < depth; level += 1) text = `{nested: ${text}}`;
      return text;
    }

    const REGIONS: [string, string][] = [
      ["frontmatter", "frontmatter-key-type"],
      ["marker", "marker-key-type"],
    ];

    it.each(REGIONS)("rejects a %s custom mapping that carries a prototype key", (region, code) => {
      const text = withKeys(region, 'custom:\n  workflow:\n    ? "__proto__"\n    : {is_admin: true}');

      expect(parseError(text).code).toBe(code);
    });

    it.each(REGIONS)("rejects a %s custom mapping that contains itself", (region, code) => {
      const text = withKeys(region, "custom: &a\n  self: *a");

      expect(parseError(text).code).toBe(code);
    });

    it.each(REGIONS)("rejects a %s custom mapping nested past the limit", (region, code) => {
      const levels = Array.from({ length: 150 }, (_level, depth) => `${"  ".repeat(depth + 1)}nested:`);
      const text = withKeys(region, ["custom:", ...levels, `${"  ".repeat(151)}leaf: 1`].join("\n"));

      expect(parseError(text).code).toBe(code);
    });

    // A YAML tag resolves to a value the format does not model, and a walk over
    // its entries sees nothing, so the checks below it never run.
    it.each(REGIONS)("rejects a %s custom mapping written as an ordered map", (region, code) => {
      const text = withKeys(region, "custom:\n  plugin: !!omap\n    - __proto__: {is_admin: true}");

      expect(parseError(text).code).toBe(code);
    });

    it.each(REGIONS)("rejects a %s custom mapping that holds a set", (region, code) => {
      const text = withKeys(region, "custom:\n  plugin: !!set\n    ? a");

      expect(parseError(text).code).toBe(code);
    });

    // The bound belongs to the region, not to one key: an unknown key is
    // retained and written back, so it reaches the writer the same way.
    it.each(REGIONS)("rejects a %s key this format does not define that nests past the limit", (region, code) => {
      const text = withKeys(region, `notes: ${deepFlow(150)}`);

      expect(parseError(text).code).toBe(code);
    });

    it.each(REGIONS)("rejects a %s key this format does not define that holds an ordered map", (region, code) => {
      const text = withKeys(region, "notes: !!omap\n  - a: 1");

      expect(parseError(text).code).toBe(code);
    });

    it("names the key that nests past the limit", () => {
      const text = withKeys("frontmatter", `notes: ${deepFlow(150)}`);

      expect(parseError(text).message).toContain('frontmatter key "notes"');
      expect(parseError(text).line).toBe(8);
    });

    it("rejects a marker key that would open another marker", () => {
      const text = `${fixture("valid/minimal.md")}
<!-- task:comment {id: 1, title: t, created: "2026-01-01T00:00:00Z", <!-- task:comment: x} -->
`;
      const error = parseError(text);

      expect(error.code).toBe("marker-invalid");
      expect(error.message).toBe('line 10: a marker key must not start with "<!-- task:comment"');
    });
  });

  describe("diagnostics", () => {
    it("reports a next_comment_id the file has already used", () => {
      const { task, diagnostics } = parseTask(fixture("warn/stale-next-comment-id.md"));

      expect(task.comments).toHaveLength(2);
      expect(diagnostics).toEqual([
        {
          code: "stale-next-comment-id",
          line: 7,
          message: "next_comment_id is 2, but the file already uses comment id 2",
        },
      ]);
    });

    it("reports a fence that never closes and turns the markers after it into text", () => {
      const { task, diagnostics } = parseTask(fixture("warn/unterminated-fence.md"));

      expect(task.comments).toEqual([]);
      expect(diagnostics).toEqual([
        {
          code: "unterminated-fence",
          line: 12,
          message: "the fenced code block opened here never closes",
        },
      ]);
    });
  });

  describe("legal and silent", () => {
    it("accepts an optional key with an empty value as absent", () => {
      const text = fixture("valid/minimal.md").replace("next_comment_id: 1", "step:\nnext_comment_id: 1");
      const { task } = parseTask(text);

      expect(task.frontmatter.step).toBeUndefined();
    });

    it("accepts an unquoted timestamp", () => {
      const text = fixture("valid/minimal.md").replace('created: "2026-01-01T00:00:00Z"', "created: 2026-01-01T00:00:00Z");
      const { task } = parseTask(text);

      expect(task.frontmatter.created).toBe("2026-01-01T00:00:00Z");
    });

    it("accepts a timestamp with a fraction of a second", () => {
      const text = fixture("valid/minimal.md").replace('"2026-01-01T00:00:00Z"', '"2026-01-01T00:00:00.250+03:00"');
      const { task } = parseTask(text);

      expect(task.frontmatter.created).toBe("2026-01-01T00:00:00.250+03:00");
    });

    it("reads a file whose lines end with CRLF", () => {
      const { task, diagnostics } = parseTask(fixture("valid/example.md").replaceAll("\n", "\r\n"));

      expect(diagnostics).toEqual([]);
      expect(task.frontmatter.id).toBe("PROJ-42");
      expect(task.comments).toHaveLength(2);
    });
  });
});
