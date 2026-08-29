import { type Document, parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import {
  type Frontmatter,
  hasSource,
  parseTask,
  serializeTask,
  SNAPSHOT,
  type Task,
  type TaskComment,
  TaskSerializeError,
} from "@tasma/engine";
import { fixture, fixturesIn } from "./fixtures.js";

const TIMESTAMP = "2026-07-01T12:00:00+03:00";
const MARKER_PREFIX = "<!-- task:comment";

/** A task built from typed fields alone, the way a caller creates a new file. */
function newTask(overrides: Partial<Task> = {}): Task {
  return {
    frontmatter: {
      id: "PROJ-99",
      title: "New",
      status: "To Do",
      created: TIMESTAMP,
      updated: TIMESTAMP,
      next_comment_id: 1,
    },
    body: "\nBody.\n",
    comments: [],
    ...overrides,
  };
}

/** A mapping with a key that would reach `Object.prototype` when a caller merges it. */
function unsafeMapping(): Record<string, unknown> {
  const mapping: Record<string, unknown> = {};
  Object.defineProperty(mapping, "__proto__", {
    value: { is_admin: true },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return mapping;
}

/** A mapping that contains itself. */
function cyclicMapping(): Record<string, unknown> {
  const mapping: Record<string, unknown> = {};
  mapping.self = mapping;
  return mapping;
}

/** A list with no value at one of its positions. */
function listWithGap(): string[] {
  const list = ["a", "b", "c"];
  delete list[1];
  return list;
}

/** A mapping nested `depth` levels deep. */
function deepMapping(depth: number): Record<string, unknown> {
  let mapping: Record<string, unknown> = { leaf: 1 };
  for (let level = 0; level < depth; level += 1) mapping = { nested: mapping };
  return mapping;
}

/**
 * A mapping that holds one object under two keys at every level, so it expands
 * to `2 ** depth` values although it holds `depth` of them.
 */
function sharedMapping(depth: number): Record<string, unknown> {
  let mapping: Record<string, unknown> = { leaf: 1 };
  for (let level = 0; level < depth; level += 1) mapping = { a: mapping, b: mapping };
  return mapping;
}

/** A document the YAML library parses but refuses to read values out of. */
function aliasBomb(): Document {
  const rows = Array.from({ length: 12 }, (_row, index) =>
    index === 0 ? "a0: &a0 [x, x]" : `a${index}: &a${index} [*a${index - 1}, *a${index - 1}]`,
  );
  return parseDocument(rows.join("\n"));
}

/** A task whose one comment carries a block marker, so a regeneration keeps that style. */
function taskWithBlockMarker(): Task {
  const text = `${fixture("valid/minimal.md")}
<!-- task:comment
id: 1
title: t
created: "${TIMESTAMP}"
-->
`;
  return parseTask(text).task;
}

/** Runs `serializeTask` and returns the `TaskSerializeError` it must throw. */
function serializeError(task: Task): TaskSerializeError {
  try {
    serializeTask(task);
  } catch (error) {
    if (error instanceof TaskSerializeError) return error;
    throw error;
  }
  throw new Error("serializeTask did not throw");
}

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

describe("write rejections", () => {
  it("rejects a marker value that contains the closing arrow", () => {
    const task = newTask({ comments: [{ id: 1, title: "a --> b", created: TIMESTAMP, body: "" }] });
    const error = serializeError(task);

    expect(error.code).toBe("value-contains-arrow");
    expect(error.field).toBe("title");
    expect(error.line).toBe(11);
    expect(error.message).toBe('line 11: marker key "title" must not contain "-->"');
  });

  it("names the path of a nested marker value that contains the closing arrow", () => {
    const task = newTask({
      comments: [
        {
          id: 1,
          title: "t",
          created: TIMESTAMP,
          custom: { tags: ["clean"], workflow: { note: "a --> b" } },
          body: "",
        },
      ],
    });

    expect(serializeError(task).field).toBe("custom.workflow.note");
  });

  it("names the index of a list value that contains the closing arrow", () => {
    const task = newTask({
      comments: [{ id: 1, title: "t", created: TIMESTAMP, custom: { tags: ["clean", "a --> b"] }, body: "" }],
    });

    expect(serializeError(task).field).toBe("custom.tags[1]");
  });

  it("names a marker key that contains the closing arrow", () => {
    const task = newTask({
      comments: [{ id: 1, title: "t", created: TIMESTAMP, custom: { "a-->b": 1 }, body: "" }],
    });

    expect(serializeError(task).field).toBe("custom.a-->b");
  });

  it("rejects a marker-shaped line at column 0 inside the task body", () => {
    const task = newTask({ body: `\n<!-- task:comment {id: 9, title: "t", created: "${TIMESTAMP}"} -->\n` });
    const error = serializeError(task);

    expect(error.code).toBe("marker-collision");
    expect(error.line).toBe(10);
  });

  it("rejects a marker-shaped line at column 0 inside a comment body", () => {
    const task = newTask({
      comments: [{ id: 1, title: "t", created: TIMESTAMP, body: `\n<!-- task:comment {id: 9} -->\n` }],
    });

    expect(serializeError(task).code).toBe("marker-collision");
  });

  it("accepts a marker-shaped line inside a fence", () => {
    const task = newTask({ body: `\n\`\`\`\n<!-- task:comment {id: 9} -->\n\`\`\`\n` });

    expect(serializeTask(task)).toContain("```\n<!-- task:comment {id: 9} -->\n```");
  });

  it("rejects two comments that share an id", () => {
    const task = newTask({
      comments: [
        { id: 1, title: "First", created: TIMESTAMP, body: "\nX.\n" },
        { id: 1, title: "Second", created: TIMESTAMP, body: "" },
      ],
    });
    const error = serializeError(task);

    expect(error.code).toBe("comment-id-duplicate");
    expect(error.line).toBe(14);
  });

  // The reader rejects "-->" before a marker closes, so the only way a marker
  // reaches the writer with one is through the source the parser retained.
  it("rejects the closing arrow inside a marker key this format does not define", () => {
    const { task } = parseTask(fixture("valid/unknown-keys.md"));
    const comment = task.comments[0]!;
    comment[SNAPSHOT]!.doc.set("reactions", "a --> b");

    const error = serializeError({ ...task, comments: [{ ...comment, title: "Edited" }] });

    expect(error.code).toBe("value-contains-arrow");
    expect(error.field).toBe("reactions");
  });

  it("rejects the closing arrow inside a YAML comment the marker preserves", () => {
    const task = taskWithBlockMarker();
    task.comments[0]![SNAPSHOT]!.doc.comment = " a --> b";

    const error = serializeError({ ...task, comments: [{ ...task.comments[0]!, title: "Edited" }] });

    expect(error.code).toBe("value-contains-arrow");
    expect(error.field).toBeUndefined();
    expect(error.message).toBe('line 10: a marker must not contain "-->"');
  });

  // A marker key is written at column 0 in block style, where it opens a new
  // comment. The reader rejects such a key, so it reaches the writer only
  // through the source the parser retained.
  it.each([
    ["a marker that stays on one line", {}],
    ["a marker a nested value writes in block style", { custom: { workflow: { round: 2 } } }],
  ])("rejects a marker-shaped key in %s", (_case, overrides) => {
    const task = taskWithBlockMarker();
    task.comments[0]![SNAPSHOT]!.doc.set(MARKER_PREFIX, "x");

    const error = serializeError({ ...task, comments: [{ ...task.comments[0]!, title: "Edited", ...overrides }] });

    expect(error.code).toBe("marker-collision");
    expect(error.field).toBe(MARKER_PREFIX);
    expect(error.message).toBe(`line 10: a marker key must not start with "${MARKER_PREFIX}"`);
  });

  it("rejects a body that leaves a fence open before a marker", () => {
    const task = newTask({
      comments: [
        { id: 1, title: "First", created: TIMESTAMP, body: "\n```text\nno closing fence\n" },
        { id: 2, title: "Second", created: TIMESTAMP, body: "" },
      ],
    });
    const error = serializeError(task);

    expect(error.code).toBe("fence-unterminated");
    expect(error.line).toBe(13);
    expect(error.message).toBe(
      "line 13: the fenced code block opened here never closes, so the marker on line 15 would read as text",
    );
  });

  it("accepts a fence a later line closes", () => {
    const task = newTask({
      comments: [
        { id: 1, title: "First", created: TIMESTAMP, body: "\n```text\nfenced\n```\n" },
        { id: 2, title: "Second", created: TIMESTAMP, body: "" },
      ],
    });

    expect(parseTask(serializeTask(task)).task.comments).toHaveLength(2);
  });

  // The frontmatter region is written back from the source the parser retained,
  // and that source is reachable through the exported symbol key.
  it.each([
    ["carries a third delimiter line", "---\nid: X\n---\nsneak\n---\n", 3],
    ["is not fenced by two delimiter lines", "id: X\n", 1],
  ])("rejects a frontmatter region that %s", (_case, raw, line) => {
    const { task } = parseTask(fixture("valid/minimal.md"));
    const error = serializeError({ ...task, [SNAPSHOT]: { ...task[SNAPSHOT]!, raw } });

    expect(error.code).toBe("frontmatter-collision");
    expect(error.line).toBe(line);
  });

  // A caller outside TypeScript can hand over any value, so the writer runs the
  // reader's checks rather than trusting the types.
  const INVALID_FRONTMATTER: [string, Record<string, unknown>, string, string][] = [
    ["a required frontmatter key that is absent", { title: undefined }, "key-missing", "title"],
    ["a frontmatter timestamp that is not one", { created: "yesterday" }, "key-type", "created"],
    ["a counter that is not an integer", { next_comment_id: 1.5 }, "key-type", "next_comment_id"],
    ["a custom mapping with a prototype key", { custom: unsafeMapping() }, "key-type", "custom"],
    ["a custom mapping that contains itself", { custom: cyclicMapping() }, "key-type", "custom"],
    ["a custom mapping nested past the limit", { custom: deepMapping(150) }, "key-type", "custom"],
    ["a custom mapping that is not a plain mapping", { custom: new Map([["a", 1]]) }, "key-type", "custom"],
    ["a custom mapping that holds a set", { custom: { tags: new Set(["a"]) } }, "key-type", "custom"],
    ["a custom mapping that expands past the limit", { custom: sharedMapping(30) }, "key-type", "custom"],
    ["a label list with an unfilled position", { labels: listWithGap() }, "key-type", "labels"],
    ["a custom mapping that holds a list with an unfilled position", { custom: { tags: listWithGap() } }, "key-type", "custom"],
    ["a label list with a position that names no value", { labels: ["a", undefined] }, "key-type", "labels"],
    ["a custom mapping that holds a list with such a position", { custom: { tags: ["a", undefined] } }, "key-type", "custom"],
  ];

  it.each(INVALID_FRONTMATTER)("rejects %s", (_case, overrides, code, field) => {
    const task = newTask();
    const frontmatter = { ...task.frontmatter, ...overrides } as Frontmatter;
    const error = serializeError({ ...task, frontmatter });

    expect(error.code).toBe(code);
    expect(error.field).toBe(field);
  });

  it("rejects a marker key of the wrong type", () => {
    const task = newTask({ comments: [{ id: 1, title: "t", created: "yesterday", body: "" }] });
    const error = serializeError(task);

    expect(error.code).toBe("key-type");
    expect(error.field).toBe("created");
  });

  it("rejects a marker that is missing a required key", () => {
    const comment = { id: 1, created: TIMESTAMP, body: "" } as unknown as TaskComment;
    const error = serializeError(newTask({ comments: [comment] }));

    expect(error.code).toBe("key-missing");
    expect(error.field).toBe("title");
  });

  // Every check above reads the fields as the types declare them, so the shape
  // of the task is checked before any region is built.
  const MALFORMED: [string, unknown, string | undefined][] = [
    ["a task that is not a mapping", null, undefined],
    ["a frontmatter that is not a mapping", { ...newTask(), frontmatter: [] }, "frontmatter"],
    ["a body that is not a string", { ...newTask(), body: 5 }, "body"],
    ["a comment list that is not a list", { ...newTask(), comments: null }, "comments"],
    ["a comment that is not a mapping", { ...newTask(), comments: [null] }, "comments[0]"],
    [
      "a comment body that is not a string",
      { ...newTask(), comments: [{ id: 1, title: "t", created: TIMESTAMP }] },
      "comments[0].body",
    ],
  ];

  it.each(MALFORMED)("rejects %s", (_case, malformed, field) => {
    const error = serializeError(malformed as Task);

    expect(error.code).toBe("key-type");
    expect(error.field).toBe(field);
  });

  // A key another key points at cannot be rewritten in place: the library
  // either drops the anchor and leaves the alias unresolved, or keeps the
  // anchor and changes the aliased value with it.
  describe("a value another value points at", () => {
    /** The minimal file with `insert` written in place of `find`. */
    function frontmatterWith(find: string, insert: string): Task {
      return parseTask(fixture("valid/minimal.md").replace(find, insert)).task;
    }

    it("rejects a change to it", () => {
      const task = frontmatterWith('created: "2026-01-01T00:00:00Z"', 'created: &t "2026-01-01T00:00:00Z"\nmirror: *t');
      const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, created: TIMESTAMP } });

      expect(error.code).toBe("anchor-aliased");
      expect(error.field).toBe("created");
      expect(error.message).toBe(
        'line 1: frontmatter key "created" carries a YAML anchor another value points at, so it cannot be changed',
      );
    });

    it("rejects a change to it when it is a list", () => {
      const task = frontmatterWith("next_comment_id: 1", "labels: &l [backend]\nmirror: *l\nnext_comment_id: 1");
      const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, labels: ["frontend"] } });

      expect(error.code).toBe("anchor-aliased");
      expect(error.field).toBe("labels");
    });

    it("rejects its removal", () => {
      const task = frontmatterWith("next_comment_id: 1", "step: &s dev\nmirror: *s\nnext_comment_id: 1");
      const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, step: undefined } });

      expect(error.code).toBe("anchor-aliased");
      expect(error.field).toBe("step");
    });

    it("rejects a change that would rewrite the value the alias reads", () => {
      const text = fixture("valid/minimal.md")
        .replace("title: Minimal", "title: &t Minimal")
        .replace("next_comment_id: 1", "next_comment_id: 1\ncustom:\n  label: *t");
      const { task } = parseTask(text);
      const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, title: "Changed" } });

      expect(error.code).toBe("anchor-aliased");
      expect(error.field).toBe("title");
    });

    it("rejects a change to a marker key another marker key points at", () => {
      const text = `${fixture("valid/minimal.md")}
<!-- task:comment
id: 1
title: t
created: &t "${TIMESTAMP}"
updated: *t
-->
`;
      const { task } = parseTask(text);
      const comment = { ...task.comments[0]!, created: "2026-09-09T09:09:09Z" };
      const error = serializeError({ ...task, comments: [comment] });

      expect(error.code).toBe("anchor-aliased");
      expect(error.field).toBe("created");
      expect(error.message).toBe(
        'line 1: marker key "created" carries a YAML anchor another value points at, so it cannot be changed',
      );
    });

    it("writes a change to a value whose anchor no other value points at", () => {
      const task = frontmatterWith('created: "2026-01-01T00:00:00Z"', 'created: &t "2026-01-01T00:00:00Z"');

      const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, created: TIMESTAMP } });

      expect(out).toContain(`created: "${TIMESTAMP}"`);
    });

    it("adds a key the file does not carry yet", () => {
      const task = frontmatterWith('created: "2026-01-01T00:00:00Z"', 'created: &t "2026-01-01T00:00:00Z"\nmirror: *t');

      const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, priority: "high" } });

      expect(out).toContain("priority: high");
      expect(out).toContain("mirror: *t");
    });

    it("keeps the anchor and the alias when another key changes", () => {
      const task = frontmatterWith('created: "2026-01-01T00:00:00Z"', 'created: &t "2026-01-01T00:00:00Z"\nmirror: *t');

      const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, status: "Done" } });

      expect(out).toContain('created: &t "2026-01-01T00:00:00Z"');
      expect(out).toContain("mirror: *t");
    });
  });

  // A merge key lends the region the keys of another mapping. Those keys are
  // reported by the value reader but are not items of the mapping, so removing
  // one removes nothing and the written file keeps the value the caller took
  // away.
  describe("a region that resolves a merge key", () => {
    const MERGED_FRONTMATTER = fixture("valid/minimal.md").replace(
      "next_comment_id: 1",
      "base: &b\n  workflow: dev\n!!merge <<: *b\nnext_comment_id: 1",
    );

    it("reads the keys the merge lends it", () => {
      expect(parseTask(MERGED_FRONTMATTER).task.frontmatter.workflow).toBe("dev");
    });

    it("is written back byte for byte while nothing changes", () => {
      expect(serializeTask(parseTask(MERGED_FRONTMATTER).task)).toBe(MERGED_FRONTMATTER);
    });

    it("rejects a change to the frontmatter", () => {
      const { task } = parseTask(MERGED_FRONTMATTER);
      const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, workflow: undefined } });

      expect(error.code).toBe("merge-key");
      expect(error.message).toBe(
        "line 1: the frontmatter resolves a YAML merge key, so a change to it cannot be written",
      );
    });

    // YAML 1.2 resolves a merge key only under its tag. A 1.1 directive makes a
    // plain "<<" a merge key as well, and the marker carries its own document.
    it.each([
      ["under its tag", ["!!merge <<: *b"]],
      ["under a version directive", ["<<: *b"], ["%YAML 1.1", "---"]],
    ])("rejects a change to a marker that merges %s", (_case, mergeLine, directive = []) => {
      const text = `${fixture("valid/minimal.md")}
<!-- task:comment
${[...directive, "id: 1", "title: t", `created: "${TIMESTAMP}"`, "base: &b", "  author: alex", ...mergeLine].join("\n")}
-->
`;
      const { task } = parseTask(text);

      expect(task.comments[0]!.author).toBe("alex");
      expect(serializeError({ ...task, comments: [{ ...task.comments[0]!, title: "Edited" }] }).code).toBe("merge-key");
    });
  });

  // An alias written as a key resolves to the name it points at, so the value
  // reader reports a key that stands nowhere in the document under that name.
  // The writer addresses a key by its name, so it reaches neither.
  describe("a region whose key is written as an alias", () => {
    const ALIAS_KEY = ["holder: &n custom", "? *n", ": {is_admin: true}"].join("\n");
    const ALIAS_KEY_FRONTMATTER = fixture("valid/minimal.md").replace(
      "next_comment_id: 1",
      `${ALIAS_KEY}\nnext_comment_id: 1`,
    );

    it("reads the key the alias names", () => {
      expect(parseTask(ALIAS_KEY_FRONTMATTER).task.frontmatter.custom).toEqual({ is_admin: true });
    });

    it("is written back byte for byte while nothing changes", () => {
      expect(serializeTask(parseTask(ALIAS_KEY_FRONTMATTER).task)).toBe(ALIAS_KEY_FRONTMATTER);
    });

    it("rejects the removal of that key", () => {
      const { task } = parseTask(ALIAS_KEY_FRONTMATTER);
      const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, custom: undefined } });

      expect(error.code).toBe("key-unaddressable");
      expect(error.message).toBe(
        "line 1: the frontmatter carries a key the writer cannot address, so a change to it cannot be written",
      );
    });

    it("rejects a change to that key", () => {
      const { task } = parseTask(ALIAS_KEY_FRONTMATTER);
      const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, custom: { is_admin: false } } });

      expect(error.code).toBe("key-unaddressable");
    });

    it("rejects a change to another key of the same region", () => {
      const { task } = parseTask(ALIAS_KEY_FRONTMATTER);
      const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, status: "Done" } });

      expect(error.code).toBe("key-unaddressable");
    });

    it("rejects a change to a marker that carries one", () => {
      const text = `${fixture("valid/minimal.md")}
<!-- task:comment
holder: &n author
id: 1
title: t
created: "${TIMESTAMP}"
? *n
: alex
-->
`;
      const { task } = parseTask(text);

      expect(task.comments[0]!.author).toBe("alex");
      const error = serializeError({ ...task, comments: [{ ...task.comments[0]!, author: undefined }] });
      expect(error.code).toBe("key-unaddressable");
      expect(error.message).toBe(
        "line 1: the marker carries a key the writer cannot address, so a change to it cannot be written",
      );
    });
  });

  // The retained source is reachable through the exported symbol key, so the
  // writer meets documents it did not read itself.
  it("reports a region the YAML library cannot write", () => {
    const { task } = parseTask(fixture("valid/minimal.md"));
    task[SNAPSHOT]!.doc.set("notes", deepMapping(20000));

    const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, status: "Done" } });

    expect(error.code).toBe("region-unwritable");
    expect(error.message).toContain("the frontmatter cannot be written");
  });

  // The marker values every check below reads come out of the same converter as
  // the marker text, so no exception the YAML library raises reaches the caller.
  it("reports a marker the YAML library cannot read values out of", () => {
    const task = taskWithBlockMarker();
    task.comments[0]![SNAPSHOT]!.doc = aliasBomb();

    const error = serializeError(task);

    expect(error.code).toBe("region-unwritable");
    expect(error.message).toContain("the marker cannot be written");
  });

  it("names the file in the message when the caller passes one", () => {
    const task = newTask({ comments: [{ id: 1, title: "a --> b", created: TIMESTAMP, body: "" }] });

    try {
      serializeTask(task, { filename: "proj-99.md" });
      throw new Error("serializeTask did not throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskSerializeError);
      expect((error as TaskSerializeError).filename).toBe("proj-99.md");
      expect((error as TaskSerializeError).message).toBe('proj-99.md:11: marker key "title" must not contain "-->"');
    }
  });
});
