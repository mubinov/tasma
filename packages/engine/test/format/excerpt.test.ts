import { describe, expect, it } from "vitest";
import { commentRegion, parseTask, type Task, type TaskComment, withoutCollapsedBodies } from "@tasma/engine";
import { fixture } from "./fixtures.js";

const STAMP = "2026-05-01T00:00:00+03:00";

const EXAMPLE = fixture("valid/example.md");

/** The body of the collapsed comment of `valid/example.md`, which runs to the end of the file. */
const COLLAPSED_BODY = "\nBody of comment 2. The last comment runs to the end of the file.\n";

/** A file whose collapsed comment is followed by another, so a cut runs between two markers. */
const MIDDLE = `---
id: PROJ-7
title: "A collapsed comment in the middle"
status: To Do
created: "${STAMP}"
updated: "${STAMP}"
next_comment_id: 3
---

Body.

<!-- task:comment {id: 1, title: "One", created: "${STAMP}", collapsed: true} -->

Hidden body.

<!-- task:comment {id: 2, title: "Two", created: "${STAMP}"} -->

Kept body.
`;

/** Two collapsed comments with an uncollapsed one between them, so a second cut starts where the first ended. */
const TWO_COLLAPSED = `---
id: PROJ-9
title: "Two collapsed comments around one that is not"
status: To Do
created: "${STAMP}"
updated: "${STAMP}"
next_comment_id: 4
---

Body.

<!-- task:comment {id: 1, title: "One", created: "${STAMP}", collapsed: true} -->

First hidden body.

<!-- task:comment {id: 2, title: "Two", created: "${STAMP}"} -->

Kept body.

<!-- task:comment {id: 3, title: "Three", created: "${STAMP}", collapsed: true} -->

Second hidden body.
`;

/** The same, with the marker of the collapsed comment closing the file. */
const EMPTY_BODY = `---
id: PROJ-8
title: "A collapsed comment with no body"
status: To Do
created: "${STAMP}"
updated: "${STAMP}"
next_comment_id: 2
---

Body.

<!-- task:comment {id: 1, title: "One", created: "${STAMP}", collapsed: true} -->
`;

function taskOf(text: string): Task {
  return parseTask(text).task;
}

function commentOf(text: string, id: number): TaskComment {
  const found = taskOf(text).comments.find((comment) => comment.id === id);
  if (found === undefined) throw new Error(`the fixture carries no comment ${id}`);
  return found;
}

/** The same comment after a JSON round trip, which drops the source it was read from. */
function throughJson(comment: TaskComment): TaskComment {
  return JSON.parse(JSON.stringify(comment)) as TaskComment;
}

describe("withoutCollapsedBodies", () => {
  it("leaves out the body of a collapsed comment and keeps its marker byte for byte", () => {
    const cut = withoutCollapsedBodies(EXAMPLE, taskOf(EXAMPLE));

    expect(cut.text).toBe(EXAMPLE.replace(COLLAPSED_BODY, ""));
    expect(cut.hidden).toEqual([2]);
  });

  it("answers with a file that parses as the same comment carrying an empty body", () => {
    const { task } = parseTask(withoutCollapsedBodies(EXAMPLE, taskOf(EXAMPLE)).text);

    expect(task.comments.map((comment) => comment.id)).toEqual([1, 2]);
    expect(task.comments[1]?.body).toBe("");
  });

  it("cuts between two markers, leaving the comment that follows whole", () => {
    const cut = withoutCollapsedBodies(MIDDLE, taskOf(MIDDLE));

    expect(cut.text).toBe(MIDDLE.replace("\nHidden body.\n\n", ""));
    expect(cut.hidden).toEqual([1]);
    expect(parseTask(cut.text).task.comments[1]?.body).toBe("\nKept body.\n");
  });

  it("leaves out every collapsed body and names them in file order", () => {
    const cut = withoutCollapsedBodies(TWO_COLLAPSED, taskOf(TWO_COLLAPSED));

    expect(cut.text).toBe(
      TWO_COLLAPSED.replace("\nFirst hidden body.\n\n", "").replace("\nSecond hidden body.\n", ""),
    );
    expect(cut.hidden).toEqual([1, 3]);
    expect(parseTask(cut.text).task.comments.map((comment) => comment.body)).toEqual(["", "\nKept body.\n\n", ""]);
  });

  it.each(["valid/no-comments.md", "valid/self-referential.md"])(
    "leaves %s unchanged, where nothing is collapsed",
    (name) => {
      const text = fixture(name);

      expect(withoutCollapsedBodies(text, taskOf(text))).toEqual({ text, hidden: [] });
    },
  );

  it("names a collapsed comment whose body is already empty, and changes nothing", () => {
    expect(withoutCollapsedBodies(EMPTY_BODY, taskOf(EMPTY_BODY))).toEqual({ text: EMPTY_BODY, hidden: [1] });
  });

  it("keeps the carriage returns of a file whose lines end with CRLF", () => {
    const text = EXAMPLE.replaceAll("\n", "\r\n");

    const cut = withoutCollapsedBodies(text, taskOf(text));

    expect(cut.text).toBe(text.replace(COLLAPSED_BODY.replaceAll("\n", "\r\n"), ""));
    expect(cut.text.endsWith("-->\r\n")).toBe(true);
  });

  it("throws over a comment that lost the source it was read from, naming it", () => {
    const task = taskOf(EXAMPLE);
    const stripped: Task = { ...task, comments: task.comments.map(throughJson) };

    expect(() => withoutCollapsedBodies(EXAMPLE, stripped)).toThrow(/comment 2/);
  });

  it("throws over a comment a caller wrote as a literal", () => {
    const task = taskOf(EXAMPLE);
    const literal: TaskComment = { id: 4, title: "Literal", created: STAMP, collapsed: true, body: "" };

    expect(() => withoutCollapsedBodies(EXAMPLE, { ...task, comments: [literal] })).toThrow(/comment 4/);
  });
});

describe("commentRegion", () => {
  it("answers with the marker and the body of a flow-style comment", () => {
    const region = commentRegion(EXAMPLE, commentOf(EXAMPLE, 1));

    // From the first marker to the start of the second, which is where the body ends.
    expect(region).toBe(EXAMPLE.slice(EXAMPLE.indexOf("<!-- task:comment {"), EXAMPLE.indexOf("<!-- task:comment\n")));
    expect(region).toContain("Body of comment 1");
  });

  it("answers with the marker and the body of a block-style comment that closes the file", () => {
    const region = commentRegion(EXAMPLE, commentOf(EXAMPLE, 2));

    // From the second marker to the end of the file, which is where its body ends.
    expect(region).toBe(EXAMPLE.slice(EXAMPLE.indexOf("<!-- task:comment\n")));
    expect(region.endsWith(`-->\n${COLLAPSED_BODY}`)).toBe(true);
  });

  it("keeps a marker-shaped line the body holds inside a fence", () => {
    const text = fixture("valid/fences.md");

    const region = commentRegion(text, commentOf(text, 1));

    expect(region).toBe(text.slice(text.indexOf("<!-- task:comment {id: 1,")));
    expect(region).toContain("{id: 94,");
  });

  it("keeps the carriage returns of a file whose lines end with CRLF", () => {
    const text = EXAMPLE.replaceAll("\n", "\r\n");

    expect(commentRegion(text, commentOf(text, 2))).toContain("\r\n");
  });

  it("throws over a comment that lost the source it was read from, naming it", () => {
    expect(() => commentRegion(EXAMPLE, throughJson(commentOf(EXAMPLE, 1)))).toThrow(/comment 1/);
  });

  it("throws over a comment a caller wrote as a literal", () => {
    const literal: TaskComment = { id: 4, title: "Literal", created: STAMP, body: "" };

    expect(() => commentRegion(EXAMPLE, literal)).toThrow(/comment 4/);
  });
});
