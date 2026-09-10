import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { project } from "../../src/commands/project.js";
import { at, capture, CWD, ok, runCommand, serveAnswers, startServer } from "../helpers.js";
import type { Ran } from "../helpers.js";

/** Runs a verb of this noun against a server answering the table, and reports what it wrote. */
function runProject(args: string[], table: Record<string, unknown> = {}): Promise<Ran> {
  return runCommand(project, args, table);
}

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
