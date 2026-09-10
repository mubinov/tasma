import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { task } from "../../src/commands/task.js";
import { CLEARABLE } from "../../src/commands/task-write.js";
import type { Command, Source } from "../../src/types.js";
import { CWD, HEALTH, HINT, ok, RESOLVED, runCommand, scratchFile } from "../helpers.js";
import type { Ran } from "../helpers.js";

/** Runs a write verb of the noun against a server answering the table, and reports what it wrote. */
function runTask(
  args: string[],
  table: Record<string, unknown> = {},
  options: { stdin?: string | Source } = {},
): Promise<Ran> {
  return runCommand(task, args, table, options);
}

const CREATED = "POST /projects/TASM/tasks";
const UPDATED = "PATCH /projects/TASM/tasks/TASM-1";
const DELETED = "DELETE /projects/TASM/tasks/TASM-1";
const READ = "GET /projects/TASM/tasks/TASM-1?comments=false";

/** What a create answers, and what an edit or a delete of the planted task answers. */
const ISSUED = ok({ id: "TASM-2" });
const CHANGED = ok({ id: "TASM-1" });

/** The whole invocation a create needs before any flag under test. */
const CREATE = ["create", "-p", "TASM", "--title", "Second"];

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
  const { bodies } = await runTask(args, table, options);

  return bodies.at(-1);
}

/** Asserts that an invocation was refused from argv alone, with the line it names and no call made. */
async function refuses(args: string[], line: string): Promise<void> {
  const { code, out, err, seen } = await runTask(args);

  expect(code, args.join(" ")).toBe(2);
  expect(out, args.join(" ")).toBe("");
  expect(err, args.join(" ")).toBe(`tasma: ${line}\n${HINT}`);
  expect(seen, args.join(" ")).toEqual([]);
}

describe("task create", () => {
  it("sends the title alone where no other flag was typed", async () => {
    expect(await sent(CREATE, { [CREATED]: ISSUED })).toEqual({ title: "Second" });
  });

  it("sends each field flag as its own key, with the value as it was typed", async () => {
    const body = await sent([
      ...CREATE,
      "--status", "In Progress", "--priority", "High", "--parent", "TASM-15",
      "--step", "dev:implement", "--workflow", "engineering", "--order", "3",
    ], { [CREATED]: ISSUED });

    expect(body).toEqual({
      title: "Second",
      status: "In Progress",
      priority: "High",
      parent: "TASM-15",
      step: "dev:implement",
      workflow: "engineering",
      order: 3,
    });
  });

  it("sends the two repeated flags as lists, in the order they were given", async () => {
    const body = await sent([
      ...CREATE, "--label", "Infra", "--label", "cli", "--blocked-by", "TASM-1", "--blocked-by", "TASM-3",
    ], { [CREATED]: ISSUED });

    expect(body).toEqual({ title: "Second", labels: ["Infra", "cli"], blocked_by: ["TASM-1", "TASM-3"] });
  });

  it("sends --order as a number", async () => {
    expect(await sent([...CREATE, "--order", "3"], { [CREATED]: ISSUED })).toEqual({ title: "Second", order: 3 });
  });

  // `--order -1` is ambiguous to the parser, which refuses it before the verb
  // sees it; `=` is what states a negative position.
  it("takes a negative position through --order=-1", async () => {
    expect(await sent([...CREATE, "--order=-1"], { [CREATED]: ISSUED })).toEqual({ title: "Second", order: -1 });
  });

  it("leaves --order -1 to the parser, which refuses it", async () => {
    const { code, err, seen } = await runTask([...CREATE, "--order", "-1"]);

    expect(code).toBe(2);
    expect(err).toContain("ambiguous");
    expect(seen).toEqual([]);
  });

  it("sends the body --body states", async () => {
    expect(await sent([...CREATE, "--body", "A body"], { [CREATED]: ISSUED }))
      .toEqual({ title: "Second", body: "A body" });
  });

  it("sends the body a file holds", async () => {
    const path = scratchFile("From a file\n");

    expect(await sent([...CREATE, "--body-file", path], { [CREATED]: ISSUED }))
      .toEqual({ title: "Second", body: "From a file\n" });
  });

  it("sends the body standard input carries", async () => {
    expect(await sent([...CREATE, "--body-file", "-"], { [CREATED]: ISSUED }, { stdin: "From a pipe\n" }))
      .toEqual({ title: "Second", body: "From a pipe\n" });
  });

  it("prints the id the receipt carries, and nothing else on stdout", async () => {
    const { code, out, err } = await runTask(CREATE, { [CREATED]: ISSUED });

    expect(code).toBe(0);
    expect(out).toBe("TASM-2\n");
    expect(err).toBe("");
  });

  // Every other case states the short form the constant carries.
  it("takes the long --project as readily as the short -p", async () => {
    const { seen } = await runTask(["create", "--project", "TASM", "--title", "Second"], { [CREATED]: ISSUED });

    expect(seen).toEqual([HEALTH, CREATED]);
  });

  // The notes come after the answer, so the id is what survives a truncated pipe.
  it("writes the notes of the write after the id", async () => {
    const { out, err } = await runTask(CREATE, {
      [CREATED]: ok({ id: "TASM-2" }, [{ code: "next-task-id-rebuilt", message: "the counter was rebuilt", path: "/t" }]),
    });

    expect(out).toBe("TASM-2\n");
    expect(err).toBe("tasma: note: next-task-id-rebuilt: the counter was rebuilt (/t)\n");
  });

  it("refuses every fault visible from argv alone, before it reaches a daemon", async () => {
    await refuses(["create", "-p", "", "--title", "Second"], "task create needs --project <tag>");
    await refuses(["create", "-p", "a/b", "--title", "Second"], "not a project tag: a/b");
    await refuses(["create", "-p", "TASM"], "task create needs --title <title>");
    await refuses(["create", "-p", "TASM", "--title", ""], "task create needs --title <title>");
    // The title is checked ahead of the project, so a create missing both names
    // the title rather than the flag whose value is empty.
    await refuses(["create", "-p", ""], "task create needs --title <title>");
    await refuses([...CREATE, "--priority", ""], "--priority needs a value");
    await refuses([...CREATE, "--label", "a", "--label", ""], "--label needs a value");
    await refuses([...CREATE, "--order", "x"], "not an integer: x");
    await refuses([...CREATE, "--order", "9007199254740993"], "not an integer: 9007199254740993");
    await refuses([...CREATE, "--body", "x", "--body-file", "y"], "--body and --body-file exclude each other");
    await refuses([...CREATE, "extra"], "task create takes no arguments: extra");
  });

  // Neither flag belongs to a create: a task that does not exist yet has no
  // field to remove and no body to append to.
  it("knows neither --clear nor --append", async () => {
    for (const flag of ["--clear", "--append"]) {
      const { code, err, seen } = await runTask([...CREATE, flag, "priority"]);

      expect(code, flag).toBe(2);
      expect(err, flag).toContain(flag);
      expect(seen, flag).toEqual([]);
    }
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runTask(CREATE, {
      [CREATED]: { ok: false, error: { kind: "store", code: "field-required", message: 'a task needs a "title"' } },
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe('tasma: store/field-required: a task needs a "title"\n');
  });

  it("refuses an answer that is not a write receipt", async () => {
    for (const data of [{ id: 7 }, {}, "TASM-2", null]) {
      const { code, out, err } = await runTask(CREATE, { [CREATED]: ok(data) });

      expect(code).toBe(3);
      expect(out).toBe("");
      expect(err).toContain("answered, but not with a write receipt");
    }
  });

  it("resolves the project from the working directory, each call proven", async () => {
    const { code, out, err, seen } = await runTask(["create", "--title", "Second"], {
      [RESOLVED]: ok({ tag: "TASM" }),
      [CREATED]: ISSUED,
    });

    expect(code).toBe(0);
    expect(out).toBe("TASM-2\n");
    expect(err).toBe(`tasma: project TASM, from ${CWD}\n`);
    expect(seen).toEqual([HEALTH, RESOLVED, HEALTH, CREATED]);
  });

  it("leaves standard input unread where the directory resolves to no project", async () => {
    const unread: Source = {
      [Symbol.asyncIterator]: () => {
        throw new Error("standard input was read");
      },
    };

    const { code, err, seen } = await runTask(
      ["create", "--title", "Second", "--body-file", "-"],
      { [RESOLVED]: ok(null) },
      { stdin: unread },
    );

    expect(code).toBe(2);
    expect(err).toBe(`tasma: no project holds ${CWD}; state one with --project <tag>\n${HINT}`);
    expect(seen).toEqual([HEALTH, RESOLVED]);
  });
});

describe("task edit", () => {
  it("sends only the keys that were typed", async () => {
    expect(await sent(["edit", "TASM-1", "--title", "New"], { [UPDATED]: CHANGED })).toEqual({ title: "New" });
  });

  it("prints the id the receipt carries", async () => {
    const { code, out, err } = await runTask(["edit", "TASM-1", "--status", "Done"], { [UPDATED]: CHANGED });

    expect(code).toBe(0);
    expect(out).toBe("TASM-1\n");
    expect(err).toBe("");
  });

  // Without --append the text stands alone, so the stored body is never read.
  it("replaces the stored body where no append was asked for", async () => {
    const { seen, bodies } = await runTask(["edit", "TASM-1", "--body", "new"], { [UPDATED]: CHANGED });

    expect(seen).toEqual([HEALTH, UPDATED]);
    expect(bodies.at(-1)).toEqual({ body: "new" });
  });

  it("sends every clearable field as null", async () => {
    const fields = ["priority", "labels", "parent", "blocked_by", "step", "workflow", "order", "body"];
    const args = ["edit", "TASM-1", ...fields.flatMap((field) => ["--clear", field])];

    expect(await sent(args, { [UPDATED]: CHANGED })).toEqual({
      priority: null,
      labels: null,
      parent: null,
      blocked_by: null,
      step: null,
      workflow: null,
      order: null,
      body: null,
    });
  });

  it("sends one clear where a field was named twice", async () => {
    expect(await sent(["edit", "TASM-1", "--clear", "priority", "--clear", "priority"], { [UPDATED]: CHANGED }))
      .toEqual({ priority: null });
  });

  it("refuses a field no write can remove", async () => {
    await refuses(["edit", "TASM-1", "--clear", "title"], "not a clearable field: title");
    await refuses(["edit", "TASM-1", "--clear", "status"], "not a clearable field: status");
    await refuses(["edit", "TASM-1", "--clear", "x"], "not a clearable field: x");
    await refuses(["edit", "TASM-1", "--clear", ""], "--clear needs a field");
  });

  // Two values for one field: which one wins is not something the caller stated.
  it("refuses a clear beside the flag that sets the same field", async () => {
    await refuses(
      ["edit", "TASM-1", "--clear", "priority", "--priority", "high"],
      "--clear priority and --priority exclude each other",
    );
    await refuses(
      ["edit", "TASM-1", "--clear", "labels", "--label", "infra"],
      "--clear labels and --label exclude each other",
    );
    await refuses(
      ["edit", "TASM-1", "--clear", "blocked_by", "--blocked-by", "TASM-3"],
      "--clear blocked_by and --blocked-by exclude each other",
    );
    await refuses(
      ["edit", "TASM-1", "--clear", "body", "--body", "text"],
      "--clear body and --body exclude each other",
    );
    await refuses(
      ["edit", "TASM-1", "--clear", "body", "--body-file", "-"],
      "--clear body and --body-file exclude each other",
    );
  });

  it("refuses a change that states nothing to change", async () => {
    await refuses(["edit", "TASM-1"], "task edit needs a change");
  });

  it("refuses an empty value, naming the clear where the field has one", async () => {
    await refuses(["edit", "TASM-1", "--priority", ""], "--priority needs a value; --clear priority removes the field");
    await refuses(["edit", "TASM-1", "--label", ""], "--label needs a value; --clear labels removes the field");
    await refuses(
      ["edit", "TASM-1", "--blocked-by", ""],
      "--blocked-by needs a value; --clear blocked_by removes the field",
    );
    await refuses(["edit", "TASM-1", "--title", ""], "--title needs a value");
    await refuses(["edit", "TASM-1", "--status", ""], "--status needs a value");
  });

  it("refuses the faults it shares with an id and a position", async () => {
    await refuses(["edit"], "task edit needs a task id");
    await refuses(["edit", "a/b", "--title", "New"], "not a task id: a/b");
    await refuses(["edit", "TASM-1", "--order", "x"], "not an integer: x");
    await refuses(
      ["edit", "TASM-1", "--body", "x", "--body-file", "y"],
      "--body and --body-file exclude each other",
    );
  });

  it("reads the task, then writes the stored body with the text after it", async () => {
    const { code, out, err, bodies } = await runTask(["edit", "TASM-1", "--append", "--body", "more"], {
      [READ]: ok({ frontmatter: { id: "TASM-1" }, body: "stored\n" }),
      [UPDATED]: CHANGED,
    });

    expect(code).toBe(0);
    expect(bodies.at(-1)).toEqual({ body: "stored\n\nmore" });
    expect(out).toBe("TASM-1\n");
    expect(err).toBe("");
  });

  it("appends the text alone to a task whose body is empty", async () => {
    const { bodies } = await runTask(["edit", "TASM-1", "--append", "--body-file", "-"], {
      [READ]: ok({ frontmatter: { id: "TASM-1" }, body: "" }),
      [UPDATED]: CHANGED,
    }, { stdin: "more" });

    expect(bodies.at(-1)).toEqual({ body: "more" });
  });

  // An empty pipe is a body the caller meant to be empty, and appending it adds
  // nothing: what the write sends is the body the read answered, unchanged.
  it("sends the stored body untouched where the appended text is empty", async () => {
    const { bodies } = await runTask(["edit", "TASM-1", "--append", "--body-file", "-"], {
      [READ]: ok({ frontmatter: { id: "TASM-1" }, body: "stored\n" }),
      [UPDATED]: CHANGED,
    }, { stdin: "" });

    expect(bodies.at(-1)).toEqual({ body: "stored\n" });
  });

  it("refuses an append that states no text, and one that also removes the body", async () => {
    await refuses(["edit", "TASM-1", "--append"], "--append needs --body or --body-file");
    await refuses(["edit", "TASM-1", "--append", "--clear", "body"], "--append and --clear body exclude each other");
  });

  it("writes nothing where the read before an append was refused", async () => {
    const { code, out, err, seen } = await runTask(["edit", "TASM-1", "--append", "--body", "more"], {
      [READ]: { ok: false, error: { kind: "store", code: "task-not-found", message: "no task TASM-1" } },
      [UPDATED]: CHANGED,
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("tasma: store/task-not-found: no task TASM-1\n");
    expect(seen).toEqual([HEALTH, READ]);
  });

  it("writes nothing where the read before an append answered no task", async () => {
    for (const data of [{ frontmatter: {} }, { body: 7 }, "a task"]) {
      const { code, out, err, seen } = await runTask(["edit", "TASM-1", "--append", "--body", "more"], {
        [READ]: ok(data),
        [UPDATED]: CHANGED,
      });

      expect(code).toBe(3);
      expect(out).toBe("");
      expect(err).toContain("answered, but not with a task");
      expect(seen).toEqual([HEALTH, READ]);
    }
  });
});

describe("task delete", () => {
  it("calls the route with no body at all", async () => {
    const { code, out, err, seen, bodies } = await runTask(["delete", "TASM-1"], { [DELETED]: CHANGED });

    expect(code).toBe(0);
    expect(seen).toEqual([HEALTH, DELETED]);
    expect(bodies).toEqual([undefined, undefined]);
    expect(out).toBe("TASM-1\n");
    expect(err).toBe("");
  });

  it("refuses a missing id and one that is no task id", async () => {
    await refuses(["delete"], "task delete needs a task id");
    await refuses(["delete", "a/b"], "not a task id: a/b");
    await refuses(["delete", "TASM-1", "extra"], "task delete takes one argument: extra");
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runTask(["delete", "TASM-1"], {
      [DELETED]: { ok: false, error: { kind: "store", code: "task-not-found", message: "no task TASM-1" } },
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("tasma: store/task-not-found: no task TASM-1\n");
  });
});

describe("every write", () => {
  // A write may not be sent twice: no transport fault says whether the daemon
  // applied it before the connection failed. Such a call is proven ahead of
  // itself instead of retried behind a fault, and the probe that proves it is
  // what a verb sending its call as repeatable would not make.
  //
  // The read an append makes is proven with them: it decides the text the write
  // sends, so a read answered by a daemon serving another tree is that tree's
  // body written into this one.
  it("proves every address it sends a call to, the read an append makes included", async () => {
    const stored = ok({ frontmatter: { id: "TASM-1" }, body: "stored" });
    const invocations: [string[], Record<string, unknown>, string[]][] = [
      [CREATE, { [CREATED]: ISSUED }, [HEALTH, CREATED]],
      [["edit", "TASM-1", "--status", "Done"], { [UPDATED]: CHANGED }, [HEALTH, UPDATED]],
      [["delete", "TASM-1"], { [DELETED]: CHANGED }, [HEALTH, DELETED]],
      [
        ["edit", "TASM-1", "--append", "--body", "more"],
        { [READ]: stored, [UPDATED]: CHANGED },
        [HEALTH, READ, HEALTH, UPDATED],
      ],
    ];

    for (const [args, table, calls] of invocations) {
      const { code, seen } = await runTask(args, table);

      expect(code, args.join(" ")).toBe(0);
      expect(seen, args.join(" ")).toEqual(calls);
    }
  });
});

describe("every option a write accepts", () => {
  /** One write verb, read off the registry rather than restated here. */
  function verbOf(name: string): Command | undefined {
    return (task.verbs ?? []).find((entry) => entry.name === name);
  }

  /** The string options one write verb's parser takes. */
  function stringOptions(name: string): string[] {
    return Object.entries(verbOf(name)?.usage?.options ?? {})
      .filter(([, option]) => option.type === "string")
      .map(([flag]) => flag);
  }

  // One empty check covers the field flags, and a flag that never reaches it is
  // one the CLI parses, documents and then drops on the way to the wire. The
  // list comes from the parser's own table, so a flag added there and left out
  // of the check fails here rather than shipping silent.
  it("is refused with an empty value, before any call is made", async () => {
    for (const [verb, args] of [["create", CREATE], ["edit", ["edit", "TASM-1"]]] as const) {
      for (const flag of stringOptions(verb)) {
        const { code, out, err, seen } = await runTask([...args, `--${flag}`, ""]);

        expect(code, `--${flag}`).toBe(2);
        expect(out, `--${flag}`).toBe("");
        expect(err, `--${flag}`).toContain(`--${flag}`);
        expect(seen, `--${flag}`).toEqual([]);
      }
    }
  });

  // `--clear` takes its fields from a set of its own, and the edit block spells
  // the same fields out as prose. A field added to the set and left out of the
  // block is one the CLI accepts and documents nowhere.
  it("names every field --clear accepts in the block documenting it", () => {
    const help = (verbOf("edit")?.usage?.help ?? []).join(" ");

    for (const field of CLEARABLE) expect(help, field).toContain(field);
  });
});
