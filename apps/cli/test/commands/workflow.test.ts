import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { workflow } from "../../src/commands/workflow.js";
import { HINT, ok, runCommand } from "../helpers.js";
import type { Ran } from "../helpers.js";

/** Runs a verb of this noun against a server answering the table, and reports what it wrote. */
function runWorkflow(args: string[], table: Record<string, unknown> = {}): Promise<Ran> {
  return runCommand(workflow, args, table);
}

/** Asserts that an invocation was refused from argv alone, with the line it names and no call made. */
async function refuses(args: string[], line: string): Promise<void> {
  const { code, out, err, seen } = await runWorkflow(args);

  expect(code, args.join(" ")).toBe(2);
  expect(out, args.join(" ")).toBe("");
  expect(err, args.join(" ")).toBe(`tasma: ${line}\n${HINT}`);
  expect(seen, args.join(" ")).toEqual([]);
}

/** The route the listing reaches. */
const LISTED = "GET /workflows";

/** The route one workflow is read through. */
const READ = "GET /workflows/dev";

/** A workflow as the route answers one, with every field this noun prints. */
const DEV = {
  name: "dev",
  title: "Engineering task flow",
  instructions: ["/rules/task-workflow.md"],
  steps: [
    { name: "dev:research", file: "/rules/dev/dev-research.md", owner: "agent" },
    { name: "user:review", file: "/rules/dev/user-review.md", owner: "human" },
  ],
};

/** The step block of that workflow, which several cases assert around. */
const DEV_STEPS = "dev:research  agent  /rules/dev/dev-research.md\nuser:review   human  /rules/dev/user-review.md\n";

describe("workflow list", () => {
  it("prints the name of every workflow, one per line, in the order received", async () => {
    const { code, out, err, seen } = await runWorkflow(["list"], { [LISTED]: ok(["dev", "design"]) });

    expect(code).toBe(0);
    expect(out).toBe("dev\ndesign\n");
    expect(err).toBe("");
    expect(seen).toEqual([LISTED]);
  });

  // An element is whatever the port sent, so a value that is no name still
  // prints as one line rather than an empty one.
  it("marks an element that states no name", async () => {
    const { code, out } = await runWorkflow(["list"], { [LISTED]: ok(["", 7]) });

    expect(code).toBe(0);
    expect(out).toBe("-\n7\n");
  });

  it("prints nothing at all for a tree that holds no workflow", async () => {
    const { code, out, err } = await runWorkflow(["list"], { [LISTED]: ok([]) });

    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toBe("");
  });

  // A directory that is no workflow does not fail the listing: the names still
  // answer and the finding rides along behind them.
  it("writes the notes of the answer after the table", async () => {
    const { code, out, err } = await runWorkflow(["list"], {
      [LISTED]: ok(["dev"], [
        { code: "workflow-missing", message: "this directory holds no workflow.yml", path: "/w/scratch" },
      ]),
    });

    expect(code).toBe(0);
    expect(out).toBe("dev\n");
    expect(err).toBe("tasma: note: workflow-missing: this directory holds no workflow.yml (/w/scratch)\n");
  });

  // The answer is whatever the port sent, so the shape the writer needs is
  // tested before an element is read off it.
  it("refuses an answer that is not a workflow listing", async () => {
    const { code, out, err } = await runWorkflow(["list"], { [LISTED]: ok({ names: ["dev"] }) });

    expect(code).toBe(3);
    expect(out).toBe("");
    expect(err).toContain("answered, but not with a workflow listing");
  });

  it("refuses an argument of its own", async () => {
    await refuses(["list", "dev"], "workflow list takes no arguments: dev");
  });

  it("reports an unknown flag through the parser's own message", async () => {
    const { code, err } = await runWorkflow(["list", "--nope"]);

    expect(code).toBe(2);
    expect(err).toContain("tasma: Unknown option '--nope'");
  });

  it("prints its usage block for --help and -h, reaching no daemon", async () => {
    for (const flag of ["--help", "-h"]) {
      const { code, out, err, seen } = await runWorkflow(["list", flag]);

      expect(code).toBe(0);
      expect(out).toContain("tasma workflow list");
      expect(err).toBe("");
      expect(seen).toEqual([]);
    }
  });

  it("prints its usage block before it refuses an argument", async () => {
    const { code, out, err, seen } = await runWorkflow(["list", "dev", "--help"]);

    expect(code).toBe(0);
    expect(out).toContain("tasma workflow list");
    expect(err).toBe("");
    expect(seen).toEqual([]);
  });
});

describe("workflow show", () => {
  it("prints the workflow, its documents and its steps as three blocks", async () => {
    const { code, out, err, seen } = await runWorkflow(["show", "dev"], { [READ]: ok(DEV) });

    expect(code).toBe(0);
    expect(out).toBe(`dev  Engineering task flow\n\ninstructions  /rules/task-workflow.md\n\n${DEV_STEPS}`);
    expect(err).toBe("");
    expect(seen).toEqual([READ]);
  });

  it("repeats the label on every document it names", async () => {
    const { code, out } = await runWorkflow(["show", "dev"], {
      [READ]: ok({ ...DEV, instructions: ["/rules/one.md", "/rules/two.md"] }),
    });

    expect(code).toBe(0);
    expect(out).toContain("instructions  /rules/one.md\ninstructions  /rules/two.md\n");
  });

  // The block is dropped whole rather than printed empty, which is what keeps a
  // workflow that names no document from carrying a stray blank line.
  it("leaves out the document block, and its blank line, for a workflow that names none", async () => {
    const { code, out } = await runWorkflow(["show", "dev"], { [READ]: ok({ ...DEV, instructions: [] }) });

    expect(code).toBe(0);
    expect(out).toBe(`dev  Engineering task flow\n\n${DEV_STEPS}`);
  });

  it("marks a workflow that states no title", async () => {
    const { code, out } = await runWorkflow(["show", "dev"], {
      [READ]: ok({ name: "dev", instructions: [], steps: [{ name: "dev:setup", file: "/s.md", owner: "agent" }] }),
    });

    expect(code).toBe(0);
    expect(out).toBe("dev  -\n\ndev:setup  agent  /s.md\n");
  });

  // The order the file declares is meaningful in the format, so nothing here
  // sorts what the route answered.
  it("prints the steps in the order received", async () => {
    const { out } = await runWorkflow(["show", "dev"], {
      [READ]: ok({
        ...DEV,
        steps: [
          { name: "user:review", file: "/rules/dev/user-review.md", owner: "human" },
          { name: "dev:research", file: "/rules/dev/dev-research.md", owner: "agent" },
        ],
      }),
    });

    expect(out).toContain("user:review   human  /rules/dev/user-review.md\ndev:research  agent  /rules/dev/dev-research.md\n");
  });

  it("prints neither the transitions nor a step's extra keys", async () => {
    const { code, out } = await runWorkflow(["show", "dev"], {
      [READ]: ok({
        ...DEV,
        transitions: { "dev:research": "dev:setup" },
        steps: [{ name: "dev:setup", file: "/s.md", owner: "agent", custom: { model: "opus" } }],
      }),
    });

    expect(code).toBe(0);
    expect(out).toBe("dev  Engineering task flow\n\ninstructions  /rules/task-workflow.md\n\ndev:setup  agent  /s.md\n");
  });

  // A step is whatever the port sent too, and one that is no object states no
  // field.
  it("prints a step that is not a record as a row of marks", async () => {
    const { code, out } = await runWorkflow(["show", "dev"], {
      [READ]: ok({ name: "dev", instructions: [], steps: ["dev:setup", null] }),
    });

    expect(code).toBe(0);
    expect(out).toBe("dev  -\n\n-  -  -\n-  -  -\n");
  });

  // The message arrives carrying the path the engine put in front of it, and
  // reaches the terminal as it stands: this noun composes no sentence of its own.
  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const refusal = '/w/nope: there is no directory for the workflow "nope"';
    const { code, out, err } = await runWorkflow(["show", "nope"], {
      "GET /workflows/nope": { ok: false, error: { kind: "store", code: "workflow-unknown", message: refusal } },
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(`tasma: store/workflow-unknown: ${refusal}\n`);
  });

  it("refuses an answer whose steps are not a list", async () => {
    const { code, out, err } = await runWorkflow(["show", "dev"], {
      [READ]: ok({ name: "dev", instructions: [], steps: "dev:setup" }),
    });

    expect(code).toBe(3);
    expect(out).toBe("");
    expect(err).toContain("answered, but not with a workflow");
  });

  it("refuses an answer whose instructions are not a list", async () => {
    const { code, err } = await runWorkflow(["show", "dev"], { [READ]: ok({ ...DEV, instructions: "/rules/one.md" }) });

    expect(code).toBe(3);
    expect(err).toContain("answered, but not with a workflow");
  });

  // An empty value is no value: an unset shell variable names no workflow
  // rather than one called "".
  it("refuses a name it cannot send, and an argument it does not take", async () => {
    await refuses(["show"], "workflow show needs a workflow name");
    await refuses(["show", ""], "workflow show needs a workflow name");
    await refuses(["show", "a/b"], "not a workflow name: a/b");
    await refuses(["show", ".."], "not a workflow name: ..");
    await refuses(["show", "dev", "extra"], "workflow show takes one argument: extra");
  });

  it("prints its usage block before it checks for the name it needs", async () => {
    const { code, out, err, seen } = await runWorkflow(["show", "--help"]);

    expect(code).toBe(0);
    expect(out).toContain("tasma workflow show <name>");
    expect(err).toBe("");
    expect(seen).toEqual([]);
  });
});
