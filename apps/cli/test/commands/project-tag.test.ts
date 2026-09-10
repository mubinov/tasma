import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { actingProject } from "../../src/commands/project-tag.js";
import { at, capture, CWD, HEALTH, HINT, ok, RESOLVED, resolvedFor, serveAnswers, startServer } from "../helpers.js";

/** The summary the route answers, of which the helper reads the tag alone. */
const PROJECT = ok({ tag: "TASM", name: "Tasma", path: CWD });

/** What one resolution answered, what it wrote, and the calls the server saw. */
type Resolution = { answer: string | number; out: string; err: string; seen: string[] };

/** Resolves against a server answering the table, and reports what the helper answered and wrote. */
async function resolve(
  table: Record<string, unknown>,
  asked: { command?: string; stated?: string; cwd?: string; prove?: boolean } = {},
): Promise<Resolution> {
  const answers = serveAnswers(table);
  const server = await startServer(answers.handle);
  const { io, out, err } = capture();

  try {
    const answer = await actingProject(io, at(server.url), {
      command: asked.command ?? "task list",
      stated: asked.stated,
      cwd: asked.cwd ?? CWD,
      prove: asked.prove,
    });

    return { answer, out: out.join(""), err: err.join(""), seen: answers.seen };
  } finally {
    await server.close();
  }
}

describe("the project a verb acts on", () => {
  it("answers the stated tag without calling the daemon", async () => {
    const { answer, err, seen } = await resolve({}, { stated: "OTHER" });

    expect(answer).toBe("OTHER");
    expect(err).toBe("");
    expect(seen).toEqual([]);
  });

  // An unset shell variable expands to an empty value: `-p "$PROJ"` names no
  // project, and resolving from the directory in its place would write into
  // whatever project the caller happens to stand in.
  it("refuses an empty tag rather than resolving in its place", async () => {
    const { answer, err, seen } = await resolve({}, { stated: "", command: "task create" });

    expect(answer).toBe(2);
    expect(err).toBe(`tasma: task create needs --project <tag>\n${HINT}`);
    expect(seen).toEqual([]);
  });

  it("refuses a stated tag that is not one path component", async () => {
    const { answer, err, seen } = await resolve({}, { stated: "a/b" });

    expect(answer).toBe(2);
    expect(err).toBe(`tasma: not a project tag: a/b\n${HINT}`);
    expect(seen).toEqual([]);
  });

  it("sends the directory as it stands and answers the tag the reply carried", async () => {
    const { answer, seen } = await resolve({ [RESOLVED]: PROJECT });

    expect(answer).toBe("TASM");
    expect(seen).toEqual([RESOLVED]);
  });

  it("names the project and the directory on stderr, and writes nothing on stdout", async () => {
    const { out, err } = await resolve({ [RESOLVED]: PROJECT });

    expect(out).toBe("");
    expect(err).toBe("tasma: project TASM, from /srv/repo\n");
  });

  it("refuses a directory no project holds, pointing at the flag", async () => {
    const { answer, out, err, seen } = await resolve({ [RESOLVED]: ok(null) });

    expect(answer).toBe(2);
    expect(out).toBe("");
    expect(err).toBe(`tasma: no project holds /srv/repo; state one with --project <tag>\n${HINT}`);
    expect(seen).toEqual([RESOLVED]);
  });

  it("refuses an answer that is not a project", async () => {
    for (const data of ["TASM", 7, { tag: 7 }, {}]) {
      const { answer, out, err } = await resolve({ [RESOLVED]: ok(data) });

      expect(answer, JSON.stringify(data)).toBe(3);
      expect(out, JSON.stringify(data)).toBe("");
      expect(err, JSON.stringify(data)).toContain("answered, but not with a project");
    }
  });

  it("refuses a tag no path component can hold", async () => {
    for (const tag of ["", ".", "..", "a/b"]) {
      const { answer, out, err } = await resolve({ [RESOLVED]: ok({ tag }) });

      expect(answer, tag).toBe(3);
      expect(out, tag).toBe("");
      expect(err, tag).toContain("answered, but not with a project");
    }
  });

  it("refuses a working directory the entry point could not read", async () => {
    const { answer, err, seen } = await resolve({}, { cwd: "" });

    expect(answer).toBe(2);
    expect(err).toBe(`tasma: the working directory could not be read; state a project with --project <tag>\n${HINT}`);
    expect(seen).toEqual([]);
  });

  it("proves the address ahead of the call where the verb asked for it", async () => {
    const proved = await resolve({ [RESOLVED]: PROJECT }, { prove: true });

    expect(proved.seen).toEqual([HEALTH, RESOLVED]);

    const plain = await resolve({ [RESOLVED]: PROJECT });

    expect(plain.seen).toEqual([RESOLVED]);
  });

  it("writes the findings of the comparison before it refuses the directory", async () => {
    const { answer, err } = await resolve({
      [RESOLVED]: ok(null, [{ code: "config-unreadable", message: "project OTHER was refused", path: "/x" }]),
    });

    expect(answer).toBe(2);
    expect(err).toBe(
      "tasma: note: config-unreadable: project OTHER was refused (/x)\n"
      + `tasma: no project holds /srv/repo; state one with --project <tag>\n${HINT}`,
    );
  });

  // A directory removed between the read of it and the request: the daemon says
  // so, and the refusal is written by the path every refusal takes.
  it("leaves a refusal from the daemon to be reported as one", async () => {
    const { answer, out, err } = await resolve({
      [RESOLVED]: {
        ok: false,
        error: { kind: "store", code: "path-invalid", message: "/srv/repo: this path names no directory" },
      },
    });

    expect(answer).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("tasma: store/path-invalid: /srv/repo: this path names no directory\n");
  });

  // A tag is whatever answered the port, and a directory name may legally hold
  // a line break on a POSIX filesystem.
  it("escapes a tag and a directory that carry a control character", async () => {
    const { err } = await resolve(
      { [resolvedFor("/srv/a\nb")]: ok({ tag: "TA\nSM" }) },
      { cwd: "/srv/a\nb" },
    );

    expect(err).toBe("tasma: project TA\\u000aSM, from /srv/a\\u000ab\n");
  });
});
