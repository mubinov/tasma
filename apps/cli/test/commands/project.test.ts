import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { project } from "../../src/commands/project.js";
import { at, capture, CWD, HINT, ok, RESOLVED, resolvedFor, runCommand, serveAnswers, startServer } from "../helpers.js";
import type { Ran } from "../helpers.js";

/** Runs a verb of this noun against a server answering the table, and reports what it wrote. */
function runProject(args: string[], table: Record<string, unknown> = {}, options: { cwd?: string } = {}): Promise<Ran> {
  return runCommand(project, args, table, options);
}

/** Asserts that an invocation was refused from argv alone, with the line it names and no call made. */
async function refuses(args: string[], line: string, options: { cwd?: string } = {}): Promise<void> {
  const { code, out, err, seen } = await runProject(args, {}, options);

  expect(code, args.join(" ")).toBe(2);
  expect(out, args.join(" ")).toBe("");
  expect(err, args.join(" ")).toBe(`tasma: ${line}\n${HINT}`);
  expect(seen, args.join(" ")).toEqual([]);
}

const READ = "GET /projects/TASM";

/** A configuration as the engine resolves one for a project that states no file. */
const CONFIG = {
  statuses: ["Backlog", "To Do", "In Progress", "Done"],
  default_status: "Backlog",
  final_statuses: ["Done"],
  priorities: ["high", "medium", "low"],
  workflows: [],
  instructions: [],
};

/** The project the read answers, live. */
const PROJECT = { tag: "TASM", name: "tasma", path: "/Users/x/Projects/tasma", config: CONFIG, live: true };

describe("project list", () => {
  it("prints the tag, the name and the path of every project, aligned", async () => {
    const { code, out, err, seen } = await runProject(["list"], {
      "GET /projects": ok([
        { tag: "TASM", name: "tasma", path: "/Users/x/Projects/tasma" },
        { tag: "DOB", name: "dobby", path: "/Users/x/Projects/dobby" },
      ]),
    });

    expect(code).toBe(0);
    expect(out).toBe("TASM  tasma  /Users/x/Projects/tasma\nDOB   dobby  /Users/x/Projects/dobby\n");
    expect(err).toBe("");
    expect(seen).toEqual(["GET /projects"]);
  });

  // A project that declares no configuration file states neither field, and the
  // columns after it have to stay where they are.
  it("marks a project that states no name and no path", async () => {
    const { code, out } = await runProject(["list"], { "GET /projects": ok([{ tag: "TASM" }]) });

    expect(code).toBe(0);
    expect(out).toBe("TASM  -  -\n");
  });

  it("prints nothing at all for a tree that holds no project", async () => {
    const { code, out, err } = await runProject(["list"], { "GET /projects": ok([]) });

    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toBe("");
  });

  it("refuses an argument of its own", async () => {
    const { code, out, err } = await runProject(["list", "TASM"], { "GET /projects": ok([]) });

    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toBe("tasma: project list takes no arguments: TASM\nRun 'tasma --help' for usage.\n");
  });

  it("reports an unknown flag through the parser's own message", async () => {
    const { code, err } = await runProject(["list", "--nope"], { "GET /projects": ok([]) });

    expect(code).toBe(2);
    expect(err).toContain("tasma: Unknown option '--nope'");
  });

  it("prints its usage block for --help and -h, reaching no daemon", async () => {
    for (const flag of ["--help", "-h"]) {
      const { code, out, err, seen } = await runProject(["list", flag]);

      expect(code).toBe(0);
      expect(out).toContain("tasma project list");
      expect(err).toBe("");
      expect(seen).toEqual([]);
    }
  });

  // The answer is whatever the port sent, so the shape the writer needs is
  // tested before a field is read off it.
  it("refuses an answer that is not a project listing", async () => {
    const { code, out, err } = await runProject(["list"], { "GET /projects": ok({ tag: "TASM" }) });

    expect(code).toBe(3);
    expect(out).toBe("");
    expect(err).toContain("answered, but not with a project listing");
  });

  // An element is whatever the port sent too, and one that is no object states
  // no field.
  it("prints a listing element that is not a record as a row of marks", async () => {
    const { code, out } = await runProject(["list"], { "GET /projects": ok(["TASM", null]) });

    expect(code).toBe(0);
    expect(out).toBe("-  -  -\n-  -  -\n");
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runProject(["list"], {
      "GET /projects": { ok: false, error: { kind: "store", code: "index-closed", message: "this daemon is closing" } },
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("tasma: store/index-closed: this daemon is closing\n");
  });

  it("writes the notes of the answer after the table", async () => {
    const answers = serveAnswers({
      "GET /projects": ok([{ tag: "TASM" }], [
        { code: "path-missing", message: "the project path does not name a directory", path: "/gone" },
      ]),
    });
    const server = await startServer(answers.handle);
    const { io, out, err } = capture();

    try {
      expect(await project.run(["list"], io, at(server.url), CWD)).toBe(0);
    } finally {
      await server.close();
    }

    expect(out.join("")).toBe("TASM  -  -\n");
    expect(err.join("")).toBe("tasma: note: path-missing: the project path does not name a directory (/gone)\n");
  });
});

describe("project view", () => {
  it("prints one key per row in the config.yml order, a list one value per row", async () => {
    const { code, out, err, seen } = await runProject(["view", "TASM"], {
      [READ]: ok({ ...PROJECT, config: { ...CONFIG, workflows_path: "/Users/x/.tasma/workflows" } }),
    });

    expect(code).toBe(0);
    expect(out).toBe(
      "tag             TASM\n"
      + "name            tasma\n"
      + "path            /Users/x/Projects/tasma\n"
      + "statuses        Backlog\n"
      + "                To Do\n"
      + "                In Progress\n"
      + "                Done\n"
      + "default_status  Backlog\n"
      + "final_statuses  Done\n"
      + "priorities      high\n"
      + "                medium\n"
      + "                low\n"
      + "workflows       -\n"
      + "instructions    -\n"
      + "workflows_path  /Users/x/.tasma/workflows\n",
    );
    expect(err).toBe("");
    expect(seen).toEqual([READ]);
  });

  it("marks an absent value and an empty list", async () => {
    const { code, out } = await runProject(["view", "TASM"], {
      [READ]: ok({ tag: "TASM", config: { statuses: [], instructions: ["/r.md"] }, live: true }),
    });

    expect(code).toBe(0);
    expect(out).toBe(
      "tag             TASM\n"
      + "name            -\n"
      + "path            -\n"
      + "statuses        -\n"
      + "default_status  -\n"
      + "final_statuses  -\n"
      + "priorities      -\n"
      + "workflows       -\n"
      + "instructions    /r.md\n"
      + "workflows_path  -\n",
    );
  });

  it("prints a list value that is not an array as one cell", async () => {
    const { code, out } = await runProject(["view", "TASM"], {
      [READ]: ok({ ...PROJECT, config: { ...CONFIG, statuses: "Done" } }),
    });

    expect(code).toBe(0);
    expect(out).toContain("statuses        Done\ndefault_status  Backlog\n");
  });

  it("notes an index that is not following the disk, ahead of the notes of the answer", async () => {
    const { code, out, err } = await runProject(["view", "TASM"], {
      [READ]: ok({ ...PROJECT, live: false }, [{ code: "config-unreadable", message: "refused", path: "/c" }]),
    });

    expect(code).toBe(0);
    expect(out).toContain("tag             TASM\n");
    expect(err).toBe(
      "tasma: note: the index of TASM is not following the disk; "
      + "what the daemon reports about this project can be older than the files\n"
      + "tasma: note: config-unreadable: refused (/c)\n",
    );
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runProject(["view", "TASM"], {
      [READ]: {
        ok: false,
        error: { kind: "store", code: "project-not-found", message: 'no project of this tree is tagged "TASM"' },
      },
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe('tasma: store/project-not-found: no project of this tree is tagged "TASM"\n');
  });

  it("refuses an answer that is not a project", async () => {
    for (const data of ["TASM", null, { tag: "TASM" }, { ...PROJECT, config: "x" }, { ...PROJECT, config: null }]) {
      const { code, out, err } = await runProject(["view", "TASM"], { [READ]: ok(data) });

      expect(code, JSON.stringify(data)).toBe(3);
      expect(out, JSON.stringify(data)).toBe("");
      expect(err, JSON.stringify(data)).toContain("answered, but not with a project\n");
    }
  });

  it("refuses every fault in its argument, before it reaches a daemon", async () => {
    await refuses(["view"], "project view needs a project tag");
    await refuses(["view", ""], "project view needs a project tag");
    await refuses(["view", "a/b"], "not a project tag: a/b");
    await refuses(["view", ".."], "not a project tag: ..");
    await refuses(["view", "TASM", "extra"], "project view takes one argument: extra");
  });
});

describe("project current", () => {
  it("prints the tag alone, from one unproven call", async () => {
    const { code, out, err, seen } = await runProject(["current"], { [RESOLVED]: ok({ tag: "TASM", path: CWD }) });

    expect(code).toBe(0);
    expect(out).toBe("TASM\n");
    expect(err).toBe("");
    expect(seen).toEqual([RESOLVED]);
  });

  it("refuses a directory no project holds, after the notes of the answer", async () => {
    const { code, out, err } = await runProject(["current"], {
      [RESOLVED]: ok(null, [{ code: "config-unreadable", message: "project OTHER was refused", path: "/x" }]),
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(
      "tasma: note: config-unreadable: project OTHER was refused (/x)\n"
      + `tasma: project not found for the directory ${CWD}\n`,
    );
  });

  it("escapes a directory that carries a control character", async () => {
    const { code, err } = await runProject(["current"], { [resolvedFor("/srv/a\nb")]: ok(null) }, { cwd: "/srv/a\nb" });

    expect(code).toBe(1);
    expect(err).toBe("tasma: project not found for the directory /srv/a\\u000ab\n");
  });

  it("refuses a working directory the entry point could not read", async () => {
    await refuses(["current"], "the working directory could not be read", { cwd: "" });
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runProject(["current"], {
      [RESOLVED]: {
        ok: false,
        error: { kind: "store", code: "path-invalid", message: "/srv/repo: this path names no directory" },
      },
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("tasma: store/path-invalid: /srv/repo: this path names no directory\n");
  });

  it("refuses an answer that is not a project", async () => {
    for (const data of ["TASM", { tag: 7 }, {}, { tag: "a/b" }, { tag: ".." }]) {
      const { code, out, err } = await runProject(["current"], { [RESOLVED]: ok(data) });

      expect(code, JSON.stringify(data)).toBe(3);
      expect(out, JSON.stringify(data)).toBe("");
      expect(err, JSON.stringify(data)).toContain("answered, but not with a project\n");
    }
  });

  it("refuses an argument of its own", async () => {
    await refuses(["current", "TASM"], "project current takes no arguments: TASM");
  });
});
