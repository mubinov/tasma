import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { task } from "../../src/commands/task.js";
import { taskIdOf } from "../../src/commands/task-id.js";
import { at, capture, ok, runCommand } from "../helpers.js";
import type { Ran } from "../helpers.js";

/** Runs a verb of this noun against a server answering the table, and reports what it wrote. */
function runTask(args: string[], table: Record<string, unknown> = {}): Promise<Ran> {
  return runCommand(task, args, table);
}

/** The call a verb made, as the server saw it, for a case asserting the call rather than the answer. */
async function pathOf(args: string[]): Promise<string> {
  const { seen } = await runTask(args);

  return seen[0] ?? "";
}

const LISTING = "GET /projects/TASM/tasks";
const TEXT = "GET /projects/TASM/tasks/TASM-1/text?collapsed=false";
const FULL = "GET /projects/TASM/tasks/TASM-1/text";

const ENTRIES = ok({
  entries: [
    { frontmatter: { id: "TASM-1", status: "To Do", priority: "high", step: "dev:setup", title: "First" } },
    { frontmatter: { id: "TASM-12", status: "Done", title: "Second" } },
  ],
  excluded: [],
});

describe("task list", () => {
  it("sends the project alone where no filter was stated", async () => {
    expect(await pathOf(["list", "--project", "TASM"])).toBe("GET /projects/TASM/tasks");
  });

  it("takes -p as --project", async () => {
    expect(await pathOf(["list", "-p", "TASM"])).toBe("GET /projects/TASM/tasks");
  });

  // Every value goes to the daemon as typed: the CLI lowercases nothing, trims
  // nothing and matches nothing.
  it("sends each filter as its own key, with the value as it was typed", async () => {
    const path = await pathOf([
      "list", "--project", "TASM", "--status", "To Do", "--priority", "Medium",
      "--parent", "TASM-15", "--step", "dev:implement",
    ]);

    expect(path).toBe("GET /projects/TASM/tasks?status=To%20Do&priority=Medium&parent=TASM-15&step=dev%3Aimplement");
  });

  it("repeats --label, which the daemon reads as a conjunction", async () => {
    expect(await pathOf(["list", "-p", "TASM", "--label", "a", "--label", "b"]))
      .toBe("GET /projects/TASM/tasks?label=a&label=b");
  });

  // An unset shell variable expands to an empty value, and sent as one it would
  // widen the listing to every task at exit 0 as though the filter had matched.
  it("sends no key for a filter whose value is empty", async () => {
    const path = await pathOf([
      "list", "-p", "TASM", "--status", "", "--priority", "", "--parent", "", "--step", "", "--label", "",
    ]);

    expect(path).toBe("GET /projects/TASM/tasks");
  });

  it("drops an empty label and keeps the ones stated beside it", async () => {
    expect(await pathOf(["list", "-p", "TASM", "--label", "", "--label", "a"]))
      .toBe("GET /projects/TASM/tasks?label=a");
  });

  it("sends --blocked and --unblocked as the two spellings of one key", async () => {
    expect(await pathOf(["list", "-p", "TASM", "--blocked"])).toBe("GET /projects/TASM/tasks?blocked=true");
    expect(await pathOf(["list", "-p", "TASM", "--unblocked"])).toBe("GET /projects/TASM/tasks?blocked=false");
  });

  it("refuses the two together, which name no set of tasks", async () => {
    const { code, out, err, seen } = await runTask(["list", "-p", "TASM", "--blocked", "--unblocked"]);

    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toBe("tasma: --blocked and --unblocked exclude each other\nRun 'tasma --help' for usage.\n");
    expect(seen).toEqual([]);
  });

  // Nothing is inferred from the working directory, so the project is stated or
  // the verb does not run.
  it("refuses to run without a project, an empty one included", async () => {
    for (const args of [["list"], ["list", "--project", ""]]) {
      const { code, err, seen } = await runTask(args);

      expect(code).toBe(2);
      expect(err).toBe("tasma: task list needs --project <tag>\nRun 'tasma --help' for usage.\n");
      expect(seen).toEqual([]);
    }
  });

  it("refuses a project tag that is not one path component", async () => {
    for (const tag of ["..", "a/b"]) {
      const { code, err, seen } = await runTask(["list", "--project", tag]);

      expect(code).toBe(2);
      expect(err).toBe(`tasma: not a project tag: ${tag}\nRun 'tasma --help' for usage.\n`);
      expect(seen).toEqual([]);
    }
  });

  it("refuses an argument of its own", async () => {
    const { code, err } = await runTask(["list", "-p", "TASM", "TASM-1"]);

    expect(code).toBe(2);
    expect(err).toContain("tasma: task list takes no arguments: TASM-1");
  });

  it("reports an unknown flag through the parser's own message", async () => {
    const { code, err } = await runTask(["list", "-p", "TASM", "--nope"]);

    expect(code).toBe(2);
    expect(err).toContain("tasma: Unknown option '--nope'");
  });

  it("prints the id, the status, the priority, the step and the title, aligned", async () => {
    const { code, out, err } = await runTask(["list", "-p", "TASM"], { [LISTING]: ENTRIES });

    expect(code).toBe(0);
    expect(out).toBe(
      "TASM-1   To Do  high  dev:setup  First\n"
      + "TASM-12  Done   -     -          Second\n",
    );
    expect(err).toBe("");
  });

  // A caveat on the completeness of the listing rather than a result, so it goes
  // to the other stream, after the answer it qualifies.
  it("names every excluded file on stderr, after the table", async () => {
    const { code, out, err } = await runTask(["list", "-p", "TASM"], {
      [LISTING]: ok({
        entries: [{ frontmatter: { id: "TASM-1", status: "To Do", title: "First" } }],
        excluded: [
          { path: "/x/TASM-3.md", code: "task-file-foreign", message: 'this file carries the id "OTHER-3"' },
          { path: "/x/TASM-4.md", code: "task-file-unreadable", message: "this file could not be read" },
        ],
      }),
    });

    expect(code).toBe(0);
    expect(out).toBe("TASM-1  To Do  -  -  First\n");
    expect(err).toBe(
      'tasma: excluded: /x/TASM-3.md: task-file-foreign: this file carries the id "OTHER-3"\n'
      + "tasma: excluded: /x/TASM-4.md: task-file-unreadable: this file could not be read\n",
    );
  });

  it("prints nothing at all for a listing that matched no task", async () => {
    const { code, out, err } = await runTask(["list", "-p", "TASM"], { [LISTING]: ok({ entries: [], excluded: [] }) });

    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toBe("");
  });

  it("refuses an answer that is not a task listing", async () => {
    for (const data of [{ entries: {}, excluded: [] }, { entries: [] }, []]) {
      const { code, out, err } = await runTask(["list", "-p", "TASM"], { [LISTING]: ok(data) });

      expect(code).toBe(3);
      expect(out).toBe("");
      expect(err).toContain("answered, but not with a task listing");
    }
  });

  it("prints an entry that is not a record as a row of marks", async () => {
    const { code, out } = await runTask(["list", "-p", "TASM"],
      { [LISTING]: ok({ entries: ["TASM-1"], excluded: [null] }) });

    expect(code).toBe(0);
    expect(out).toBe("-  -  -  -  -\n");
  });
});

describe("task view", () => {
  it("asks for the file without the collapsed bodies, and with --full for all of it", async () => {
    expect(await pathOf(["view", "TASM-1"])).toBe("GET /projects/TASM/tasks/TASM-1/text?collapsed=false");
    expect(await pathOf(["view", "TASM-1", "--full"])).toBe("GET /projects/TASM/tasks/TASM-1/text");
  });

  it("writes the text as the file holds it, adding the one break the prompt needs", async () => {
    const { code, out, err } = await runTask(["view", "TASM-1", "--full"],
      { [FULL]: ok({ text: "---\nid: TASM-1\n---\n\n# Goal", hidden: [] }) });

    expect(code).toBe(0);
    expect(out).toBe("---\nid: TASM-1\n---\n\n# Goal\n");
    expect(err).toBe("");
  });

  it("adds no second break to a text that ends with one", async () => {
    const { out } = await runTask(["view", "TASM-1", "--full"], { [FULL]: ok({ text: "# Goal\n", hidden: [] }) });

    expect(out).toBe("# Goal\n");
  });

  // The default hides a body, so the reader is told what was left out and how to
  // read it.
  it("names the comments it left out, and how to read them", async () => {
    const one = await runTask(["view", "TASM-1"], { [TEXT]: ok({ text: "x", hidden: [2] }) });
    const three = await runTask(["view", "TASM-1"], { [TEXT]: ok({ text: "x", hidden: [2, 5, 7] }) });

    expect(one.err).toBe("tasma: 1 comment collapsed (2): task comment TASM-1 <n> prints one, --full prints all\n");
    expect(three.err)
      .toBe("tasma: 3 comments collapsed (2, 5, 7): task comment TASM-1 <n> prints one, --full prints all\n");
  });

  it("names none where the read left nothing out", async () => {
    const { err } = await runTask(["view", "TASM-1", "--full"], { [FULL]: ok({ text: "x", hidden: [] }) });

    expect(err).toBe("");
  });

  it("refuses an answer that is not a task's text", async () => {
    for (const data of [{ text: 1, hidden: [] }, { text: "x", hidden: 2 }, "x"]) {
      const { code, out, err } = await runTask(["view", "TASM-1"], { [TEXT]: ok(data) });

      expect(code).toBe(3);
      expect(out).toBe("");
      expect(err).toContain("answered, but not with a task's text");
    }
  });

  it("refuses a verb given no id, and one given more than it takes", async () => {
    const none = await runTask(["view"]);
    const extra = await runTask(["view", "TASM-1", "TASM-2"]);

    expect(none.code).toBe(2);
    expect(none.err).toContain("tasma: task view needs a task id");
    expect(extra.code).toBe(2);
    expect(extra.err).toContain("tasma: task view takes one argument: TASM-2");
  });
});

describe("task comments", () => {
  const MAP = "GET /projects/TASM/tasks/TASM-1/comments";

  it("prints the id, the lines, the size, whether it is collapsed, and who wrote what when", async () => {
    const { code, out, err } = await runTask(["comments", "TASM-1"], {
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

  // A comment that went through JSON without its parsed source carries no range.
  it("marks a comment whose header carries no line range", async () => {
    const { out } = await runTask(["comments", "TASM-1"],
      { [MAP]: ok([{ id: 1, bytes: 4, created: "x", title: "t" }]) });

    expect(out).toBe("1  -  4  -  x  -  t\n");
  });

  it("prints nothing at all for a task with no comments", async () => {
    const { code, out, err } = await runTask(["comments", "TASM-1"], { [MAP]: ok([]) });

    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toBe("");
  });

  it("refuses an answer that is not a comment map", async () => {
    const { code, err } = await runTask(["comments", "TASM-1"], { [MAP]: ok({ id: 1 }) });

    expect(code).toBe(3);
    expect(err).toContain("answered, but not with a comment map");
  });

  it("refuses a verb given no id, one given more than it takes, and an unknown flag", async () => {
    const none = await runTask(["comments"]);
    const extra = await runTask(["comments", "TASM-1", "TASM-2"]);
    const unknown = await runTask(["comments", "--nope"]);

    expect(none.code).toBe(2);
    expect(none.err).toContain("tasma: task comments needs a task id");
    expect(extra.code).toBe(2);
    expect(extra.err).toContain("tasma: task comments takes one argument: TASM-2");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("tasma: Unknown option '--nope'");
  });
});

describe("task comment", () => {
  it("asks for the one comment, and prints it alone", async () => {
    const answers = {
      "GET /projects/TASM/tasks/TASM-1/text?comment=3": ok({ text: "<!-- m -->\n\nbody", hidden: [] }),
    };
    const { code, out, err } = await runTask(["comment", "TASM-1", "3"], answers);

    expect(code).toBe(0);
    expect(out).toBe("<!-- m -->\n\nbody\n");
    expect(err).toBe("");
  });

  it("refuses a comment id that is not a whole number the daemon can carry", async () => {
    for (const id of ["x", "1.5", "9007199254740993"]) {
      const { code, err, seen } = await runTask(["comment", "TASM-1", id]);

      expect(code).toBe(2);
      expect(err).toContain(`tasma: not a comment id: ${id}`);
      expect(seen).toEqual([]);
    }
  });

  it("refuses a verb given no comment id, one given more than it takes, and an unknown flag", async () => {
    const none = await runTask(["comment", "TASM-1"]);
    const extra = await runTask(["comment", "TASM-1", "3", "4"]);
    const unknown = await runTask(["comment", "--nope"]);

    expect(none.code).toBe(2);
    expect(none.err).toContain("tasma: task comment needs a comment id");
    expect(extra.code).toBe(2);
    expect(extra.err).toContain("tasma: task comment takes two arguments: 4");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("tasma: Unknown option '--nope'");
  });

  it("refuses a task id that names no tag before the comment id is read", async () => {
    const { code, err } = await runTask(["comment", "foo", "3"]);

    expect(code).toBe(2);
    expect(err).toContain("tasma: not a task id: foo");
  });

  it("refuses an answer that is not a task's text", async () => {
    const { code, out, err } = await runTask(
      ["comment", "TASM-1", "3"],
      { "GET /projects/TASM/tasks/TASM-1/text?comment=3": ok({ text: 1, hidden: [] }) },
    );

    expect(code).toBe(3);
    expect(out).toBe("");
    expect(err).toContain("answered, but not with a task's text");
  });
});

describe("the id a read verb is given", () => {
  it("carries the project tag the call is made against", async () => {
    expect(await pathOf(["view", "TASM-1"])).toBe("GET /projects/TASM/tasks/TASM-1/text?collapsed=false");
    expect(await pathOf(["comments", "TASM-1"])).toBe("GET /projects/TASM/tasks/TASM-1/comments");
  });

  // Refused here rather than thrown out of buildPath, which raises a plain Error
  // that would reach the caller as a stack trace.
  it("is refused where it names no tag, or where either part is not one path component", async () => {
    for (const id of ["foo", "TASM-", "..-1", "a/b-1"]) {
      const { code, err, seen } = await runTask(["view", id]);

      expect(code).toBe(2);
      expect(err).toContain(`tasma: not a task id: ${id}`);
      expect(seen).toEqual([]);
    }
  });

  // The strict parser reads a token opening with a dash as an option, so it
  // never reaches the id rule.
  it("is read as an option where it opens with a dash", async () => {
    const { code, err } = await runTask(["view", "-x"]);

    expect(code).toBe(2);
    expect(err).toContain("tasma: ");
    expect(err).not.toContain("not a task id");
  });

  // A break that survives is a second, well-formed `tasma: ` line, which reads
  // as a diagnostic the CLI never wrote.
  it("escapes a line break an argument carried into the parser's message", async () => {
    const { code, err } = await runTask(["view", "--no\ntasma: forged"]);
    const lines = err.split("\n").filter((line) => line !== "");

    expect(code).toBe(2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("tasma: Unknown option '--no\\u000atasma: forged'");
    expect(lines[1]).toBe("Run 'tasma --help' for usage.");
  });
});

describe("taskIdOf", () => {
  it("splits at the first dash, and keeps the whole text as the id", () => {
    expect(taskIdOf("TASM-47")).toEqual({ tag: "TASM", id: "TASM-47" });
    expect(taskIdOf("TASM-47-2")).toEqual({ tag: "TASM", id: "TASM-47-2" });
  });

  it("names no id where either part is empty or unusable", () => {
    for (const text of ["foo", "-1", "TASM-", "", "..-1", "a/b-1", "TASM-a/b"]) {
      expect(taskIdOf(text), text).toBeUndefined();
    }
  });
});

describe("the task noun", () => {
  it("lists its seven verbs for a bare noun", async () => {
    const { io, out } = capture();

    expect(await task.run([], io, at("http://127.0.0.1:8278"))).toBe(0);

    for (const verb of ["list", "view", "comments", "comment", "create", "edit", "delete"]) {
      expect(out.join("")).toContain(`  ${verb}`);
    }
  });

  it("prints a usage block for every verb, reaching no daemon", async () => {
    for (const verb of ["list", "view", "comments", "comment", "create", "edit", "delete"]) {
      for (const flag of ["--help", "-h"]) {
        const { code, out, err, seen } = await runTask([verb, flag]);

        expect(code, `${verb} ${flag}`).toBe(0);
        expect(out).toContain(`tasma task ${verb}`);
        expect(err).toBe("");
        expect(seen).toEqual([]);
      }
    }
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runTask(["view", "TASM-1"], {
      [TEXT]: { ok: false, error: { kind: "store", code: "task-not-found", message: "no task TASM-1" } },
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("tasma: store/task-not-found: no task TASM-1\n");
  });

  // `attempt` writes the notes after the writer returns, so the verb's own lines
  // come first however the answer arrived.
  it("writes the notes of the answer after the lines the verb wrote itself", async () => {
    const { code, err } = await runTask(["view", "TASM-1"], {
      [TEXT]: ok({ text: "x", hidden: [2] }, [{ code: "workflow-unknown", message: "no workflow dev" }]),
    });

    expect(code).toBe(0);
    expect(err).toBe(
      "tasma: 1 comment collapsed (2): task comment TASM-1 <n> prints one, --full prints all\n"
      + "tasma: note: workflow-unknown: no workflow dev\n",
    );
  });
});
