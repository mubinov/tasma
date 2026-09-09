import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import {
  applyClears,
  flagsGiven,
  keyOf,
  refuseAppend,
  refuseClears,
  refuseEmpty,
  refuseNoChange,
} from "../../src/commands/change.js";
import type { Fields } from "../../src/commands/change.js";
import { capture, HINT } from "../helpers.js";

/** A family whose flags are spelled differently from the keys they set, as the task writes are. */
const TASK: Fields = {
  flags: ["title", "priority", "label", "blocked-by"],
  keys: { "label": "labels", "blocked-by": "blocked_by" },
  clearable: ["priority", "labels", "blocked_by", "body"],
};

/** A family whose every flag spells its key exactly, as the comment writes are. */
const COMMENT: Fields = {
  flags: ["title", "author", "collapsed"],
  clearable: ["author", "collapsed", "body"],
};

/** What one rule wrote, and the code it answered with. */
function ran(run: (io: ReturnType<typeof capture>["io"]) => number | undefined): { code?: number; err: string } {
  const { io, err } = capture();

  return { code: run(io), err: err.join("") };
}

describe("refuseEmpty", () => {
  it("passes over an invocation whose every value stands", () => {
    const { code, err } = ran((io) => refuseEmpty(io, TASK, { title: "New", label: ["infra"] }, true));

    expect(code).toBeUndefined();
    expect(err).toBe("");
  });

  it("refuses an empty value, in either family, naming the flag that was typed", () => {
    expect(ran((io) => refuseEmpty(io, TASK, { title: "" }, true)))
      .toEqual({ code: 2, err: `tasma: --title needs a value\n${HINT}` });
    expect(ran((io) => refuseEmpty(io, COMMENT, { author: "" }, false)))
      .toEqual({ code: 2, err: `tasma: --author needs a value\n${HINT}` });
  });

  it("refuses an empty member of a repeated flag", () => {
    const { err } = ran((io) => refuseEmpty(io, TASK, { label: ["infra", ""] }, false));

    expect(err).toBe(`tasma: --label needs a value\n${HINT}`);
  });

  // The hint names the field as the file spells it, which is the name --clear
  // takes rather than the flag that was typed.
  it("names the clear that removes the field, in the spelling the clear takes", () => {
    expect(ran((io) => refuseEmpty(io, TASK, { "blocked-by": [""] }, true)).err)
      .toBe(`tasma: --blocked-by needs a value; --clear blocked_by removes the field\n${HINT}`);
    expect(ran((io) => refuseEmpty(io, COMMENT, { author: "" }, true)).err)
      .toBe(`tasma: --author needs a value; --clear author removes the field\n${HINT}`);
  });

  // A create and an add carry no --clear, so a hint pointing at one would name a
  // flag those verbs refuse.
  it("names no clear where the verb accepts none, and none for a field no clear removes", () => {
    expect(ran((io) => refuseEmpty(io, TASK, { priority: "" }, false)).err)
      .toBe(`tasma: --priority needs a value\n${HINT}`);
    expect(ran((io) => refuseEmpty(io, TASK, { title: "" }, true)).err)
      .toBe(`tasma: --title needs a value\n${HINT}`);
  });

  // `--collapsed` is a boolean, which can never be empty, and it stands in the
  // list because the setter map is derived from it.
  it("passes over a value of any other type", () => {
    const { code, err } = ran((io) => refuseEmpty(io, COMMENT, { collapsed: true }, true));

    expect(code).toBeUndefined();
    expect(err).toBe("");
  });

  // The same invocation reports the same line however its flags were ordered on
  // the command line.
  it("reports the first flag the family lists, not the first one typed", () => {
    const { err } = ran((io) => refuseEmpty(io, TASK, { priority: "", title: "" }, false));

    expect(err).toBe(`tasma: --title needs a value\n${HINT}`);
  });
});

describe("refuseClears", () => {
  it("passes over an invocation that clears nothing, and one that clears a field it may", () => {
    expect(ran((io) => refuseClears(io, TASK, [], new Set())).code).toBeUndefined();
    expect(ran((io) => refuseClears(io, COMMENT, ["author", "body"], new Set(["--title"]))).code).toBeUndefined();
  });

  it("refuses a clear that names no field", () => {
    expect(ran((io) => refuseClears(io, COMMENT, [""], new Set())))
      .toEqual({ code: 2, err: `tasma: --clear needs a field\n${HINT}` });
  });

  it("refuses a field the family cannot remove", () => {
    expect(ran((io) => refuseClears(io, COMMENT, ["title"], new Set())).err)
      .toBe(`tasma: not a clearable field: title\n${HINT}`);
    expect(ran((io) => refuseClears(io, TASK, ["x"], new Set())).err)
      .toBe(`tasma: not a clearable field: x\n${HINT}`);
  });

  // Two values for one field: which one wins is not something the caller stated.
  it("refuses a clear beside the flag that sets the same field, in the spelling that was typed", () => {
    expect(ran((io) => refuseClears(io, TASK, ["labels"], new Set(["--label"]))).err)
      .toBe(`tasma: --clear labels and --label exclude each other\n${HINT}`);
    expect(ran((io) => refuseClears(io, COMMENT, ["author"], new Set(["--author"]))).err)
      .toBe(`tasma: --clear author and --author exclude each other\n${HINT}`);
  });

  // The body's two flags belong to no family's list: every write family states a
  // body the same way.
  it("refuses a cleared body beside either flag that states one", () => {
    expect(ran((io) => refuseClears(io, COMMENT, ["body"], new Set(["--body"]))).err)
      .toBe(`tasma: --clear body and --body exclude each other\n${HINT}`);
    expect(ran((io) => refuseClears(io, TASK, ["body"], new Set(["--body-file"]))).err)
      .toBe(`tasma: --clear body and --body-file exclude each other\n${HINT}`);
  });

  it("takes a field named twice as the one clear it states", () => {
    const { code, err } = ran((io) => refuseClears(io, COMMENT, ["author", "author"], new Set()));

    expect(code).toBeUndefined();
    expect(err).toBe("");
  });
});

describe("flagsGiven", () => {
  it("names each key the parser answered with as the flag that was typed", () => {
    expect(flagsGiven({ "title": "New", "blocked-by": ["TASM-3"] })).toEqual(new Set(["--title", "--blocked-by"]));
  });

  it("names none where the parser answered no key at all", () => {
    expect(flagsGiven({})).toEqual(new Set());
  });
});

describe("keyOf", () => {
  it("answers the key a family maps the flag to, and the flag itself where it maps none", () => {
    expect(keyOf(TASK, "blocked-by")).toBe("blocked_by");
    expect(keyOf(TASK, "priority")).toBe("priority");
    expect(keyOf(COMMENT, "author")).toBe("author");
  });
});

describe("refuseAppend", () => {
  it("passes over an invocation that appends nothing, whatever else it states", () => {
    expect(ran((io) => refuseAppend(io, false, undefined, ["body"])).code).toBeUndefined();
    expect(ran((io) => refuseAppend(io, true, "more", [])).code).toBeUndefined();
  });

  // Adding to a body the same invocation removes states two outcomes for one field.
  it("refuses an append beside a cleared body", () => {
    expect(ran((io) => refuseAppend(io, true, "more", ["body"])))
      .toEqual({ code: 2, err: `tasma: --append and --clear body exclude each other\n${HINT}` });
  });

  it("refuses an append carrying no text to add", () => {
    expect(ran((io) => refuseAppend(io, true, undefined, [])))
      .toEqual({ code: 2, err: `tasma: --append needs --body or --body-file\n${HINT}` });
  });
});

describe("applyClears", () => {
  it("writes every cleared field as the removal the wire spells null", () => {
    const change: Record<string, unknown> = { title: "New" };

    applyClears(change, ["author", "body"]);

    expect(change).toEqual({ title: "New", author: null, body: null });
  });

  it("leaves a change that clears nothing as it stands", () => {
    const change: Record<string, unknown> = { title: "New" };

    applyClears(change, []);

    expect(change).toEqual({ title: "New" });
  });
});

describe("refuseNoChange", () => {
  it("passes over an invocation stating a field, and over one stating a body alone", () => {
    expect(ran((io) => refuseNoChange(io, "task edit", { title: "New" }, undefined)).code).toBeUndefined();
    expect(ran((io) => refuseNoChange(io, "comment edit", {}, "")).code).toBeUndefined();
  });

  it("refuses an invocation stating neither, naming the verb that was typed", () => {
    expect(ran((io) => refuseNoChange(io, "comment edit", {}, undefined)))
      .toEqual({ code: 2, err: `tasma: comment edit needs a change\n${HINT}` });
    expect(ran((io) => refuseNoChange(io, "task edit", {}, undefined)).err)
      .toBe(`tasma: task edit needs a change\n${HINT}`);
  });
});
