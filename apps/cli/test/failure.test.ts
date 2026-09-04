import { ProtocolError, TransportError } from "@tasma/protocol";
import type { Diagnostic, Success } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { REQUEST_TIMEOUT_MS, RequestTimeoutError } from "../src/daemon/transport.js";
import { attempt, reportForeign } from "../src/failure.js";
import { capture } from "./helpers.js";

const DAEMON_URL = "http://127.0.0.1:8278";

function ok<T>(data: T, diagnostics: Diagnostic[] = []): () => Promise<Success<T>> {
  return () => Promise.resolve({ data, diagnostics });
}

function throwing(error: Error): () => Promise<never> {
  return () => Promise.reject(error);
}

/** A value `JSON.parse` accepts and `JSON.stringify` overflows the stack rendering. */
function nested(depth: number): unknown {
  let value: unknown = null;

  for (let level = 0; level < depth; level += 1) value = [value];

  return value;
}

describe("attempt", () => {
  it("prints the answer, then the diagnostics, and returns the code print chose", async () => {
    const { io, out, err } = capture();
    const diagnostics: Diagnostic[] = [
      { code: "label-case-converted", message: "the label was stored lowercased", path: "/tasks/A-1.md", line: 4 },
      { code: "temp-file-left", message: "a temporary file was left behind", path: "/tasks" },
      { code: "index-watch-failed", message: "the index is not watching" },
    ];

    const code = await attempt(io, DAEMON_URL, ok("payload", diagnostics), (data) => {
      io.stdout.write(`${data}\n`);
      return 0;
    });

    expect(code).toBe(0);
    expect(out.join("")).toBe("payload\n");
    expect(err).toEqual([
      "tasma: note: label-case-converted: the label was stored lowercased (/tasks/A-1.md:4)\n",
      "tasma: note: temp-file-left: a temporary file was left behind (/tasks)\n",
      "tasma: note: index-watch-failed: the index is not watching\n",
    ]);
  });

  // A number on its own names no location.
  it("prints no parenthetical for a diagnostic carrying a line and no path", async () => {
    const { io, err } = capture();
    const diagnostic: Diagnostic = { code: "step-stale", message: "the step is stale", line: 9 };

    await attempt(io, DAEMON_URL, ok(null, [diagnostic]), () => 0);

    expect(err.join("")).toBe("tasma: note: step-stale: the step is stale\n");
  });

  // The contract `daemon status` depends on: attempt classifies the call, print
  // classifies the content.
  it("returns the code print chose rather than 0", async () => {
    const { io } = capture();

    expect(await attempt(io, DAEMON_URL, ok("payload"), () => 3)).toBe(3);
  });

  // The envelope check reads the diagnostics as an array and no further, so an
  // element is whatever answered the port, and a line already on stdout must not
  // be followed by a stack trace.
  it("skips a note that is not an object, behind an answer it has already printed", async () => {
    const { io, out, err } = capture();
    const wire: unknown[] = [null, "note", 7, { code: "step-stale", message: "the step is stale" }];

    const code = await attempt(io, DAEMON_URL, ok("payload", wire as Diagnostic[]), (data) => {
      io.stdout.write(`${data}\n`);
      return 0;
    });

    expect(code).toBe(0);
    expect(out.join("")).toBe("payload\n");
    expect(err).toEqual(["tasma: note: step-stale: the step is stale\n"]);
  });

  it("prints a note whose every field refuses to coerce, behind an answer it has already printed", async () => {
    const { io, out, err } = capture();
    const hostile = { toString: "x" };
    const text = '{"toString":"x"}';
    const wire = [{ code: hostile, message: hostile, path: hostile, line: hostile }];

    const code = await attempt(io, DAEMON_URL, ok("payload", wire as unknown as Diagnostic[]), (data) => {
      io.stdout.write(`${data}\n`);
      return 0;
    });

    expect(code).toBe(0);
    expect(out.join("")).toBe("payload\n");
    expect(err.join("")).toBe(`tasma: note: ${text}: ${text} (${text}:${text})\n`);
  });

  // The renderer that carries a field which refuses to coerce recurses, and the
  // wire can nest deeper than it has stack for.
  it("prints a note too deeply nested to render, behind an answer it has already printed", async () => {
    const { io, out, err } = capture();
    const deep = nested(30_000);
    const wire = [{ code: deep, message: deep, path: deep, line: deep }];

    const code = await attempt(io, DAEMON_URL, ok("payload", wire as unknown as Diagnostic[]), (data) => {
      io.stdout.write(`${data}\n`);
      return 0;
    });

    expect(code).toBe(0);
    expect(out.join("")).toBe("payload\n");
    expect(err.join("")).toBe("tasma: note: [unprintable]: [unprintable] ([unprintable]:[unprintable])\n");
  });

  // The notes came from whatever sent the answer, so they say nothing once the
  // answer itself has been declined.
  it("writes no diagnostics behind an answer print refused", async () => {
    const { io, err } = capture();
    const diagnostic: Diagnostic = { code: "index-watch-failed", message: "the index is not watching" };

    expect(await attempt(io, DAEMON_URL, ok(null, [diagnostic]), () => 3)).toBe(3);
    expect(err).toEqual([]);
  });

  it("reports a call nothing answered", async () => {
    const { io, out, err } = capture();
    const error = new TransportError("GET /health reached no daemon", undefined, new Error("connect ECONNREFUSED"));

    expect(await attempt(io, DAEMON_URL, throwing(error), () => 0)).toBe(3);
    expect(out).toEqual([]);
    expect(err.join("")).toBe(`tasma: no daemon answered at ${DAEMON_URL}\n`);
  });

  // The budget is read off the fault rather than off the module constant, so the
  // sentence cannot describe a budget other than the one the call ran under.
  it("reports a call whose budget ran out, naming the budget that call ran under", async () => {
    for (const [timeoutMs, seconds] of [[REQUEST_TIMEOUT_MS, "10"], [500, "0.5"]] as const) {
      const { io, err } = capture();
      const error = new TransportError("GET /health reached no daemon", undefined, new RequestTimeoutError(timeoutMs));

      expect(await attempt(io, DAEMON_URL, throwing(error), () => 0)).toBe(3);
      expect(err.join("")).toBe(`tasma: the daemon at ${DAEMON_URL} did not answer within ${seconds} seconds\n`);
    }
  });

  it("reports an answer that carried no envelope, with the status it arrived under", async () => {
    const { io, err } = capture();
    const error = new TransportError("GET /health answered with no envelope", 502);

    expect(await attempt(io, DAEMON_URL, throwing(error), () => 0)).toBe(3);
    expect(err.join("")).toBe(`tasma: ${DAEMON_URL} answered 502, but not as a Tasma daemon\n`);
  });

  // The kind is printed beside the code because one code belongs to two engine
  // unions at once, and the code alone discards which one refused.
  it("reports a refusal by its kind, its code and its message, at exit 1", async () => {
    const { io, out, err } = capture();
    const failure = { kind: "store", code: "task-not-found", message: "/tasks/A-99.md: no task with this id" } as const;

    expect(await attempt(io, DAEMON_URL, throwing(new ProtocolError(failure, 404)), () => 0)).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("tasma: store/task-not-found: /tasks/A-99.md: no task with this id\n");
  });

  it("escapes a control character a daemon message or a diagnostic carries", async () => {
    const { io, err } = capture();
    const failure = { kind: "daemon", code: "internal", message: "\u001b[2Jfaked" } as const;

    await attempt(io, DAEMON_URL, throwing(new ProtocolError(failure, 500)), () => 0);
    await attempt(io, DAEMON_URL, ok(null, [{ code: "config-unreadable", message: "m", path: "/c\u001bfg" }]), () => 0);

    expect(err.join("")).not.toContain("\u001b");
    expect(err[0]).toBe("tasma: daemon/internal: \\u001b[2Jfaked\n");
    expect(err[1]).toBe("tasma: note: config-unreadable: m (/c\\u001bfg)\n");
  });

  // An unexpected throw reaches Node, which prints a stack a hand-written
  // wrapper would replace with a worse message.
  it("lets anything that is neither a transport nor a protocol fault escape", async () => {
    const { io } = capture();

    await expect(attempt(io, DAEMON_URL, throwing(new RangeError("boom")), () => 0)).rejects.toThrow("boom");
  });
});

describe("reportForeign", () => {
  it("names the value that answered, at the same code as any unreachable daemon", () => {
    const { io, out, err } = capture();

    expect(reportForeign(io, DAEMON_URL, "other-daemon")).toBe(3);
    expect(out).toEqual([]);
    expect(err.join("")).toBe(`tasma: ${DAEMON_URL} answered as "other-daemon", not a Tasma daemon\n`);
  });

  // isEnvelope reads no further than the discriminant, so the field arrives as
  // whatever the answer carried — including a value that refuses to coerce,
  // which would throw inside the function reporting the bad answer.
  it("takes a name that is not a string, and escapes one that is", () => {
    const { io, err } = capture();

    expect(reportForeign(io, DAEMON_URL, undefined)).toBe(3);
    expect(reportForeign(io, DAEMON_URL, "\u001b[2Jtasma-daemon")).toBe(3);
    expect(reportForeign(io, DAEMON_URL, { toString: "x" })).toBe(3);
    expect(reportForeign(io, DAEMON_URL, nested(30_000))).toBe(3);
    expect(err[0]).toBe(`tasma: ${DAEMON_URL} answered as "undefined", not a Tasma daemon\n`);
    expect(err[1]).toContain("\"\\u001b[2Jtasma-daemon\"");
    expect(err[2]).toContain('"{"toString":"x"}"');
    expect(err[3]).toContain('"[unprintable]"');
  });
});
