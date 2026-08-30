import { describe, expect, it } from "vitest";
import {
  type Frontmatter,
  parseTask,
  serializeTask,
  SNAPSHOT,
  type Task,
  type TaskComment,
  TaskSerializeError,
} from "@tasma/engine";
import { fixture } from "./fixtures.js";
import { newTask, serializeError, taskWithBlockMarker, TIMESTAMP } from "./tasks.js";

const MARKER_PREFIX = "<!-- task:comment";

/**
 * A string of nothing but whitespace. The YAML library writes a fresh scalar
 * holding one as a `|+` block scalar, whose text reads back without the spaces.
 */
const BLANK = "  \n";

/** Values of a type no YAML scalar holds, which the writer rejects before it writes. */
const UNWRITABLE_TYPES: [string, unknown][] = [
  ["a big integer", 9007199254740993n],
  ["a symbol", Symbol("planted")],
  ["a function", () => 1],
];

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
  // Positional writes, because an array literal must hold a value at every
  // position.
  const list: string[] = [];
  list[0] = "a";
  list[2] = "c";
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

/** Gives `target` a key whose reads answer with `values` in turn, the last one from then on. */
function answersInTurn(target: Record<string, unknown>, key: string, values: unknown[]): void {
  let reads = 0;
  Object.defineProperty(target, key, {
    get: () => values[Math.min(reads++, values.length - 1)],
    enumerable: true,
    configurable: true,
  });
}

describe("output a reader would not read back", () => {
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
      comments: [{ id: 1, title: "t", created: TIMESTAMP, body: "\n<!-- task:comment {id: 9} -->\n" }],
    });

    expect(serializeError(task).code).toBe("marker-collision");
  });

  it("accepts a marker-shaped line inside a fence", () => {
    const task = newTask({ body: "\n```\n<!-- task:comment {id: 9} -->\n```\n" });

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

// A caller outside TypeScript can hand over any value, so the writer runs the
// reader's checks rather than trusting the types.
describe("a task whose fields do not hold what the schema states", () => {
  const INVALID_FRONTMATTER: [string, Record<string, unknown>, string, string][] = [
    ["a required frontmatter key that is absent", { title: undefined }, "key-missing", "title"],
    ["a frontmatter timestamp that is not one", { created: "yesterday" }, "key-type", "created"],
    ["a counter that is not an integer", { next_comment_id: 1.5 }, "key-type", "next_comment_id"],
    ["custom data that is not a mapping", { custom: "none" }, "key-type", "custom"],
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
    const frontmatter = { ...task.frontmatter, ...overrides };
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

  // The writer reads the fields this format defines by name. A key of any other
  // name is not a field, so one that addresses the object model instead of
  // naming data reaches nothing: it is neither read nor written.
  it("reads no field through a frontmatter key that names the object model", () => {
    const forged = '{"id":"EVIL","title":"EVIL","status":"EVIL",'
      + `"created":"${TIMESTAMP}","updated":"${TIMESTAMP}","next_comment_id":7}`;
    const task = JSON.parse(`{"frontmatter":{"__proto__":${forged}},"body":"\\nhi\\n","comments":[]}`) as Task;
    const error = serializeError(task);

    expect(Object.keys(task.frontmatter)).toEqual(["__proto__"]);
    expect(error.code).toBe("key-missing");
    expect(error.field).toBe("id");
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
});

// The writer reads every region it generates back, because the YAML library
// writes some values in a form that resolves to another value and reports no
// fault of its own.
describe("a value the library writes in a form that reads back changed", () => {
  it("is rejected in a frontmatter key", () => {
    const task = newTask();
    const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, title: BLANK } });

    expect(error.code).toBe("value-unwritable");
    expect(error.field).toBe("title");
    expect(error.message).toBe(
      'line 1: frontmatter key "title" is written in a form that reads back as a different value',
    );
  });

  it("is rejected inside the frontmatter custom data, while the file it came from still round-trips", () => {
    const text = fixture("valid/minimal.md").replace(
      "next_comment_id: 1",
      'custom:\n  editor:\n    indent: "  \\n"\nnext_comment_id: 1',
    );
    const { task } = parseTask(text);

    expect(task.frontmatter.custom).toEqual({ editor: { indent: BLANK } });
    expect(serializeTask(task)).toBe(text);

    const custom = { editor: { indent: BLANK }, theme: "dark" };
    const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, custom } });

    expect(error.code).toBe("value-unwritable");
    expect(error.field).toBe("custom.editor.indent");
  });

  it("names the index it stands on in a list", () => {
    const task = newTask();
    const custom = { tags: ["ok", BLANK] };
    const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, custom } });

    expect(error.field).toBe("custom.tags[1]");
  });

  it("is rejected in a marker key", () => {
    const comment = { id: 1, title: BLANK, created: TIMESTAMP, custom: { workflow: { round: 2 } }, body: "" };
    const error = serializeError(newTask({ comments: [comment] }));

    expect(error.code).toBe("value-unwritable");
    expect(error.message).toBe('line 1: marker key "title" is written in a form that reads back as a different value');
  });

  it("is rejected inside the marker custom data", () => {
    const comment = { id: 1, title: "t", created: TIMESTAMP, custom: { editor: { indent: BLANK } }, body: "" };

    expect(serializeError(newTask({ comments: [comment] })).field).toBe("custom.editor.indent");
  });

  // An unknown key read out of a file keeps the scalar style it was parsed
  // with, so the only route to one the writer emits itself is the retained
  // source, which the exported symbol key reaches.
  it("is rejected in a key this format does not define", () => {
    const { task } = parseTask(fixture("valid/minimal.md"));
    task[SNAPSHOT]!.doc.set("notes", BLANK);

    const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, status: "Done" } });

    expect(error.code).toBe("value-unwritable");
    expect(error.field).toBe("notes");
  });

  // Flow style quotes and escapes the same value, so nothing is lost and
  // nothing is rejected.
  it("is written in a flow marker, which reads it back unchanged", () => {
    const out = serializeTask(newTask({ comments: [{ id: 1, title: BLANK, created: TIMESTAMP, body: "" }] }));

    expect(parseTask(out).task.comments[0]!.title).toBe(BLANK);
  });
});

// A caller outside TypeScript can hold a value no YAML scalar carries. The
// writer names the key rather than writing a value that reads back changed, or
// handing the library a value it refuses without naming anything.
describe("a value of a type no YAML scalar holds", () => {
  it.each(UNWRITABLE_TYPES)("rejects %s in a frontmatter key", (_case, value) => {
    const task = newTask();
    const frontmatter = { ...task.frontmatter, order: value } as unknown as Frontmatter;
    const error = serializeError({ ...task, frontmatter });

    expect(error.code).toBe("key-type");
    expect(error.field).toBe("order");
  });

  it.each(UNWRITABLE_TYPES)("rejects %s inside the frontmatter custom data", (_case, value) => {
    const task = newTask();
    const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, custom: { rows: value } } });

    expect(error.code).toBe("key-type");
    expect(error.field).toBe("custom");
  });

  it.each(UNWRITABLE_TYPES)("rejects %s at a position of a list", (_case, value) => {
    const task = newTask();
    const custom = { tags: ["ok", value] };
    const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, custom } });

    expect(error.code).toBe("key-type");
    expect(error.field).toBe("custom");
  });

  it.each(UNWRITABLE_TYPES)("rejects %s in a marker key", (_case, value) => {
    const comment = { id: 1, title: "t", created: TIMESTAMP, author: value, body: "" } as unknown as TaskComment;
    const error = serializeError(newTask({ comments: [comment] }));

    expect(error.code).toBe("key-type");
    expect(error.field).toBe("author");
  });

  it.each(UNWRITABLE_TYPES)("rejects %s inside the marker custom data", (_case, value) => {
    const comment = { id: 1, title: "t", created: TIMESTAMP, custom: { rows: value }, body: "" };
    const error = serializeError(newTask({ comments: [comment] }));

    expect(error.code).toBe("key-type");
    expect(error.field).toBe("custom");
  });
});

// Every value is copied out of the caller's object before it is validated, and
// every position is read once, so the value a check ran against is the value
// that reaches the file.
describe("a caller object that answers a second read with another value", () => {
  it("writes the frontmatter value the checks ran against", () => {
    const task = newTask();
    const frontmatter = { ...task.frontmatter };
    answersInTurn(frontmatter, "title", ["ok", 12345]);

    expect(parseTask(serializeTask({ ...task, frontmatter })).task.frontmatter.title).toBe("ok");
  });

  it("writes the nested value the checks ran against", () => {
    const task = newTask();
    const custom: Record<string, unknown> = {};
    answersInTurn(custom, "data", [{ ok: 1 }, unsafeMapping()]);

    const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, custom } });

    expect(parseTask(out).task.frontmatter.custom).toEqual({ data: { ok: 1 } });
  });

  it("writes the list position the checks ran against", () => {
    const task = newTask();
    const tags = ["a", "b"];
    answersInTurn(tags as unknown as Record<string, unknown>, "1", ["b", undefined]);

    const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, custom: { tags } } });

    expect(parseTask(out).task.frontmatter.custom).toEqual({ tags: ["a", "b"] });
  });

  it("checks the comment id the marker carries", () => {
    const second: Record<string, unknown> = { title: "Second", created: TIMESTAMP, body: "" };
    answersInTurn(second, "id", [1, 2]);
    const task = newTask({
      comments: [{ id: 1, title: "First", created: TIMESTAMP, body: "" }, second as unknown as TaskComment],
    });

    expect(serializeError(task).code).toBe("comment-id-duplicate");
  });
});

// The retained source is reachable through the exported symbol key, so the
// writer meets documents it did not read itself.
describe("a region the YAML library cannot write", () => {
  it("is reported as a region fault, with no key named", () => {
    const { task } = parseTask(fixture("valid/minimal.md"));
    task[SNAPSHOT]!.doc.set("notes", deepMapping(20000));

    const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, status: "Done" } });

    expect(error.code).toBe("region-unwritable");
    expect(error.message).toContain("the frontmatter cannot be written");
  });
});
