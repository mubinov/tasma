import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { workflow } from "../../src/commands/workflow.js";
import { CWD, HEALTH, HINT, ok, runCommand } from "../helpers.js";
import type { Ran } from "../helpers.js";

/** Runs a verb of the noun against a server answering the table, and reports what it wrote. */
function runWorkflow(
  args: string[],
  table: Record<string, unknown> = {},
  options: { cwd?: string } = {},
): Promise<Ran> {
  return runCommand(workflow, args, table, options);
}

const CREATED = "POST /workflows";
const UPDATED = "PATCH /workflows/flow-a";
const DELETED = "DELETE /workflows/flow-a";

const WRITTEN = ok({ name: "flow-a", file: "/flows/flow-a/workflow.yml", steps: [], instructions: [] });

/** The object the write sent, which is the last call behind the probe that proved the address. */
async function sent(args: string[], table: Record<string, unknown>, options: { cwd?: string } = {}): Promise<unknown> {
  const { code, bodies } = await runWorkflow(args, table, options);

  expect(code, args.join(" ")).toBe(0);

  return bodies.at(-1);
}

/** Asserts that an invocation was refused from argv alone, with the line it names and no call made. */
async function refuses(args: string[], line: string, options: { cwd?: string } = {}): Promise<void> {
  const { code, out, err, seen } = await runWorkflow(args, {}, options);

  expect(code, args.join(" ")).toBe(2);
  expect(out, args.join(" ")).toBe("");
  expect(err, args.join(" ")).toBe(`tasma: ${line}\n${HINT}`);
  expect(seen, args.join(" ")).toEqual([]);
}

describe("workflow create", () => {
  it("sends the steps in order and prints the name", async () => {
    const args = ["create", "flow-a", "--step", "a:one,agent,/docs/one.md", "--step", "a:two,human,/docs/two.md"];
    const { code, out, err, seen, bodies } = await runWorkflow(args, { [CREATED]: WRITTEN });

    expect(code).toBe(0);
    expect(out).toBe("flow-a\n");
    expect(err).toBe("");
    expect(seen).toEqual([HEALTH, CREATED]);
    expect(bodies.at(-1)).toEqual({
      name: "flow-a",
      steps: [
        { name: "a:one", owner: "agent", file: "/docs/one.md" },
        { name: "a:two", owner: "human", file: "/docs/two.md" },
      ],
    });
  });

  it("sends the title, and the instructions and the step files made absolute", async () => {
    const args = ["create", "flow-a", "--title", "Flow A", "--step", "one,agent,one.md", "--instruction", "rules.md"];

    expect(await sent(args, { [CREATED]: WRITTEN })).toEqual({
      name: "flow-a",
      title: "Flow A",
      steps: [{ name: "one", owner: "agent", file: `${CWD}/one.md` }],
      instructions: [`${CWD}/rules.md`],
    });
  });

  it("keeps a ~/ path and a comma inside the file", async () => {
    const args = ["create", "flow-a", "--step", "one,agent,~/docs/a,b.md"];

    expect(await sent(args, { [CREATED]: WRITTEN })).toMatchObject({
      steps: [{ name: "one", owner: "agent", file: "~/docs/a,b.md" }],
    });
  });

  it("sends a step name and an owner the daemon judges as they were typed", async () => {
    expect(await sent(["create", "flow-a", "--step", "Bad Name,robot,/x.md"], { [CREATED]: WRITTEN })).toMatchObject({
      steps: [{ name: "Bad Name", owner: "robot", file: "/x.md" }],
    });
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runWorkflow(["create", "flow-a", "--step", "one,agent,/x.md"], {
      [CREATED]: { ok: false, error: { kind: "store", code: "workflow-exists", message: 'the workflow "flow-a" exists' } },
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe('tasma: store/workflow-exists: the workflow "flow-a" exists\n');
  });

  it("refuses every fault visible from argv alone, before it reaches a daemon", async () => {
    await refuses(["create"], "workflow create needs a workflow name");
    await refuses(["create", ""], "workflow create needs a workflow name");
    await refuses(["create", "a/b", "--step", "one,agent,/x.md"], "not a workflow name: a/b");
    await refuses(["create", "flow-a"], "workflow create needs --step <name>,<owner>,<file>");
    await refuses(["create", "flow-a", "--step", ""], "--step needs a value");
    await refuses(["create", "flow-a", "--step", "one"], "--step needs <name>,<owner>,<file>: one");
    await refuses(["create", "flow-a", "--step", "one,agent"], "--step needs <name>,<owner>,<file>: one,agent");
    await refuses(["create", "flow-a", "--step", ",agent,/x.md"], "--step needs <name>,<owner>,<file>: ,agent,/x.md");
    await refuses(["create", "flow-a", "--step", "one,,/x.md"], "--step needs <name>,<owner>,<file>: one,,/x.md");
    await refuses(["create", "flow-a", "--step", "one,agent,"], "--step needs <name>,<owner>,<file>: one,agent,");
    await refuses(["create", "flow-a", "--step", "one,agent,/x.md", "--title", ""], "--title needs a value");
    await refuses(["create", "flow-a", "--step", "one,agent,/x.md", "--instruction", ""], "--instruction needs a value");
  });

  it("refuses a relative path where the working directory could not be read", async () => {
    await refuses(
      ["create", "flow-a", "--step", "one,agent,one.md"],
      "the working directory could not be read; state --step as an absolute path",
      { cwd: "" },
    );
    await refuses(
      ["create", "flow-a", "--step", "one,agent,/one.md", "--instruction", "rules.md"],
      "the working directory could not be read; state --instruction as an absolute path",
      { cwd: "" },
    );
  });
});

describe("workflow edit", () => {
  it("sends only the fields that were typed, and prints the name", async () => {
    const { code, out, seen, bodies } = await runWorkflow(["edit", "flow-a", "--title", "Flow B"], { [UPDATED]: WRITTEN });

    expect(code).toBe(0);
    expect(out).toBe("flow-a\n");
    expect(seen).toEqual([HEALTH, UPDATED]);
    expect(bodies.at(-1)).toEqual({ title: "Flow B" });
  });

  it("sends the steps and the instructions made absolute", async () => {
    const args = ["edit", "flow-a", "--step", "one,agent,one.md", "--instruction", "/rules.md"];

    expect(await sent(args, { [UPDATED]: WRITTEN })).toEqual({
      steps: [{ name: "one", owner: "agent", file: `${CWD}/one.md` }],
      instructions: ["/rules.md"],
    });
  });

  it("sends each clear as null", async () => {
    expect(await sent(["edit", "flow-a", "--clear", "title", "--clear", "instructions"], { [UPDATED]: WRITTEN }))
      .toEqual({ title: null, instructions: null });
  });

  it("writes a removed-step note after the name", async () => {
    const note = { code: "step-stale", message: 'ALPHA-1 is on the step "a:two"', path: "/tree/ALPHA-1.md" };
    const { out, err } = await runWorkflow(["edit", "flow-a", "--step", "a:one,agent,/x.md"], {
      [UPDATED]: ok({ name: "flow-a" }, [note]),
    });

    expect(out).toBe("flow-a\n");
    expect(err).toBe('tasma: note: step-stale: ALPHA-1 is on the step "a:two" (/tree/ALPHA-1.md)\n');
  });

  it("refuses every fault visible from argv alone, before it reaches a daemon", async () => {
    await refuses(["edit"], "workflow edit needs a workflow name");
    await refuses(["edit", "flow-a"], "workflow edit needs a change");
    await refuses(["edit", "flow-a", "--clear", "steps"], "not a clearable field: steps");
    await refuses(["edit", "flow-a", "--clear", ""], "--clear needs a field");
    await refuses(["edit", "flow-a", "--clear", "title", "--title", "x"], "--clear title and --title exclude each other");
    await refuses(
      ["edit", "flow-a", "--clear", "instructions", "--instruction", "/x.md"],
      "--clear instructions and --instruction exclude each other",
    );
    await refuses(["edit", "flow-a", "--title", ""], "--title needs a value; --clear title removes the field");
    await refuses(["edit", "flow-a", "--step", "one"], "--step needs <name>,<owner>,<file>: one");
    await refuses(
      ["edit", "flow-a", "--instruction", "rules.md"],
      "the working directory could not be read; state --instruction as an absolute path",
      { cwd: "" },
    );
  });
});

describe("workflow delete", () => {
  it("prints the removed name", async () => {
    const { code, out, seen } = await runWorkflow(["delete", "flow-a"], { [DELETED]: ok({ name: "flow-a" }) });

    expect(code).toBe(0);
    expect(out).toBe("flow-a\n");
    expect(seen).toEqual([HEALTH, DELETED]);
  });

  it("reports a workflow a project lists, at exit 1", async () => {
    const message = 'the workflow "flow-a" is listed by the project ALPHA';
    const { code, err } = await runWorkflow(["delete", "flow-a"], {
      [DELETED]: { ok: false, error: { kind: "store", code: "workflow-in-use", message } },
    });

    expect(code).toBe(1);
    expect(err).toBe(`tasma: store/workflow-in-use: ${message}\n`);
  });

  it("refuses a missing name and an extra argument", async () => {
    await refuses(["delete"], "workflow delete needs a workflow name");
    await refuses(["delete", "flow-a", "more"], "workflow delete takes one argument: more");
  });
});

describe("every workflow write", () => {
  it("refuses a flag it does not know, before it reaches a daemon", async () => {
    for (const args of [["create", "flow-a", "--bogus"], ["edit", "flow-a", "--bogus"], ["delete", "flow-a", "--bogus"]]) {
      const { code, seen } = await runWorkflow(args);

      expect(code, args.join(" ")).toBe(2);
      expect(seen, args.join(" ")).toEqual([]);
    }
  });

  it("refuses an answer that is not a write receipt, at exit 3", async () => {
    const invocations: [string[], string][] = [
      [["create", "flow-a", "--step", "one,agent,/x.md"], CREATED],
      [["edit", "flow-a", "--title", "x"], UPDATED],
      [["delete", "flow-a"], DELETED],
    ];

    for (const [args, route] of invocations) {
      for (const data of [{ name: 7 }, {}, "flow-a", null]) {
        const { code, out, err } = await runWorkflow(args, { [route]: ok(data) });

        expect(code, `${args.join(" ")} ${JSON.stringify(data)}`).toBe(3);
        expect(out).toBe("");
        expect(err).toContain("answered, but not with a write receipt\n");
      }
    }
  });

  it("says that a step list replaces the stored one in the help of edit alone", async () => {
    const created = await runWorkflow(["create", "--help"]);
    const edited = await runWorkflow(["edit", "--help"]);

    expect(created.out).toContain("--step <name>,<owner>,<file>");
    expect(created.out).not.toContain("replaces the stored one");
    expect(edited.out).toContain("A step; repeat it for every step, in order; the list replaces the stored one.");
  });
});
