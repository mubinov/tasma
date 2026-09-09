import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { CLEARABLE, comment } from "../../src/commands/comment.js";
import type { Command } from "../../src/types.js";
import { at, capture, HEALTH, HINT, ok, runCommand, scratchFile } from "../helpers.js";
import type { Ran } from "../helpers.js";

/** Runs a verb of this noun against a server answering the table, and reports what it wrote. */
function runComment(
  args: string[],
  table: Record<string, unknown> = {},
  options: { stdin?: string } = {},
): Promise<Ran> {
  return runCommand(comment, args, table, options);
}

/** The call a verb made, as the server saw it, for a case asserting the call rather than the answer. */
async function pathOf(args: string[]): Promise<string> {
  const { seen } = await runComment(args);

  return seen[0] ?? "";
}

/** Asserts that an invocation was refused from argv alone, with the line it names and no call made. */
async function refuses(args: string[], line: string): Promise<void> {
  const { code, out, err, seen } = await runComment(args);

  expect(code, args.join(" ")).toBe(2);
  expect(out, args.join(" ")).toBe("");
  expect(err, args.join(" ")).toBe(`tasma: ${line}\n${HINT}`);
  expect(seen, args.join(" ")).toEqual([]);
}

/**
 * The object one write sent, for a case asserting the request rather than the
 * answer. The write is the last call of an invocation, behind the probe that
 * proved the address and behind the read an append makes.
 */
async function sent(
  args: string[],
  table: Record<string, unknown>,
  options: { stdin?: string } = {},
): Promise<unknown> {
  const { bodies } = await runComment(args, table, options);

  return bodies.at(-1);
}

const MAP = "GET /projects/TASM/tasks/TASM-1/comments";
const TEXT = "GET /projects/TASM/tasks/TASM-1/text?comment=3";
const ADDED = "POST /projects/TASM/tasks/TASM-1/comments";

const UPDATED = "PATCH /projects/TASM/tasks/TASM-1/comments/3";
const DELETED = "DELETE /projects/TASM/tasks/TASM-1/comments/3";
const READ = "GET /projects/TASM/tasks/TASM-1";

/** The whole invocation an add needs before any flag under test. */
const ADD = ["add", "TASM-1", "--title", "Smoke"];

/** What a write of the planted comment answers: the task it belongs to, and its own id. */
const ISSUED = ok({ id: "TASM-1", commentId: 3 });

/** The task an append reads, holding the comment the write then changes. */
const STORED = ok({ frontmatter: { id: "TASM-1" }, comments: [{ id: 1, body: "other" }, { id: 3, body: "stored\n" }] });

describe("comment list", () => {
  it("prints the id, the lines, the size, whether it is collapsed, and who wrote what when", async () => {
    const { code, out, err } = await runComment(["list", "TASM-1"], {
      [MAP]: ok([
        {
          id: 1,
          lines: { start: 40, end: 58 },
          bytes: 1204,
          created: "2026-09-06T13:49:00+02:00",
          author: "almaz",
          title: "Dev notes #1",
        },
        {
          id: 2,
          lines: { start: 60, end: 131 },
          bytes: 9871,
          collapsed: true,
          created: "2026-09-06T14:04:00+02:00",
          title: "Review #1: FAIL",
        },
      ]),
    });

    expect(code).toBe(0);
    expect(out).toBe(
      "1  40-58   1204  -          2026-09-06T13:49:00+02:00  almaz  Dev notes #1\n"
      + "2  60-131  9871  collapsed  2026-09-06T14:04:00+02:00  -      Review #1: FAIL\n",
    );
    expect(err).toBe("");
  });

  it("asks the comment route of the task the id names", async () => {
    expect(await pathOf(["list", "TASM-1"])).toBe(MAP);
  });

  // A comment that went through JSON without its parsed source carries no range.
  it("marks a comment whose header carries no line range", async () => {
    const { out } = await runComment(["list", "TASM-1"], { [MAP]: ok([{ id: 1, bytes: 4, created: "x", title: "t" }]) });

    expect(out).toBe("1  -  4  -  x  -  t\n");
  });

  it("prints nothing at all for a task with no comments", async () => {
    const { code, out, err } = await runComment(["list", "TASM-1"], { [MAP]: ok([]) });

    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toBe("");
  });

  it("refuses an answer that is not a comment map", async () => {
    const { code, err } = await runComment(["list", "TASM-1"], { [MAP]: ok({ id: 1 }) });

    expect(code).toBe(3);
    expect(err).toContain("answered, but not with a comment map");
  });

  it("refuses a verb given no task id, one given more than it takes, and an unknown flag", async () => {
    await refuses(["list"], "comment list needs a task id");
    await refuses(["list", "a/b"], "not a task id: a/b");
    await refuses(["list", "TASM-1", "TASM-2"], "comment list takes one argument: TASM-2");

    const { code, err } = await runComment(["list", "--nope"]);

    expect(code).toBe(2);
    expect(err).toContain("tasma: Unknown option '--nope'");
  });
});

describe("comment view", () => {
  it("asks for the one comment, and prints it alone", async () => {
    const { code, out, err, seen } = await runComment(["view", "TASM-1", "3"],
      { [TEXT]: ok({ text: "<!-- m -->\n\nbody", hidden: [] }) });

    expect(code).toBe(0);
    expect(seen).toEqual([TEXT]);
    expect(out).toBe("<!-- m -->\n\nbody\n");
    expect(err).toBe("");
  });

  it("adds no second break to a comment whose text ends with one", async () => {
    const { out } = await runComment(["view", "TASM-1", "3"], { [TEXT]: ok({ text: "body\n", hidden: [] }) });

    expect(out).toBe("body\n");
  });

  // The format holds an id as an integer, so a file can carry comment 0 even
  // though no add ever issues it, and 0 is the code a printed read exits with.
  it("reads comment 0 as an id, not as the code of a verb that already answered", async () => {
    const zero = "GET /projects/TASM/tasks/TASM-1/text?comment=0";
    const { code, out, err, seen } = await runComment(["view", "TASM-1", "0"],
      { [zero]: ok({ text: "body", hidden: [] }) });

    expect(code).toBe(0);
    expect(seen).toEqual([zero]);
    expect(out).toBe("body\n");
    expect(err).toBe("");
  });

  // The hint belongs to the default task view, which is the read that left a body
  // out. A comment read alone left nothing out, whatever the route reports.
  it("writes no collapsed hint for a comment the route reports as hidden", async () => {
    const { code, out, err } = await runComment(["view", "TASM-1", "3"], { [TEXT]: ok({ text: "body", hidden: [3] }) });

    expect(code).toBe(0);
    expect(out).toBe("body\n");
    expect(err).toBe("");
  });

  it("refuses a comment id that is not a whole number the daemon can carry", async () => {
    for (const id of ["x", "1.5", "9007199254740993"]) {
      await refuses(["view", "TASM-1", id], `not a comment id: ${id}`);
    }
  });

  it("refuses a verb given no comment id, one given more than it takes, and a task id naming no tag", async () => {
    await refuses(["view", "TASM-1"], "comment view needs a comment id");
    await refuses(["view", "TASM-1", "3", "4"], "comment view takes two arguments: 4");
    await refuses(["view", "foo", "3"], "not a task id: foo");
  });

  it("refuses an answer that is not a task's text", async () => {
    for (const data of [{ text: 1, hidden: [] }, { text: "x", hidden: 2 }, "x"]) {
      const { code, out, err } = await runComment(["view", "TASM-1", "3"], { [TEXT]: ok(data) });

      expect(code).toBe(3);
      expect(out).toBe("");
      expect(err).toContain("answered, but not with a task's text");
    }
  });
});

describe("comment add", () => {
  it("sends the title alone where no other flag was typed", async () => {
    expect(await sent(ADD, { [ADDED]: ISSUED })).toEqual({ title: "Smoke" });
  });

  it("sends each field flag as its own key, with the value as it was typed", async () => {
    expect(await sent([...ADD, "--author", "Almaz M"], { [ADDED]: ISSUED })).toEqual({
      title: "Smoke",
      author: "Almaz M",
    });
  });

  // An explicit false would leave a key in the marker meaning what no key means,
  // and the engine's reader tests for the key.
  it("sends --collapsed as true, and no key at all where it was left out", async () => {
    expect(await sent([...ADD, "--collapsed"], { [ADDED]: ISSUED })).toEqual({ title: "Smoke", collapsed: true });
    expect(await sent(ADD, { [ADDED]: ISSUED })).toEqual({ title: "Smoke" });
  });

  it("sends the body from a flag, from a file and from standard input", async () => {
    const path = scratchFile("From a file\n");

    expect(await sent([...ADD, "--body", "A body"], { [ADDED]: ISSUED })).toEqual({ title: "Smoke", body: "A body" });
    expect(await sent([...ADD, "--body-file", path], { [ADDED]: ISSUED }))
      .toEqual({ title: "Smoke", body: "From a file\n" });
    expect(await sent([...ADD, "--body-file", "-"], { [ADDED]: ISSUED }, { stdin: "From a pipe\n" }))
      .toEqual({ title: "Smoke", body: "From a pipe\n" });
  });

  it("prints the comment id the receipt carries, and nothing else on stdout", async () => {
    const { code, out, err, seen } = await runComment(ADD, { [ADDED]: ISSUED });

    expect(code).toBe(0);
    expect(seen).toEqual([HEALTH, ADDED]);
    expect(out).toBe("3\n");
    expect(err).toBe("");
  });

  // The notes come after the answer, so the id is what survives a truncated pipe.
  it("writes the notes of the write after the id", async () => {
    const { out, err } = await runComment(ADD, {
      [ADDED]: ok({ id: "TASM-1", commentId: 3 }, [{ code: "next-comment-id-rebuilt", message: "the counter was rebuilt", path: "/t" }]),
    });

    expect(out).toBe("3\n");
    expect(err).toBe("tasma: note: next-comment-id-rebuilt: the counter was rebuilt (/t)\n");
  });

  it("refuses every fault visible from argv alone, before it reaches a daemon", async () => {
    await refuses(["add"], "comment add needs a task id");
    await refuses(["add", "a/b", "--title", "Smoke"], "not a task id: a/b");
    await refuses(["add", "TASM-1"], "comment add needs --title <title>");
    await refuses(["add", "TASM-1", "--title", ""], "comment add needs --title <title>");
    await refuses([...ADD, "--author", ""], "--author needs a value");
    await refuses([...ADD, "--body", "x", "--body-file", "y"], "--body and --body-file exclude each other");
    await refuses([...ADD, "extra"], "comment add takes one argument: extra");
  });

  // Neither flag belongs to an add: a comment that does not exist yet has no
  // field to remove and no body to append to.
  it("knows neither --clear nor --append", async () => {
    for (const flag of ["--clear", "--append"]) {
      const { code, err, seen } = await runComment([...ADD, flag, "author"]);

      expect(code, flag).toBe(2);
      expect(err, flag).toContain(flag);
      expect(seen, flag).toEqual([]);
    }
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runComment(ADD, {
      [ADDED]: { ok: false, error: { kind: "store", code: "field-required", message: 'a comment needs a "title"' } },
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe('tasma: store/field-required: a comment needs a "title"\n');
  });

  it("refuses an answer that is not a comment write receipt", async () => {
    for (const data of [{ id: "TASM-1" }, { commentId: "3" }, {}, null]) {
      const { code, out, err } = await runComment(ADD, { [ADDED]: ok(data) });

      expect(code).toBe(3);
      expect(out).toBe("");
      expect(err).toContain("answered, but not with a comment write receipt");
    }
  });
});

describe("comment edit", () => {
  it("sends only the keys that were typed, to the route of that one comment", async () => {
    const { code, out, err, seen, bodies } = await runComment(["edit", "TASM-1", "3", "--title", "New"],
      { [UPDATED]: ISSUED });

    expect(code).toBe(0);
    expect(seen).toEqual([HEALTH, UPDATED]);
    expect(bodies.at(-1)).toEqual({ title: "New" });
    expect(out).toBe("3\n");
    expect(err).toBe("");
  });

  it("sends every clearable field as null", async () => {
    const args = ["edit", "TASM-1", "3", ...CLEARABLE.flatMap((field) => ["--clear", field])];

    expect(await sent(args, { [UPDATED]: ISSUED })).toEqual({ author: null, collapsed: null, body: null });
  });

  it("sends one clear where a field was named twice", async () => {
    expect(await sent(["edit", "TASM-1", "3", "--clear", "author", "--clear", "author"], { [UPDATED]: ISSUED }))
      .toEqual({ author: null });
  });

  it("refuses a field no write can remove", async () => {
    await refuses(["edit", "TASM-1", "3", "--clear", "title"], "not a clearable field: title");
    await refuses(["edit", "TASM-1", "3", "--clear", "x"], "not a clearable field: x");
    await refuses(["edit", "TASM-1", "3", "--clear", ""], "--clear needs a field");
  });

  // Two values for one field: which one wins is not something the caller stated.
  it("refuses a clear beside the flag that sets the same field", async () => {
    await refuses(
      ["edit", "TASM-1", "3", "--clear", "author", "--author", "almaz"],
      "--clear author and --author exclude each other",
    );
    await refuses(
      ["edit", "TASM-1", "3", "--clear", "collapsed", "--collapsed"],
      "--clear collapsed and --collapsed exclude each other",
    );
    await refuses(
      ["edit", "TASM-1", "3", "--clear", "body", "--body", "text"],
      "--clear body and --body exclude each other",
    );
    await refuses(
      ["edit", "TASM-1", "3", "--clear", "body", "--body-file", "-"],
      "--clear body and --body-file exclude each other",
    );
  });

  it("refuses a change that states nothing to change", async () => {
    await refuses(["edit", "TASM-1", "3"], "comment edit needs a change");
  });

  it("refuses an empty value, naming the clear where the field has one", async () => {
    await refuses(["edit", "TASM-1", "3", "--author", ""], "--author needs a value; --clear author removes the field");
    await refuses(["edit", "TASM-1", "3", "--title", ""], "--title needs a value");
  });

  it("refuses the faults it shares with a task id and a comment id", async () => {
    await refuses(["edit"], "comment edit needs a task id");
    await refuses(["edit", "TASM-1"], "comment edit needs a comment id");
    await refuses(["edit", "TASM-1", "x", "--title", "New"], "not a comment id: x");
    await refuses(["edit", "TASM-1", "3", "4"], "comment edit takes two arguments: 4");
  });

  it("reads the task, then writes the stored body with the text after it", async () => {
    const { code, out, err, seen, bodies } = await runComment(["edit", "TASM-1", "3", "--append", "--body", "more"], {
      [READ]: STORED,
      [UPDATED]: ISSUED,
    });

    expect(code).toBe(0);
    expect(seen).toEqual([HEALTH, READ, HEALTH, UPDATED]);
    expect(bodies.at(-1)).toEqual({ body: "stored\n\nmore" });
    expect(out).toBe("3\n");
    expect(err).toBe("");
  });

  // Without --append the text stands alone, so the stored body is never read.
  it("replaces the stored body where no append was asked for", async () => {
    const { seen, bodies } = await runComment(["edit", "TASM-1", "3", "--body", "new"], { [UPDATED]: ISSUED });

    expect(seen).toEqual([HEALTH, UPDATED]);
    expect(bodies.at(-1)).toEqual({ body: "new" });
  });

  it("refuses an append that states no text, and one that also removes the body", async () => {
    await refuses(["edit", "TASM-1", "3", "--append"], "--append needs --body or --body-file");
    await refuses(
      ["edit", "TASM-1", "3", "--append", "--clear", "body"],
      "--append and --clear body exclude each other",
    );
  });

  // The daemon answers the same mistake without --append as comment-not-found at
  // exit 1, and an agent branches on the code.
  it("writes nothing where the task carries no such comment", async () => {
    const { code, out, err, seen } = await runComment(["edit", "TASM-1", "3", "--append", "--body", "more"], {
      [READ]: ok({ frontmatter: { id: "TASM-1" }, comments: [{ id: 1, body: "other" }] }),
      [UPDATED]: ISSUED,
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("tasma: store/comment-not-found: this file carries no comment 3\n");
    expect(seen).toEqual([HEALTH, READ]);
  });

  it("writes nothing where the read before an append was refused", async () => {
    const { code, out, err, seen } = await runComment(["edit", "TASM-1", "3", "--append", "--body", "more"], {
      [READ]: { ok: false, error: { kind: "store", code: "task-not-found", message: "no task TASM-1" } },
      [UPDATED]: ISSUED,
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("tasma: store/task-not-found: no task TASM-1\n");
    expect(seen).toEqual([HEALTH, READ]);
  });

  it("writes nothing where the read before an append answered no task", async () => {
    for (const data of [{ frontmatter: {} }, { comments: [{ id: 3, body: 7 }] }, "a task"]) {
      const { code, out, err, seen } = await runComment(["edit", "TASM-1", "3", "--append", "--body", "more"], {
        [READ]: ok(data),
        [UPDATED]: ISSUED,
      });

      expect(code).toBe(3);
      expect(out).toBe("");
      expect(err).toContain("answered, but not with a task");
      expect(seen).toEqual([HEALTH, READ]);
    }
  });
});

describe("comment delete", () => {
  it("calls the route with no body at all", async () => {
    const { code, out, err, seen, bodies } = await runComment(["delete", "TASM-1", "3"], { [DELETED]: ISSUED });

    expect(code).toBe(0);
    expect(seen).toEqual([HEALTH, DELETED]);
    expect(bodies).toEqual([undefined, undefined]);
    expect(out).toBe("3\n");
    expect(err).toBe("");
  });

  it("refuses a missing comment id and one that is no comment id", async () => {
    await refuses(["delete", "TASM-1"], "comment delete needs a comment id");
    await refuses(["delete", "TASM-1", "x"], "not a comment id: x");
    await refuses(["delete", "a/b", "3"], "not a task id: a/b");
    await refuses(["delete", "TASM-1", "3", "extra"], "comment delete takes two arguments: extra");
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runComment(["delete", "TASM-1", "3"], {
      [DELETED]: { ok: false, error: { kind: "store", code: "comment-not-found", message: "no comment 3" } },
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("tasma: store/comment-not-found: no comment 3\n");
  });
});

describe("every comment write", () => {
  // A write may not be sent twice: no transport fault says whether the daemon
  // applied it before the connection failed. Such a call is proven ahead of
  // itself instead of retried behind a fault, and the read an append makes is
  // proven with them: it decides the text the write sends.
  it("proves every address it sends a call to, the read an append makes included", async () => {
    const invocations: [string[], Record<string, unknown>, string[]][] = [
      [ADD, { [ADDED]: ISSUED }, [HEALTH, ADDED]],
      [["edit", "TASM-1", "3", "--collapsed"], { [UPDATED]: ISSUED }, [HEALTH, UPDATED]],
      [["delete", "TASM-1", "3"], { [DELETED]: ISSUED }, [HEALTH, DELETED]],
      [
        ["edit", "TASM-1", "3", "--append", "--body", "more"],
        { [READ]: STORED, [UPDATED]: ISSUED },
        [HEALTH, READ, HEALTH, UPDATED],
      ],
    ];

    for (const [args, table, calls] of invocations) {
      const { code, seen } = await runComment(args, table);

      expect(code, args.join(" ")).toBe(0);
      expect(seen, args.join(" ")).toEqual(calls);
    }
  });

  /** One verb, read off the registry rather than restated here. */
  function verbOf(name: string): Command | undefined {
    return (comment.verbs ?? []).find((entry) => entry.name === name);
  }

  // The list comes from the parser's own table, so a flag added there and left
  // out of the check fails here rather than shipping silent.
  it("is refused with an empty value, before any call is made", async () => {
    for (const [verb, args] of [["add", ADD], ["edit", ["edit", "TASM-1", "3"]]] as const) {
      const flags = Object.entries(verbOf(verb)?.usage?.options ?? {})
        .filter(([, option]) => option.type === "string")
        .map(([flag]) => flag);

      for (const flag of flags) {
        const { code, out, err, seen } = await runComment([...args, `--${flag}`, ""]);

        expect(code, `--${flag}`).toBe(2);
        expect(out, `--${flag}`).toBe("");
        expect(err, `--${flag}`).toContain(`--${flag}`);
        expect(seen, `--${flag}`).toEqual([]);
      }
    }
  });

  // A field added to the set and left out of the block is one the CLI accepts
  // and documents nowhere.
  it("names every field --clear accepts in the block documenting it", () => {
    const help = (verbOf("edit")?.usage?.help ?? []).join(" ");

    for (const field of CLEARABLE) expect(help, field).toContain(field);
  });
});

describe("the comment noun", () => {
  const VERBS = ["list", "view", "add", "edit", "delete"];

  it("lists its five verbs for a bare noun", async () => {
    const { io, out } = capture();

    expect(await comment.run([], io, at("http://127.0.0.1:8278"))).toBe(0);

    for (const verb of VERBS) expect(out.join("")).toContain(`  ${verb}`);
  });

  it("prints a usage block for every verb, reaching no daemon", async () => {
    for (const verb of VERBS) {
      for (const flag of ["--help", "-h"]) {
        const { code, out, err, seen } = await runComment([verb, flag]);

        expect(code, `${verb} ${flag}`).toBe(0);
        expect(out).toContain(`tasma comment ${verb}`);
        expect(err).toBe("");
        expect(seen).toEqual([]);
      }
    }
  });
});
