import type { Frontmatter, TaskEntry } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { blockingRows, customLines, formatMinutes, formatStamp, relationRows, type RelationRow } from "../../src/lib/task-page";

function frontmatter(fields: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: "SAGA-3",
    title: "Build the parser",
    status: "In Progress",
    created: "2026-09-01T10:00:00Z",
    updated: "2026-09-01T10:00:00Z",
    next_comment_id: 1,
    ...fields,
  };
}

function entry(id: string, status: string, title: string): TaskEntry {
  return { id, path: `/repos/saga/tasks/${id}.md`, blocked: false, frontmatter: frontmatter({ id, status, title }) };
}

const FINAL = ["Done", "Dropped"];

describe("formatMinutes", () => {
  it("writes the minute in the local time zone, padded", () => {
    expect(formatMinutes(new Date(2026, 8, 13, 16, 42, 59).toISOString())).toBe("16:42");
    expect(formatMinutes(new Date(2026, 0, 5, 7, 3).toISOString())).toBe("07:03");
  });

  it.each([{ value: "" }, { value: "yesterday" }])("returns \"$value\" as written, since it is no date", ({ value }) => {
    expect(formatMinutes(value)).toBe(value);
  });
});

describe("formatStamp", () => {
  it("writes the date and the minute in the local time zone", () => {
    const local = new Date(2026, 8, 13, 16, 42, 59);

    expect(formatStamp(local.toISOString())).toBe("2026-09-13 16:42");
  });

  it("pads a month, a day, an hour and a minute of one digit", () => {
    const local = new Date(2026, 0, 5, 7, 3);

    expect(formatStamp(local.toISOString())).toBe("2026-01-05 07:03");
  });

  it.each([{ value: "" }, { value: "yesterday" }, { value: "2026-13-45T99:00:00Z" }])(
    "returns \"$value\" as written, since it is no date",
    ({ value }) => {
      expect(formatStamp(value)).toBe(value);
    },
  );
});

describe("relationRows", () => {
  const ENTRIES = [
    entry("SAGA-1", "done", "Write the grammar"),
    entry("SAGA-2", "In Progress", "Lex the input"),
    entry("SAGA-7", "Backlog", "Ship the parser"),
  ];

  it("reads a blocker in a final status, matched ignoring case, as resolved", () => {
    const { blockers } = relationRows(frontmatter({ blocked_by: ["SAGA-1"] }), ENTRIES, FINAL);

    expect(blockers).toEqual([{ id: "SAGA-1", state: "resolved", status: "done", title: "Write the grammar" }]);
  });

  it("reads a blocker in an open status as blocking", () => {
    const { blockers } = relationRows(frontmatter({ blocked_by: ["SAGA-2"] }), ENTRIES, FINAL);

    expect(blockers).toEqual([{ id: "SAGA-2", state: "blocking", status: "In Progress", title: "Lex the input" }]);
  });

  it("reads a blocker the listing does not hold, another project's included, as blocking with no status", () => {
    const { blockers } = relationRows(frontmatter({ blocked_by: ["SAGA-40", "LOOM-4"] }), ENTRIES, FINAL);

    expect(blockers).toEqual([{ id: "SAGA-40", state: "blocking" }, { id: "LOOM-4", state: "blocking" }]);
  });

  it("keeps the order of blocked_by", () => {
    const { blockers } = relationRows(frontmatter({ blocked_by: ["SAGA-7", "SAGA-1", "SAGA-2"] }), ENTRIES, FINAL);

    expect(blockers.map((row) => row.id)).toEqual(["SAGA-7", "SAGA-1", "SAGA-2"]);
  });

  it("reads the parent as neutral, with the status and the title of its entry", () => {
    const { parent } = relationRows(frontmatter({ parent: "SAGA-7" }), ENTRIES, FINAL);

    expect(parent).toEqual({ id: "SAGA-7", state: "neutral", status: "Backlog", title: "Ship the parser" });
  });

  it("gives a parent the listing does not hold no status", () => {
    const { parent } = relationRows(frontmatter({ parent: "LOOM-4" }), ENTRIES, FINAL);

    expect(parent).toEqual({ id: "LOOM-4", state: "neutral" });
  });

  it("gives no rows and no parent to a task with no blocked_by and no parent", () => {
    expect(relationRows(frontmatter(), ENTRIES, FINAL)).toEqual({ blockers: [], parent: null });
  });
});

describe("blockingRows", () => {
  it("returns the blocking rows, in order", () => {
    const rows: RelationRow[] = [
      { id: "SAGA-9", state: "blocking" },
      { id: "SAGA-1", state: "resolved", status: "Done", title: "Write the grammar" },
      { id: "SAGA-2", state: "blocking", status: "In Progress", title: "Lex the input" },
    ];

    expect(blockingRows(rows)).toEqual([
      { id: "SAGA-9", state: "blocking" },
      { id: "SAGA-2", state: "blocking", status: "In Progress", title: "Lex the input" },
    ]);
  });

  it("returns no row when no row blocks", () => {
    expect(blockingRows([{ id: "SAGA-1", state: "resolved", status: "Done", title: "Write the grammar" }])).toEqual([]);
  });
});

describe("customLines", () => {
  it("writes a string, a number, a boolean and null as written", () => {
    expect(customLines({ owner: "reviewer", rounds: 2, urgent: false, due: null })).toEqual([
      "owner: reviewer",
      "rounds: 2",
      "urgent: false",
      "due: null",
    ]);
  });

  it("writes an object and a list as compact JSON", () => {
    expect(customLines({ review: { rounds: 1, by: "bot" }, tags: ["a", 2] })).toEqual([
      "review: {\"rounds\":1,\"by\":\"bot\"}",
      "tags: [\"a\",2]",
    ]);
  });
});
