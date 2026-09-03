import { describe, expect, it } from "vitest";
import type { Frontmatter, IndexEntry } from "@tasma/engine";
import type { TaskFilter } from "@tasma/protocol";
import { assertNoQuery, readTaskFilter, readTaskOptions, selectEntries } from "../../src/tasks/filter.js";
import { refused, TIMESTAMP } from "../helpers.js";

function entry(id: string, frontmatter: Partial<Frontmatter> = {}): IndexEntry {
  return {
    id,
    path: `/tmp/${id}.md`,
    frontmatter: {
      id,
      title: id,
      status: "To Do",
      created: TIMESTAMP,
      updated: TIMESTAMP,
      next_comment_id: 1,
      ...frontmatter,
    },
  };
}

function query(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

function ids(entries: IndexEntry[], filter: TaskFilter, blocked: ReadonlySet<string> = new Set()): string[] {
  return selectEntries(entries, filter, blocked).map((found) => found.id);
}

describe("readTaskFilter", () => {
  it("reads every key the listing declares", () => {
    const read = readTaskFilter(query("status=To+Do&priority=high&label=dev&label=ui&parent=T-1&step=review&blocked=true"));

    expect(read).toEqual({
      status: "To Do",
      priority: "high",
      label: ["dev", "ui"],
      parent: "T-1",
      step: "review",
      blocked: true,
    });
  });

  it("reads a query that states nothing as no filter at all", () => {
    expect(readTaskFilter(query(""))).toEqual({
      status: undefined,
      priority: undefined,
      label: undefined,
      parent: undefined,
      step: undefined,
      blocked: undefined,
    });
  });

  it("reads blocked=false as the filter for the unblocked", () => {
    expect(readTaskFilter(query("blocked=false")).blocked).toBe(false);
  });

  it.each([
    ["a text key", "status=", "status"],
    ["a repeatable key", "label=", "label"],
    ["a boolean key", "blocked=", "blocked"],
  ])("drops the empty value of %s", (_description, search, key) => {
    expect(readTaskFilter(query(search))[key as keyof TaskFilter]).toBeUndefined();
  });

  it("keeps the values of a repeatable key that survive, and drops the empty one", () => {
    expect(readTaskFilter(query("label=dev&label=&label=ui")).label).toEqual(["dev", "ui"]);
  });

  it("refuses a key the route does not declare, and names it", () => {
    const error = refused(() => readTaskFilter(query("stauts=To+Do")));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain("stauts");
  });

  it("refuses a key that names a property of the prototype chain", () => {
    expect(refused(() => readTaskFilter(query("toString=1"))).code).toBe("malformed-request");
  });

  it("refuses a single-value key given twice", () => {
    const error = refused(() => readTaskFilter(query("status=A&status=B")));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain("status");
  });

  it("refuses a boolean key given twice", () => {
    expect(refused(() => readTaskFilter(query("blocked=true&blocked=false"))).code).toBe("malformed-request");
  });

  it.each(["yes", "1", "TRUE"])("refuses blocked=%s, which is neither true nor false", (value) => {
    const error = refused(() => readTaskFilter(query(`blocked=${value}`)));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain("blocked");
  });
});

describe("readTaskOptions", () => {
  it.each([
    ["true", true],
    ["false", false],
  ])("reads comments=%s", (value, expected) => {
    expect(readTaskOptions(query(`comments=${value}`))).toEqual({ comments: expected });
  });

  it("reads a query that states nothing as no option", () => {
    expect(readTaskOptions(query(""))).toEqual({ comments: undefined });
  });

  it("refuses a comments that is neither true nor false", () => {
    expect(refused(() => readTaskOptions(query("comments=none"))).code).toBe("malformed-request");
  });

  it("refuses a key the read does not declare", () => {
    const error = refused(() => readTaskOptions(query("status=To+Do")));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain("status");
  });
});

describe("assertNoQuery", () => {
  it("passes a request that states no query at all", () => {
    expect(() => assertNoQuery(query(""))).not.toThrow();
  });

  it("refuses any key, and names it", () => {
    const error = refused(() => assertNoQuery(query("comments=false")));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain("comments");
  });
});

describe("selectEntries", () => {
  const entries = [
    entry("T-1", { status: "To Do", priority: "high", labels: ["dev", "ui"], parent: "T-9", step: "dev:review" }),
    entry("T-2", { status: "Done", labels: ["dev"] }),
    entry("T-3", { status: "In Progress", priority: "low" }),
  ];

  it("returns every entry when the filter states nothing", () => {
    expect(ids(entries, {})).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("compares status without regard to case", () => {
    expect(ids(entries, { status: "to do" })).toEqual(["T-1"]);
  });

  it("compares priority without regard to case", () => {
    expect(ids(entries, { priority: "HIGH" })).toEqual(["T-1"]);
  });

  it("passes over an entry that carries no priority at all", () => {
    expect(ids(entries, { priority: "high" })).toEqual(["T-1"]);
  });

  it("keeps only an entry carrying every label listed", () => {
    expect(ids(entries, { label: ["dev", "ui"] })).toEqual(["T-1"]);
    expect(ids(entries, { label: ["dev"] })).toEqual(["T-1", "T-2"]);
  });

  it("lowercases each label before comparing, the rule the store writes them under", () => {
    expect(ids(entries, { label: ["DEV"] })).toEqual(["T-1", "T-2"]);
  });

  it("passes over an entry that carries no labels at all", () => {
    expect(ids(entries, { label: ["dev"] })).not.toContain("T-3");
  });

  it("compares parent exactly", () => {
    expect(ids(entries, { parent: "T-9" })).toEqual(["T-1"]);
    expect(ids(entries, { parent: "t-9" })).toEqual([]);
  });

  it("compares step exactly", () => {
    expect(ids(entries, { step: "dev:review" })).toEqual(["T-1"]);
    expect(ids(entries, { step: "DEV:REVIEW" })).toEqual([]);
  });

  it("keeps the blocked entries alone under blocked=true", () => {
    expect(ids(entries, { blocked: true }, new Set(["T-2"]))).toEqual(["T-2"]);
  });

  it("keeps the unblocked entries alone under blocked=false", () => {
    expect(ids(entries, { blocked: false }, new Set(["T-2"]))).toEqual(["T-1", "T-3"]);
  });

  it("applies two filters together", () => {
    expect(ids(entries, { label: ["dev"], status: "Done" })).toEqual(["T-2"]);
  });
});
