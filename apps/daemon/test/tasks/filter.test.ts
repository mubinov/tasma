import { describe, expect, it } from "vitest";
import type { Frontmatter, ListedEntry } from "@tasma/engine";
import type { TaskFilter } from "@tasma/protocol";
import {
  assertNoQuery,
  readChatEventsQuery,
  readChatListQuery,
  readEventsQuery,
  readProjectQuery,
  readTaskFilter,
  readTaskOptions,
  readTextSelection,
  selectEntries,
} from "../../src/tasks/filter.js";
import { refused, TIMESTAMP } from "../helpers.js";

function entry(id: string, frontmatter: Partial<Frontmatter> = {}, blocked = false): ListedEntry {
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
    blocked,
  };
}

function query(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

function ids(entries: ListedEntry[], filter: TaskFilter): string[] {
  return selectEntries(entries, filter).map((found) => found.id);
}

describe("readTaskFilter", () => {
  it("reads every key the listing declares", () => {
    const read = readTaskFilter(
      query("status=To+Do&priority=high&label=dev&label=ui&parent=T-1&step=review&blocked=true&q=drag%20card"),
    );

    expect(read).toEqual({
      status: "To Do",
      priority: "high",
      label: ["dev", "ui"],
      parent: "T-1",
      step: "review",
      blocked: true,
      q: "drag card",
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
      q: undefined,
    });
  });

  it("keeps a text query of whitespace alone as it was sent", () => {
    expect(readTaskFilter(query("q=%20%20")).q).toBe("  ");
  });

  it("reads blocked=false as the filter for the unblocked", () => {
    expect(readTaskFilter(query("blocked=false")).blocked).toBe(false);
  });

  it.each([
    ["a text key", "status=", "status"],
    ["a repeatable key", "label=", "label"],
    ["a boolean key", "blocked=", "blocked"],
    ["the text query", "q=", "q"],
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

  it("refuses the text query given twice", () => {
    const error = refused(() => readTaskFilter(query("q=a&q=b")));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain('"q"');
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

describe("readTextSelection", () => {
  it("reads a query that states nothing as the whole file", () => {
    expect(readTextSelection(query(""))).toEqual({ collapsed: undefined });
  });

  it("reads collapsed=false as the selection that leaves the collapsed bodies out", () => {
    expect(readTextSelection(query("collapsed=false"))).toEqual({ collapsed: false });
  });

  it("reads collapsed=true as the whole file, which is what an absent key asks for", () => {
    expect(readTextSelection(query("collapsed=true"))).toEqual({ collapsed: true });
  });

  it("reads comment as the selection of that comment alone, stating no collapsed at all", () => {
    const selection = readTextSelection(query("comment=2"));

    expect(selection).toEqual({ comment: 2 });
    expect("collapsed" in selection).toBe(false);
  });

  it("refuses a key the route does not declare", () => {
    const error = refused(() => readTextSelection(query("comments=false")));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain("comments");
  });

  it.each(["collapsed", "comment"])("refuses %s given twice", (key) => {
    const error = refused(() => readTextSelection(query(`${key}=1&${key}=2`)));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain(key);
  });

  it("refuses a collapsed that is neither true nor false", () => {
    expect(refused(() => readTextSelection(query("collapsed=1"))).code).toBe("malformed-request");
  });

  it.each(["two", "2.5", "1e3", " 2"])("refuses comment=%s, which is no decimal integer", (value) => {
    expect(refused(() => readTextSelection(query(`comment=${encodeURIComponent(value)}`))).code)
      .toBe("malformed-request");
  });

  it("refuses the two keys together, which select different things", () => {
    const error = refused(() => readTextSelection(query("comment=2&collapsed=false")));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain("comment");
  });
});

describe("readProjectQuery", () => {
  it("reads the directory the resolution asks about", () => {
    expect(readProjectQuery(query("path=%2Fsrv%2Frepo"))).toBe("/srv/repo");
  });

  it("refuses a key the route does not declare", () => {
    const error = refused(() => readProjectQuery(query("dir=%2Fsrv%2Frepo")));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain("dir");
  });

  it("refuses the key stated twice, which names two directories", () => {
    expect(refused(() => readProjectQuery(query("path=%2Fa&path=%2Fb"))).code).toBe("malformed-request");
  });

  it.each([
    ["states no path at all", ""],
    ["states an empty path, which names nothing", "path="],
  ])("refuses a query that %s", (_name, search) => {
    const error = refused(() => readProjectQuery(query(search)));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain("path");
  });
});

describe("readEventsQuery", () => {
  it("reads the cursor a read of the feed starts after", () => {
    expect(readEventsQuery(query("after=4f0c9a1b2e3d-41"))).toEqual({ after: "4f0c9a1b2e3d-41" });
  });

  it.each([
    ["states no cursor", ""],
    ["states an empty cursor", "after="],
  ])("reads a query that %s as a read with no cursor", (_name, search) => {
    expect(readEventsQuery(query(search))).toEqual({ after: undefined });
  });

  it("refuses a key the route does not declare", () => {
    const error = refused(() => readEventsQuery(query("since=4f0c9a1b2e3d-41")));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain("since");
  });

  it("refuses the cursor stated twice", () => {
    expect(refused(() => readEventsQuery(query("after=a-1&after=a-2"))).code).toBe("malformed-request");
  });
});

describe("readChatEventsQuery", () => {
  it.each([
    ["0", 0],
    ["41", 41],
    ["007", 7],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])("reads after=%s as the seq %d", (value, after) => {
    expect(readChatEventsQuery(query(`after=${value}`))).toEqual({ after });
  });

  it.each([
    ["states no cursor", ""],
    ["states an empty cursor", "after="],
  ])("reads a query that %s as a read of the whole log", (_name, search) => {
    expect(readChatEventsQuery(query(search))).toEqual({ after: 0 });
  });

  it.each([
    ["a negative number", "-1"],
    ["a fraction", "1.5"],
    ["an exponent", "1e3"],
    ["a sign", "+1"],
    ["a space", " 1"],
    ["a word", "last"],
    ["a number above the safe-integer limit", "9007199254740992"],
  ])("refuses %s with malformed-request", (_name, value) => {
    const error = refused(() => readChatEventsQuery(query(`after=${encodeURIComponent(value)}`)));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain("after");
  });

  it("refuses a key the route does not declare", () => {
    const error = refused(() => readChatEventsQuery(query("since=1")));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain("since");
  });

  it("refuses the cursor stated twice", () => {
    expect(refused(() => readChatEventsQuery(query("after=1&after=2"))).code).toBe("malformed-request");
  });
});

describe("readChatListQuery", () => {
  it("reads every key the list declares", () => {
    expect(readChatListQuery(query("project=ALPHA&q=parse%20tree&after=c0ffee"))).toEqual({
      project: "ALPHA",
      q: "parse tree",
      after: "c0ffee",
    });
  });

  it.each([
    ["states nothing", ""],
    ["states every key empty", "project=&q=&after="],
  ])("reads a query that %s as the whole list from the start", (_name, search) => {
    expect(readChatListQuery(query(search))).toEqual({ project: undefined, q: undefined, after: undefined });
  });

  it("refuses a key the list does not declare, and names it", () => {
    const error = refused(() => readChatListQuery(query("status=Done")));

    expect(error.code).toBe("malformed-request");
    expect(error.message).toContain("status");
  });

  it.each(["project", "q", "after"])("refuses %s stated twice", (key) => {
    expect(refused(() => readChatListQuery(query(`${key}=a&${key}=b`))).code).toBe("malformed-request");
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
    entry("T-2", { status: "Done", labels: ["dev"] }, true),
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
    expect(ids(entries, { blocked: true })).toEqual(["T-2"]);
  });

  it("keeps the unblocked entries alone under blocked=false", () => {
    expect(ids(entries, { blocked: false })).toEqual(["T-1", "T-3"]);
  });

  it("applies two filters together", () => {
    expect(ids(entries, { label: ["dev"], status: "Done" })).toEqual(["T-2"]);
  });
});
