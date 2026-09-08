import { DEFAULT_DAEMON_URL, ProtocolError, TransportError } from "@tasma/protocol";
import type { DaemonRecord, Diagnostic, Success } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { recordPath } from "../src/daemon/record.js";
import type { Probed } from "../src/daemon/record.js";
import type { StartOutcome } from "../src/daemon/start.js";
import { REQUEST_TIMEOUT_MS, RequestTimeoutError } from "../src/daemon/transport.js";
import { attempt, reportForeign } from "../src/failure.js";
import type { Reach } from "../src/failure.js";
import type { Target } from "../src/types.js";
import { capture } from "./helpers.js";

const DAEMON_URL = "http://127.0.0.1:8278";

/** An address stated by hand, which is the target that is never started. */
const EXPLICIT: Target = { kind: "explicit", url: DAEMON_URL, stated: "--daemon" };

const HOME = "/tmp/tasma-tree";
const TREE: Target = { kind: "tree", home: HOME };
const RECORD_PATH = recordPath(HOME);

const UNREACHED = new TransportError("GET /health reached no daemon", undefined, new Error("connect ECONNREFUSED"));

function ok<T>(data: T, diagnostics: Diagnostic[] = []): () => Promise<Success<T>> {
  return () => Promise.resolve({ data, diagnostics });
}

function throwing(error: Error): () => Promise<never> {
  return () => Promise.reject(error);
}

/** A call that fails the first time and answers the second, as a retry against a new address does. */
function reachedOnRetry<T>(data: T, fault: TransportError = UNREACHED): () => Promise<Success<T>> {
  let first = true;

  return () => {
    if (!first) return Promise.resolve({ data, diagnostics: [] });

    first = false;
    return Promise.reject(fault);
  };
}

/** A call that counts how often it was sent, so a repeat of a write is visible. */
function counted<T>(answer: () => Promise<Success<T>>): { call: () => Promise<Success<T>>; sent: () => number } {
  let sent = 0;

  return {
    call: () => {
      sent += 1;
      return answer();
    },
    sent: () => sent,
  };
}

/**
 * The tree as the test states it: what the record holds, what a start of one
 * comes to, and what a probe of the address it gave finds.
 */
function reaching(
  record: DaemonRecord | undefined,
  options: { outcome?: StartOutcome; found?: Probed } = {},
): { reach: Reach; starts: string[]; probes: string[] } {
  const { outcome, found = "none" } = options;
  const starts: string[] = [];
  const probes: string[] = [];

  return {
    starts,
    probes,
    reach: {
      readRecord: () => Promise.resolve(record),
      probe: (url) => {
        probes.push(url);

        return Promise.resolve(found);
      },
      start: ({ home }) => {
        starts.push(home);

        if (outcome === undefined) throw new Error("this target must never be started");

        return Promise.resolve(outcome);
      },
    },
  };
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

    const code = await attempt(io, EXPLICIT, ok("payload", diagnostics), (data) => {
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

    await attempt(io, EXPLICIT, ok(null, [diagnostic]), () => 0);

    expect(err.join("")).toBe("tasma: note: step-stale: the step is stale\n");
  });

  // The contract `daemon status` depends on: attempt classifies the call, print
  // classifies the content.
  it("returns the code print chose rather than 0", async () => {
    const { io } = capture();

    expect(await attempt(io, EXPLICIT, ok("payload"), () => 3)).toBe(3);
  });

  // The envelope check reads the diagnostics as an array and no further, so an
  // element is whatever answered the port, and a line already on stdout must not
  // be followed by a stack trace.
  it("skips a note that is not an object, behind an answer it has already printed", async () => {
    const { io, out, err } = capture();
    const wire: unknown[] = [null, "note", 7, { code: "step-stale", message: "the step is stale" }];

    const code = await attempt(io, EXPLICIT, ok("payload", wire as Diagnostic[]), (data) => {
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

    const code = await attempt(io, EXPLICIT, ok("payload", wire as unknown as Diagnostic[]), (data) => {
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

    const code = await attempt(io, EXPLICIT, ok("payload", wire as unknown as Diagnostic[]), (data) => {
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

    expect(await attempt(io, EXPLICIT, ok(null, [diagnostic]), () => 3)).toBe(3);
    expect(err).toEqual([]);
  });

  it("reports a call nothing answered", async () => {
    const { io, out, err } = capture();

    expect(await attempt(io, EXPLICIT, throwing(UNREACHED), () => 0)).toBe(3);
    expect(out).toEqual([]);
    expect(err.join("")).toBe(`tasma: no daemon answered at ${DAEMON_URL}\n`);
  });

  // The budget is read off the fault rather than off the module constant, so the
  // sentence cannot describe a budget other than the one the call ran under.
  it("reports a call whose budget ran out, naming the budget that call ran under", async () => {
    for (const [timeoutMs, seconds] of [[REQUEST_TIMEOUT_MS, "10"], [500, "0.5"]] as const) {
      const { io, err } = capture();
      const error = new TransportError("GET /health reached no daemon", undefined, new RequestTimeoutError(timeoutMs));

      expect(await attempt(io, EXPLICIT, throwing(error), () => 0)).toBe(3);
      expect(err.join("")).toBe(`tasma: the daemon at ${DAEMON_URL} did not answer within ${seconds} seconds\n`);
    }
  });

  it("reports an answer that carried no envelope, with the status it arrived under", async () => {
    const { io, err } = capture();
    const error = new TransportError("GET /health answered with no envelope", 502);

    expect(await attempt(io, EXPLICIT, throwing(error), () => 0)).toBe(3);
    expect(err.join("")).toBe(`tasma: ${DAEMON_URL} answered 502, but not as a Tasma daemon\n`);
  });

  // The kind is printed beside the code because one code belongs to two engine
  // unions at once, and the code alone discards which one refused.
  it("reports a refusal by its kind, its code and its message, at exit 1", async () => {
    const { io, out, err } = capture();
    const failure = { kind: "store", code: "task-not-found", message: "/tasks/A-99.md: no task with this id" } as const;

    expect(await attempt(io, EXPLICIT, throwing(new ProtocolError(failure, 404)), () => 0)).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("tasma: store/task-not-found: /tasks/A-99.md: no task with this id\n");
  });

  it("escapes a control character a daemon message or a diagnostic carries", async () => {
    const { io, err } = capture();
    const failure = { kind: "daemon", code: "internal", message: "\u001b[2Jfaked" } as const;

    await attempt(io, EXPLICIT, throwing(new ProtocolError(failure, 500)), () => 0);
    await attempt(io, EXPLICIT, ok(null, [{ code: "config-unreadable", message: "m", path: "/c\u001bfg" }]), () => 0);

    expect(err.join("")).not.toContain("\u001b");
    expect(err[0]).toBe("tasma: daemon/internal: \\u001b[2Jfaked\n");
    expect(err[1]).toBe("tasma: note: config-unreadable: m (/c\\u001bfg)\n");
  });

  // An unexpected throw reaches Node, which prints a stack a hand-written
  // wrapper would replace with a worse message.
  it("lets anything that is neither a transport nor a protocol fault escape", async () => {
    const { io } = capture();

    await expect(attempt(io, EXPLICIT, throwing(new RangeError("boom")), () => 0)).rejects.toThrow("boom");
  });

  it("calls the address the tree's record names, and the built-in one where it holds no record", async () => {
    for (const [record, expected] of [
      [{ port: 9000, pid: 4242 }, "http://127.0.0.1:9000"],
      [undefined, DEFAULT_DAEMON_URL],
    ] as const) {
      const { io } = capture();
      const { reach } = reaching(record);
      let seen = "";

      expect(await attempt(io, TREE, ok("payload"), (_data, url) => {
        seen = url;
        return 0;
      }, { reach })).toBe(0);
      expect(seen).toBe(expected);
    }
  });

  // Somebody who named an address is pointing at a daemon that is meant to be
  // there already, so the address is the off switch for start-on-demand.
  it("starts nothing for an address stated by hand", async () => {
    const { io, err } = capture();
    const { reach, starts } = reaching(undefined);

    expect(await attempt(io, EXPLICIT, throwing(UNREACHED), () => 0, { reach })).toBe(3);
    expect(starts).toEqual([]);
    expect(err.join("")).toBe(`tasma: no daemon answered at ${DAEMON_URL}\n`);
  });

  // The port answering nothing is what makes the record stale, so the reader is
  // told which file describes a daemon that is gone.
  it("names the record as stale where the address it gave answered nothing and no start was allowed", async () => {
    const { io, err } = capture();
    const { reach, starts } = reaching({ port: 9000, pid: 4242 });

    expect(await attempt(io, TREE, throwing(UNREACHED), () => 0, { reach, start: false })).toBe(3);
    expect(starts).toEqual([]);
    expect(err.join("")).toBe(`tasma: no daemon answered at http://127.0.0.1:9000; the record at ${RECORD_PATH} is stale\n`);
  });

  it("starts a daemon for the tree and retries once against the address it answered", async () => {
    const { io, err } = capture();
    const { reach, starts } = reaching(undefined, { outcome: { url: "http://127.0.0.1:9100" } });
    let seen = "";

    expect(await attempt(io, TREE, reachedOnRetry("payload"), (_data, url) => {
      seen = url;
      return 0;
    }, { reach })).toBe(0);
    expect(starts).toEqual([HOME]);
    expect(seen).toBe("http://127.0.0.1:9100");
    expect(err).toEqual([]);
  });

  it("reports a start that failed, at the code of a daemon that cannot be reached", async () => {
    const { io, out, err } = capture();
    const { reach } = reaching(undefined, { outcome: { failure: "tasma-daemon exited with code 1: port 8278 cannot be bound" } });

    expect(await attempt(io, TREE, throwing(UNREACHED), () => 0, { reach })).toBe(3);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("tasma: tasma-daemon exited with code 1: port 8278 cannot be bound\n");
  });

  // The retry's outcome is final: a second start would spawn a daemon for a
  // tree that has just produced one.
  it("reports a retry that reached nothing, without naming a record and without starting again", async () => {
    const { io, err } = capture();
    const { reach, starts } = reaching({ port: 9000, pid: 4242 }, { outcome: { url: "http://127.0.0.1:9100" } });

    expect(await attempt(io, TREE, throwing(UNREACHED), () => 0, { reach })).toBe(3);
    expect(starts).toEqual([HOME]);
    expect(err.join("")).toBe("tasma: no daemon answered at http://127.0.0.1:9100\n");
  });

  // Something accepted the call and did not answer in time, and that something
  // may be this tree's own daemon with its event loop held. A second daemon over
  // one tree is what the daemon's per-process write queue cannot order, and the
  // record is not stale either: the port it names is held.
  it("starts nothing behind a call that ran out of time, and calls its record nothing", async () => {
    const { io, err } = capture();
    const { reach, starts } = reaching({ port: 9000, pid: 4242 });
    const error = new TransportError("GET /health reached no daemon", undefined, new RequestTimeoutError(500));

    expect(await attempt(io, TREE, throwing(error), () => 0, { reach })).toBe(3);
    expect(starts).toEqual([]);
    expect(err.join("")).toBe("tasma: the daemon at http://127.0.0.1:9000 did not answer within 0.5 seconds\n");
  });

  // A record whose port another program has taken is exactly what a start
  // repairs: the daemon it spawns finds no daemon of this tree and claims it.
  it("starts a daemon where the recorded port answered as something other than a daemon", async () => {
    const { io, err } = capture();
    const { reach, starts } = reaching({ port: 9000, pid: 4242 }, { outcome: { url: "http://127.0.0.1:9100" } });
    const answered = new TransportError("GET /health answered with no envelope", 502);

    expect(await attempt(io, TREE, reachedOnRetry("payload", answered), () => 0, { reach })).toBe(0);
    expect(starts).toEqual([HOME]);
    expect(err).toEqual([]);
  });

  // Nothing a transport fault carries says whether the daemon applied the call
  // before the connection failed, so a second send is what turns one create into
  // two tasks.
  it("sends a call that may not be repeated once, and never behind a start", async () => {
    const { io, err } = capture();
    const { reach, starts, probes } = reaching({ port: 9000, pid: 4242 }, { found: "daemon" });
    const { call, sent } = counted(throwing(UNREACHED));

    expect(await attempt(io, TREE, call, () => 0, { reach, prove: true })).toBe(3);
    expect(sent()).toBe(1);
    expect(starts).toEqual([]);
    expect(probes).toEqual(["http://127.0.0.1:9000"]);
    expect(err.join("")).toBe("tasma: no daemon answered at http://127.0.0.1:9000\n");
  });

  // The start happens before such a call rather than behind a failed one, so a
  // tree with no daemon still gets one and the call is sent exactly once.
  it("starts a daemon before a call that may not be repeated where nothing answered", async () => {
    const { io, err } = capture();
    const { reach, starts, probes } = reaching({ port: 9000, pid: 4242 }, { outcome: { url: "http://127.0.0.1:9100" } });
    const { call, sent } = counted(ok("payload"));
    let seen = "";

    expect(await attempt(io, TREE, call, (_data, url) => {
      seen = url;
      return 0;
    }, { reach, prove: true })).toBe(0);
    expect(sent()).toBe(1);
    expect(starts).toEqual([HOME]);
    expect(probes).toEqual(["http://127.0.0.1:9000"]);
    expect(seen).toBe("http://127.0.0.1:9100");
    expect(err).toEqual([]);
  });

  // A tree with no record is reached at the machine-wide default, where a health
  // answer proves the product and not the tree, so such a call is started for
  // instead: a daemon already holding that port stands the start down and says
  // which tree it serves.
  it("probes nothing for a tree that holds no record, and starts one instead", async () => {
    const { io, out, err } = capture();
    const failure = "tasma-daemon exited without serving this tree: a daemon is already serving at http://127.0.0.1:8278";
    const { reach, starts, probes } = reaching(undefined, { outcome: { failure }, found: "daemon" });
    const { call, sent } = counted(ok("payload"));

    expect(await attempt(io, TREE, call, () => 0, { reach, prove: true })).toBe(3);
    expect(sent()).toBe(0);
    expect(probes).toEqual([]);
    expect(starts).toEqual([HOME]);
    expect(out).toEqual([]);
    expect(err.join("")).toBe(`tasma: ${failure}\n`);
  });

  it("sends no call that may not be repeated where the start before it failed", async () => {
    const { io, out, err } = capture();
    const failure = "tasma-daemon exited with code 1: port 8278 cannot be bound";
    const { reach } = reaching({ port: 9000, pid: 4242 }, { outcome: { failure } });
    const { call, sent } = counted(ok("payload"));

    expect(await attempt(io, TREE, call, () => 0, { reach, prove: true })).toBe(3);
    expect(sent()).toBe(0);
    expect(out).toEqual([]);
    expect(err.join("")).toBe(`tasma: ${failure}\n`);
  });

  // Something accepted the probe and was still answering it when the budget ran
  // out. That something is there, and starting a daemon behind it is the second
  // daemon over one tree that nothing may spawn.
  it("sends a call that may not be repeated to an address that answered late, and starts nothing", async () => {
    const { io, err } = capture();
    const { reach, starts, probes } = reaching({ port: 9000, pid: 4242 }, { found: "late" });
    const { call, sent } = counted(ok("payload"));

    expect(await attempt(io, TREE, call, () => 0, { reach, prove: true })).toBe(0);
    expect(sent()).toBe(1);
    expect(starts).toEqual([]);
    expect(probes).toEqual(["http://127.0.0.1:9000"]);
    expect(err).toEqual([]);
  });

  // The body of a write reaches whatever holds the address before a reply has
  // identified it, so an address stated by hand is proven too. Starting one is
  // still refused: a caller who named an address is pointing at a daemon that is
  // meant to be there already.
  it("proves an address stated by hand before a call that may not be repeated, and starts none", async () => {
    const { io, err } = capture();
    const { reach, probes, starts } = reaching(undefined);
    const { call, sent } = counted(ok("payload"));

    expect(await attempt(io, EXPLICIT, call, () => 0, { reach, prove: true })).toBe(3);
    expect(sent()).toBe(0);
    expect(probes).toEqual([DAEMON_URL]);
    expect(starts).toEqual([]);
    expect(err.join("")).toBe(`tasma: no daemon answered at ${DAEMON_URL}\n`);
  });

  it("sends such a call to an address stated by hand that answered as a daemon", async () => {
    const { io, err } = capture();
    const { reach, starts } = reaching(undefined, { found: "daemon" });
    const { call, sent } = counted(ok("payload"));

    expect(await attempt(io, EXPLICIT, call, () => 0, { reach, prove: true })).toBe(0);
    expect(sent()).toBe(1);
    expect(starts).toEqual([]);
    expect(err).toEqual([]);
  });

  // A caller that forbids a start has nothing to fall back on, whatever the
  // probe found.
  it("sends no call that may not be repeated where nothing answered and no start is allowed", async () => {
    const { io, err } = capture();
    const { reach, starts, probes } = reaching({ port: 9000, pid: 4242 });
    const { call, sent } = counted(ok("payload"));

    expect(await attempt(io, TREE, call, () => 0, { reach, prove: true, start: false })).toBe(3);
    expect(sent()).toBe(0);
    expect(starts).toEqual([]);
    expect(probes).toEqual(["http://127.0.0.1:9000"]);
    expect(err.join("")).toBe("tasma: no daemon answered at http://127.0.0.1:9000\n");
  });

  // A daemon answered and refused, which no start would change.
  it("starts nothing behind a refusal", async () => {
    const { io, err } = capture();
    const { reach, starts } = reaching(undefined);
    const failure = { kind: "store", code: "task-not-found", message: "no such task" } as const;

    expect(await attempt(io, TREE, throwing(new ProtocolError(failure, 404)), () => 0, { reach })).toBe(1);
    expect(starts).toEqual([]);
    expect(err.join("")).toBe("tasma: store/task-not-found: no such task\n");
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
