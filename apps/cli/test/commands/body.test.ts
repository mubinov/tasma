import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { appended, readBody } from "../../src/commands/body.js";
import type { BodyFlags } from "../../src/commands/body.js";
import type { Source } from "../../src/types.js";
import { capture, HINT, scratchDir, scratchFile } from "../helpers.js";

/** Reads a body under the flags given, with the text — or the chunks — standard input carries. */
async function read(
  values: BodyFlags,
  stdin: string | Source = "",
): Promise<{ body: string | undefined | number; err: string }> {
  const { io, err } = capture(stdin);

  return { body: await readBody(io, values), err: err.join("") };
}

describe("readBody", () => {
  it("answers nothing where neither flag was given", async () => {
    expect((await read({})).body).toBeUndefined();
  });

  it("answers --body as it was typed", async () => {
    expect((await read({ body: "a body" })).body).toBe("a body");
  });

  // A file the caller pointed at is a deliberate value: nothing about it is
  // trimmed, and no line break is normalised.
  it("answers a file byte for byte, the carriage returns kept", async () => {
    const path = scratchFile("first\r\nsecond\r\n\r\n");

    expect((await read({ "body-file": path })).body).toBe("first\r\nsecond\r\n\r\n");
  });

  it("answers an empty file as an empty body", async () => {
    expect((await read({ "body-file": scratchFile("") })).body).toBe("");
  });

  it("reads standard input to its end where the path is -", async () => {
    expect((await read({ "body-file": "-" }, "from a pipe\n")).body).toBe("from a pipe\n");
  });

  // Decoded chunk by chunk instead, the two halves would answer two replacements.
  it("joins a multi-byte character split across two chunks", async () => {
    const bytes = new TextEncoder().encode("é");
    const chunks = [bytes.slice(0, 1), bytes.slice(1)];

    expect((await read({ "body-file": "-" }, Readable.from(chunks))).body).toBe("é");
  });

  it("takes the string chunks of a source that carries text", async () => {
    expect((await read({ "body-file": "-" }, Readable.from(["one ", "two"]))).body).toBe("one two");
  });

  it("refuses the two flags together, which name two bodies", async () => {
    const { body, err } = await read({ "body": "a", "body-file": "b" });

    expect(body).toBe(2);
    expect(err).toBe(`tasma: --body and --body-file exclude each other\n${HINT}`);
  });

  it("refuses an empty --body", async () => {
    const { body, err } = await read({ body: "" });

    expect(body).toBe(2);
    expect(err).toBe(`tasma: --body needs a value\n${HINT}`);
  });

  it("refuses an empty --body-file", async () => {
    const { body, err } = await read({ "body-file": "" });

    expect(body).toBe(2);
    expect(err).toBe(`tasma: --body-file needs a path\n${HINT}`);
  });

  // The path was typed, so a file that cannot be read is the caller's fault
  // rather than the daemon's, and it is refused before any call.
  it("refuses a path naming no file, quoting the errno code", async () => {
    const path = join(scratchDir(), "absent.md");
    const { body, err } = await read({ "body-file": path });

    expect(body).toBe(2);
    expect(err).toBe(`tasma: cannot read ${path}: ENOENT\n${HINT}`);
  });

  it("refuses a path naming a directory", async () => {
    const dir = scratchDir();
    const { body, err } = await read({ "body-file": dir });

    expect(body).toBe(2);
    expect(err).toBe(`tasma: cannot read ${dir}: EISDIR\n${HINT}`);
  });

  it("quotes the message of a failure that carries no code", async () => {
    const stdin: Source = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("the pipe broke")) }),
    };
    const { body, err } = await read({ "body-file": "-" }, stdin);

    expect(body).toBe(2);
    expect(err).toBe(`tasma: cannot read -: the pipe broke\n${HINT}`);
  });
});

describe("appended", () => {
  it("answers the text alone where the stored body is empty", () => {
    expect(appended("", "more")).toBe("more");
  });

  it("answers the text alone where the stored body holds line breaks alone", () => {
    expect(appended("\n\n\n", "more")).toBe("more");
  });

  it("puts one empty line between a stored body and the text", () => {
    expect(appended("stored", "more")).toBe("stored\n\nmore");
  });

  it("leaves one empty line however many the stored body ended with", () => {
    expect(appended("stored\n\n\n", "more")).toBe("stored\n\nmore");
  });

  it("strips a trailing CRLF as it strips a bare line break", () => {
    expect(appended("stored\r\n\r\n", "more")).toBe("stored\n\nmore");
  });

  // The stored body is whatever the daemon answered, and a run of line breaks
  // that stops short of the end costs a greedy match a retry from every position
  // inside it. The budget is what a walk over the end passes and such a match,
  // seconds deep in backtracking, does not.
  it("answers a stored body holding a long run of line breaks at once", () => {
    const stored = `head${"\n".repeat(50_000)}tail`;
    const started = Date.now();

    expect(appended(stored, "more")).toBe(`${stored}\n\nmore`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("keeps the text as it was given, its own breaks included", () => {
    expect(appended("stored", "one\n\ntwo\n")).toBe("stored\n\none\n\ntwo\n");
  });

  // An empty file and an empty pipe are both bodies, so the join sees an empty
  // text: adding nothing leaves the stored body exactly as it stands, trailing
  // breaks included.
  it("answers the stored body untouched where the text is empty", () => {
    expect(appended("stored\n\n\n", "")).toBe("stored\n\n\n");
    expect(appended("stored", "")).toBe("stored");
    expect(appended("", "")).toBe("");
  });
});
