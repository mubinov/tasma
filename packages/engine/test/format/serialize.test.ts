import { describe, expect, it } from "vitest";
import { hasSource, parseTask, serializeTask, SNAPSHOT } from "@tasma/engine";
import { fixture, fixturesIn } from "./fixtures.js";
import { newTask, TIMESTAMP } from "./tasks.js";

describe("round trip", () => {
  it.each([...fixturesIn("valid"), ...fixturesIn("warn")])("reproduces %s byte for byte", (_name, text) => {
    expect(serializeTask(parseTask(text).task)).toBe(text);
  });

  it("reproduces a file whose lines end with CRLF", () => {
    const text = fixture("valid/example.md").replaceAll("\n", "\r\n");

    expect(serializeTask(parseTask(text).task)).toBe(text);
  });

  it("reproduces a file with no final newline", () => {
    const text = fixture("valid/example.md").trimEnd();

    expect(serializeTask(parseTask(text).task)).toBe(text);
  });

  // A value that compares as changed rewrites its region, and the rewrite
  // replaces the node that carries a YAML comment.
  it("reproduces a file whose custom data holds a value that is not a number", () => {
    const text = fixture("valid/minimal.md").replace(
      "next_comment_id: 1",
      "custom:\n  # keep this note\n  score: .nan\n  other: 1\nnext_comment_id: 1",
    );
    const { task } = parseTask(text);

    expect(task.frontmatter.custom).toEqual({ score: NaN, other: 1 });
    expect(serializeTask(task)).toBe(text);
  });

  it("reproduces a marker whose custom data holds a value that is not a number", () => {
    const text = `${fixture("valid/minimal.md")}
<!-- task:comment
id: 1
title: t
created: "${TIMESTAMP}"
custom:
  # keep this note
  score: .nan
-->
`;

    expect(serializeTask(parseTask(text).task)).toBe(text);
  });

  // A key that names no value is the plain way a caller clears a key. Clearing
  // a key the file does not carry changes nothing, so the region keeps its bytes.
  it("reproduces a file when an optional key the file does not carry is cleared", () => {
    const text = fixture("valid/minimal.md").replace(
      "next_comment_id: 1",
      "labels: [backend]\ncustom: {workflow: {attempts: 2}}\nnext_comment_id: 1",
    );
    const { task } = parseTask(text);

    expect(serializeTask({ ...task, frontmatter: { ...task.frontmatter, step: undefined } })).toBe(text);
  });

  it("reproduces a file when a key its custom data does not carry is cleared", () => {
    const text = fixture("valid/minimal.md").replace(
      "next_comment_id: 1",
      "custom:\n  # keep this note\n  workflow: {round: 6}\nnext_comment_id: 1",
    );
    const { task } = parseTask(text);
    const custom = { ...task.frontmatter.custom, absent: undefined };

    expect(serializeTask({ ...task, frontmatter: { ...task.frontmatter, custom } })).toBe(text);
  });

  it("reproduces a marker when a key its custom data does not carry is cleared", () => {
    const text = `${fixture("valid/minimal.md")}
<!-- task:comment
id: 1
title: t
created: "${TIMESTAMP}"
custom:
  # keep this note
  workflow: {round: 6}
-->
`;
    const { task } = parseTask(text);
    const comment = task.comments[0]!;
    const custom = { ...comment.custom, absent: undefined };

    expect(serializeTask({ ...task, comments: [{ ...comment, custom }] })).toBe(text);
  });

  it("survives a shallow copy of the task", () => {
    const text = fixture("valid/example.md");
    const { task } = parseTask(text);

    expect(serializeTask({ ...task, comments: task.comments.map((c) => ({ ...c })) })).toBe(text);
  });

  it("reports the source a copy without symbol keys drops", () => {
    const { task } = parseTask(fixture("valid/example.md"));
    // structuredClone copies string keys only, so the symbol-keyed source is lost.
    const copy = structuredClone(task);

    expect(hasSource(task)).toBe(true);
    expect(hasSource(task.comments[0]!)).toBe(true);
    expect(copy[SNAPSHOT]).toBeUndefined();
    expect(hasSource(copy)).toBe(false);
  });
});

describe("regeneration", () => {
  it("rewrites the frontmatter alone when a frontmatter field changes", () => {
    const text = fixture("valid/example.md");
    const { task } = parseTask(text);

    const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, status: "Done" } });

    // The library spaces a flow collection its own way when it writes the region again.
    expect(out).toBe(
      text.replace("status: In Progress", "status: Done").replace("labels: [import]", "labels: [ import ]"),
    );
  });

  it("writes the same text every time it runs on the same task", () => {
    const { task } = parseTask(fixture("valid/example.md"));
    const changed = { ...task, frontmatter: { ...task.frontmatter, status: "Done" } };

    expect(serializeTask(changed)).toBe(serializeTask(changed));
  });

  it("keeps YAML comments, key order and quoting style through a frontmatter change", () => {
    const { task } = parseTask(fixture("valid/unknown-keys.md"));

    const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, status: "Done" } });

    expect(out).toContain("# A reader keeps this comment");
    expect(out).toContain("title: 'Unknown keys and YAML comments survive'");
    expect(out).toContain("external_ref: JIRA-42");
    expect(out).toContain("# last touched by the import");
    expect(out).toContain("status: Done");
    expect(out.indexOf("external_ref")).toBeGreaterThan(out.indexOf("status:"));
  });

  it("writes a changed timestamp with double quotes", () => {
    const text = fixture("valid/minimal.md").replace('updated: "2026-01-01T00:00:00Z"', "updated: 2026-01-01T00:00:00Z");
    const { task } = parseTask(text);

    const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, updated: TIMESTAMP } });

    expect(out).toContain(`updated: "${TIMESTAMP}"`);
  });

  it("removes a frontmatter key that becomes absent", () => {
    const { task } = parseTask(fixture("valid/example.md"));

    const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, step: undefined } });

    expect(out).not.toContain("step:");
    expect(out).toContain("workflow: delivery");
  });

  it("rewrites one marker and keeps its unknown keys", () => {
    const { task } = parseTask(fixture("valid/unknown-keys.md"));
    const comment = task.comments[0]!;

    const out = serializeTask({ ...task, comments: [{ ...comment, title: "Edited" }] });

    expect(out).toContain(
      '<!-- task:comment { id: 1, title: "Edited", created: "2026-02-03T10:05:00+03:00", reactions: 3 } -->',
    );
  });

  it("leaves the marker untouched when only the comment body changes", () => {
    const { task } = parseTask(fixture("valid/example.md"));
    const comment = task.comments[1]!;

    const out = serializeTask({ ...task, comments: [task.comments[0]!, { ...comment, body: "\nRewritten.\n" }] });

    expect(out).toContain('title: "Rows with an empty column"');
    expect(out).toContain("\n-->\n\nRewritten.\n");
  });

  // The writer states the keys this format defines. Every other key of a region
  // comes from the source it writes back, so a key of that name on the caller's
  // object names nothing the writer reads.
  it("ignores a frontmatter key this format does not define", () => {
    const text = fixture("valid/unknown-keys.md");
    const { task } = parseTask(text);
    const frontmatter = { ...task.frontmatter, external_ref: "IGNORED", plugin: new Map([["a", 1]]) };

    expect(serializeTask({ ...task, frontmatter })).toBe(text);
  });

  it("ignores the lines field, which the parser writes for the caller", () => {
    const text = fixture("valid/example.md");
    const { task } = parseTask(text);

    const comments = task.comments.map((c) => ({ ...c, lines: { start: 0, end: 0 } }));

    expect(serializeTask({ ...task, comments })).toBe(text);
  });

  it("keeps block style when the marker carries a YAML comment", () => {
    const text = `${fixture("valid/minimal.md")}
<!-- task:comment
id: 1 # the first comment
title: t
created: "${TIMESTAMP}"
-->
`;
    const { task } = parseTask(text);

    const out = serializeTask({ ...task, comments: [{ ...task.comments[0]!, title: "Edited" }] });

    expect(out).toContain("<!-- task:comment\nid: 1 # the first comment\ntitle: Edited\n");
    expect(out).toContain(`created: "${TIMESTAMP}"\n-->\n`);
  });

  it("uses block style when a marker value nests", () => {
    const { task } = parseTask(fixture("valid/example.md"));
    const comment = task.comments[0]!;

    const out = serializeTask({
      ...task,
      comments: [{ ...comment, custom: { workflow: { round: 2 } } }, task.comments[1]!],
    });

    expect(out).toContain("<!-- task:comment\nid: 1\n");
    expect(out).toContain("custom:\n  workflow:\n    round: 2\n-->\n");
  });

  // An anchor of the writer's own making would lock the key it sits on against
  // every later change, and enough of them would push the file past the alias
  // limit the reader sets.
  describe("a value the caller placed under two keys", () => {
    const shared = { note: "reused" };

    it("is written once under each key", () => {
      const task = newTask();
      const custom = { a: shared, b: shared };

      const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, custom } });

      expect(out).toContain("custom:\n  a:\n    note: reused\n  b:\n    note: reused\n");
      expect(parseTask(out).task.frontmatter.custom).toEqual(custom);
    });

    it("is written once under each key of a marker", () => {
      const comment = { id: 1, title: "t", created: TIMESTAMP, custom: { a: shared, b: shared }, body: "" };

      const out = serializeTask(newTask({ comments: [comment] }));

      expect(out).not.toContain("&");
      expect(parseTask(out).task.comments[0]!.custom).toEqual(comment.custom);
    });

    it("leaves the key open to a later change", () => {
      const task = newTask();
      const first = serializeTask({ ...task, frontmatter: { ...task.frontmatter, custom: { a: shared, b: shared } } });
      const reread = parseTask(first).task;

      const out = serializeTask({ ...reread, frontmatter: { ...reread.frontmatter, custom: { a: { note: "new" } } } });

      expect(parseTask(out).task.frontmatter.custom).toEqual({ a: { note: "new" } });
    });

    it("reads back from a file that repeats it more often than the alias limit allows", () => {
      const task = newTask();
      const custom = { items: Array.from({ length: 101 }, () => shared) };

      const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, custom } });

      expect(parseTask(out).task.frontmatter.custom).toEqual(custom);
    });
  });

  it("uses block style when a value cannot fit one line", () => {
    const { task } = parseTask(fixture("valid/example.md"));
    const comment = task.comments[0]!;

    const out = serializeTask({ ...task, comments: [{ ...comment, title: "two\nlines" }, task.comments[1]!] });

    expect(parseTask(out).task.comments[0]!.title).toBe("two\nlines");
  });
});

describe("creation", () => {
  it("writes a task built from typed fields alone", () => {
    expect(serializeTask(newTask())).toBe(
      `---\nid: PROJ-99\ntitle: New\nstatus: To Do\ncreated: "${TIMESTAMP}"\nupdated: "${TIMESTAMP}"\nnext_comment_id: 1\n---\n\nBody.\n`,
    );
  });

  it("writes every optional frontmatter key in the order of the format document", () => {
    const task = newTask();
    const out = serializeTask({
      ...task,
      frontmatter: {
        ...task.frontmatter,
        workflow: "delivery",
        step: "build",
        priority: "high",
        order: 99000,
        labels: ["backend"],
        parent: "PROJ-1",
        custom: { workflow: { attempts: 1 } },
      },
    });

    expect(out.split("\n").slice(1, 8)).toEqual([
      "id: PROJ-99",
      "title: New",
      "status: To Do",
      "workflow: delivery",
      "step: build",
      "priority: high",
      "order: 99000",
    ]);
  });

  it("writes an appended comment as a flow marker", () => {
    const task = newTask({
      comments: [{ id: 1, title: "First", created: TIMESTAMP, body: "\nHello.\n" }],
    });

    expect(serializeTask(task)).toContain(
      `\n<!-- task:comment { id: 1, title: First, created: "${TIMESTAMP}" } -->\n\nHello.\n`,
    );
  });

  it("writes a comment whose custom data holds a list", () => {
    const task = newTask({
      comments: [{ id: 1, title: "First", created: TIMESTAMP, custom: { tags: ["a", "b"] }, body: "" }],
    });
    const text = serializeTask(task);

    expect(text).toContain("custom:\n  tags:\n    - a\n    - b\n-->\n");
    expect(parseTask(text).task.comments[0]!.custom).toEqual({ tags: ["a", "b"] });
  });

  it("re-parses a created file to the same structure", () => {
    const task = newTask({
      comments: [{ id: 1, title: "First", created: TIMESTAMP, author: "alex", body: "\nHello.\n" }],
    });
    const text = serializeTask(task);
    const reread = parseTask(text).task;

    expect(reread.frontmatter).toEqual(task.frontmatter);
    expect(reread.body).toBe(task.body);
    expect(reread.comments[0]!.title).toBe("First");
    expect(reread.comments[0]!.body).toBe("\nHello.\n");
    expect(serializeTask(reread)).toBe(text);
  });

  it("separates two regions that would otherwise share a line", () => {
    const task = newTask({
      body: "Body without a final newline.",
      comments: [{ id: 1, title: "First", created: TIMESTAMP, body: "" }],
    });

    expect(serializeTask(task)).toContain("Body without a final newline.\n<!-- task:comment ");
  });

  it("writes a task with an empty body", () => {
    const task = newTask({ body: "", comments: [] });

    expect(serializeTask(task)).toBe(
      `---\nid: PROJ-99\ntitle: New\nstatus: To Do\ncreated: "${TIMESTAMP}"\nupdated: "${TIMESTAMP}"\nnext_comment_id: 1\n---\n`,
    );
  });
});
