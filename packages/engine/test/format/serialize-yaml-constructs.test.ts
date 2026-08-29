import { type Document, parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import { parseTask, serializeTask, SNAPSHOT } from "@tasma/engine";
import { fixture } from "./fixtures.js";
import { frontmatterWith, serializeError, taskWithBlockMarker, TIMESTAMP } from "./tasks.js";

/** A document the YAML library parses but refuses to read values out of. */
function aliasBomb(): Document {
  const rows = Array.from({ length: 12 }, (_row, index) =>
    index === 0 ? "a0: &a0 [x, x]" : `a${index}: &a${index} [*a${index - 1}, *a${index - 1}]`,
  );
  return parseDocument(rows.join("\n"));
}

// A key another key points at cannot be rewritten in place: the library
// either drops the anchor and leaves the alias unresolved, or keeps the
// anchor and changes the aliased value with it.
describe("a value another value points at", () => {
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

  // An anchor can sit on the key node instead of the value node. A change
  // keeps that node, so only a removal takes the anchor away with it.
  it("rejects the removal of a key whose key node carries the anchor", () => {
    const task = frontmatterWith("next_comment_id: 1", "&n step: dev\nparent: *n\nnext_comment_id: 1");
    const error = serializeError({ ...task, frontmatter: { ...task.frontmatter, step: undefined } });

    expect(error.code).toBe("anchor-aliased");
    expect(error.field).toBe("step");
  });

  it("writes a change to that key and keeps the anchor and the alias", () => {
    const task = frontmatterWith("next_comment_id: 1", "&n step: dev\nparent: *n\nnext_comment_id: 1");

    const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, step: "build" } });

    expect(out).toContain("&n step: build");
    expect(out).toContain("parent: *n");
    expect(parseTask(out).task.frontmatter.parent).toBe("step");
  });

  it("removes a key whose key node carries an anchor no alias reads", () => {
    const task = frontmatterWith(
      'created: "2026-01-01T00:00:00Z"',
      'created: &t "2026-01-01T00:00:00Z"\nmirror: *t\n&n step: dev',
    );

    const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, step: undefined } });

    expect(out).not.toContain("step:");
    expect(out).toContain("mirror: *t");
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
    expect(error.message).toBe("line 1: the frontmatter resolves a YAML merge key, so a change to it cannot be written");
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

// A key written as a number, a boolean or a null resolves to a name no schema
// key carries, so the writer never addresses it and never has to.
describe("a region that carries a key which is not a string", () => {
  const NUMBER_KEY_FRONTMATTER = fixture("valid/minimal.md").replace(
    "next_comment_id: 1",
    "2026: imported\nnext_comment_id: 1",
  );

  it("is written back byte for byte while nothing changes", () => {
    expect(serializeTask(parseTask(NUMBER_KEY_FRONTMATTER).task)).toBe(NUMBER_KEY_FRONTMATTER);
  });

  it("accepts a change to another key and leaves that key where it stands", () => {
    const { task } = parseTask(NUMBER_KEY_FRONTMATTER);

    const out = serializeTask({ ...task, frontmatter: { ...task.frontmatter, status: "Done" } });

    expect(out).toContain("2026: imported");
    expect(parseTask(out).task.frontmatter.status).toBe("Done");
  });
});

// The marker values every check reads come out of the same converter as the
// marker text, so no exception the YAML library raises reaches the caller.
describe("a region built from an anchor the library refuses to expand", () => {
  it("is reported as a region fault, with no key named", () => {
    const task = taskWithBlockMarker();
    task.comments[0]![SNAPSHOT]!.doc = aliasBomb();

    const error = serializeError(task);

    expect(error.code).toBe("region-unwritable");
    expect(error.message).toContain("the marker cannot be written");
  });
});
