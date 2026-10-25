import { describe, expect, it, vi } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { chat } from "../../src/commands/chat.js";
import { createDaemonClient } from "../../src/daemon/transport.js";
import type * as Transport from "../../src/daemon/transport.js";
import { at, capture, CWD, HEALTH, HINT, ok, runCommand } from "../helpers.js";
import type { Ran } from "../helpers.js";

vi.mock("../../src/daemon/transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Transport>();

  return { ...actual, createDaemonClient: vi.fn(actual.createDaemonClient) };
});

const START = "POST /projects/SAGA/tasks/SAGA-1/chats";

const EVENTS = "GET /projects/SAGA/tasks/SAGA-1/chats/3/events?after=0";

const START_ARGS = ["start", "SAGA-1"];

/** Runs a verb of this noun against a server answering the table, and reports what it wrote. */
function runChat(args: string[], table: Record<string, unknown> = {}): Promise<Ran> {
  return runCommand(chat, args, table);
}

/** Chat 3 of SAGA-1 in the given state, as the route answers it. */
function chatIn(state: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: "SAGA-1",
    chat: 3,
    step: "plan:review",
    agent: "claude",
    folder: "/srv/repo",
    created: "2026-01-02T03:04:05.000Z",
    seq: 1,
    state,
    ...fields,
  };
}

/** A start answer: the chat, and whether the call started it. */
function startAnswer(state: string, started: boolean, fields: Record<string, unknown> = {}): unknown {
  return ok({ chat: chatIn(state, fields), started });
}

/** One entry of a chat log. */
function entry(seq: number, event: unknown): unknown {
  return { seq, at: "2026-01-02T03:04:05.000Z", event };
}

/** A log read that answers the given entries. */
function logOf(...entries: unknown[]): unknown {
  return ok({ cursor: entries.length, entries });
}

/** Asserts that an invocation was refused from argv alone, with the line it names and no call made. */
async function refuses(args: string[], line: string): Promise<void> {
  const { code, out, err, seen } = await runChat(args);

  expect(code, args.join(" ")).toBe(2);
  expect(out, args.join(" ")).toBe("");
  expect(err, args.join(" ")).toBe(`tasma: ${line}\n${HINT}`);
  expect(seen, args.join(" ")).toEqual([]);
}

describe("chat start", () => {
  it("prints the number of a chat it started, and sends the start once", async () => {
    const { code, out, err, seen, bodies } = await runChat(START_ARGS, { [START]: startAnswer("working", true) });

    expect(code).toBe(0);
    expect(out).toBe("3\n");
    expect(err).toBe("tasma: started chat 3 of SAGA-1 for step plan:review\n");
    expect(seen).toEqual([HEALTH, START]);
    expect(bodies[1]).toEqual({ client: "cli" });
  });

  it("gives its requests a budget of 30 seconds", async () => {
    vi.mocked(createDaemonClient).mockClear();

    await runChat(START_ARGS, {
      [START]: startAnswer("failed", true),
      [EVENTS]: logOf(entry(1, { kind: "failed", reason: "claude was not found" })),
    });

    expect(vi.mocked(createDaemonClient).mock.calls.map((call) => call[2])).toEqual([30_000]);
  });

  it("prints the number of a chat that was already open, and says so", async () => {
    const { code, out, err, seen } = await runChat(START_ARGS, { [START]: startAnswer("needs-you", false) });

    expect(code).toBe(0);
    expect(out).toBe("3\n");
    expect(err).toBe("tasma: chat 3 of SAGA-1 is already open for step plan:review\n");
    expect(seen).toEqual([HEALTH, START]);
  });

  it("escapes the step name it prints", async () => {
    const { err } = await runChat(START_ARGS, {
      [START]: startAnswer("working", true, { step: "plan\u001b[2J" }),
    });

    expect(err).toBe("tasma: started chat 3 of SAGA-1 for step plan\\u001b[2J\n");
  });

  it("writes the notes of the answer after the line about the chat", async () => {
    const { out, err } = await runChat(START_ARGS, {
      [START]: ok({ chat: chatIn("working"), started: true }, [{ code: "index-rebuilt", message: "the index was rebuilt" }]),
    });

    expect(out).toBe("3\n");
    expect(err).toBe(
      "tasma: started chat 3 of SAGA-1 for step plan:review\ntasma: note: index-rebuilt: the index was rebuilt\n",
    );
  });

  it("refuses an answer that is not a chat start, at exit 3, and reads no log", async () => {
    const answers = [
      null,
      "3",
      { chat: 3, started: true },
      { chat: chatIn("working"), started: "yes" },
      { chat: chatIn("working", { chat: "3" }), started: true },
      { chat: chatIn("working", { step: 7 }), started: true },
      { chat: chatIn("working", { state: undefined }), started: true },
    ];

    for (const answer of answers) {
      const { code, out, err, seen } = await runChat(START_ARGS, { [START]: ok(answer) });

      expect(code, JSON.stringify(answer)).toBe(3);
      expect(out).toBe("");
      expect(err).toMatch(/^tasma: http:\/\/127\.0\.0\.1:\d+ answered, but not with a chat start\n$/);
      expect(seen).toEqual([HEALTH, START]);
    }
  });

  it("reports a chat that failed at its start with the reason of its last failure, at exit 1", async () => {
    const { code, out, err, seen } = await runChat(START_ARGS, {
      [START]: startAnswer("failed", true),
      [EVENTS]: logOf(
        entry(1, { kind: "failed", reason: "an earlier failure" }),
        entry(2, { kind: "resumed" }),
        entry(3, { kind: "failed", reason: "claude was not found" }),
        entry(4, { kind: "interrupted" }),
      ),
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("tasma: chat 3 of SAGA-1 failed at its start: claude was not found\n");
    expect(seen).toEqual([HEALTH, START, EVENTS]);
  });

  it("escapes a line break in the reason", async () => {
    const { err } = await runChat(START_ARGS, {
      [START]: startAnswer("failed", true),
      [EVENTS]: logOf(entry(1, { kind: "failed", reason: "line one\nline two" })),
    });

    expect(err).toBe("tasma: chat 3 of SAGA-1 failed at its start: line one\\u000aline two\n");
  });

  it("reports a failed chat with no reason where the log gives none, at exit 1", async () => {
    const logs: [string, unknown][] = [
      ["a refusal of the read", { ok: false, error: { kind: "store", code: "chat-not-found", message: "no chat 3" } }],
      ["a reply that is not an envelope", "not an envelope"],
      ["a reply with no entries", ok({ reset: true, cursor: 0 })],
      ["entries that are not an array", ok({ cursor: 1, entries: "failed" })],
      ["no failed event", logOf(entry(1, { kind: "user", text: "Go", client: "daemon" }))],
      ["a reason that is not a string", logOf(entry(1, { kind: "failed", reason: 7 }))],
      ["entries that are not objects", logOf(null, "failed", entry(2, null))],
    ];

    for (const [description, log] of logs) {
      const { code, out, err, seen } = await runChat(START_ARGS, { [START]: startAnswer("failed", true), [EVENTS]: log });

      expect(code, description).toBe(1);
      expect(out, description).toBe("");
      expect(err, description).toBe("tasma: chat 3 of SAGA-1 failed at its start\n");
      expect(seen, description).toEqual([HEALTH, START, EVENTS]);
    }
  });

  it("reports a refusal of the start at exit 1, and reads no log", async () => {
    const { code, out, err, seen } = await runChat(START_ARGS, {
      [START]: {
        ok: false,
        error: { kind: "daemon", code: "task-has-no-workflow", message: "SAGA-1 has no workflow" },
      },
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("tasma: daemon/task-has-no-workflow: SAGA-1 has no workflow\n");
    expect(seen).toEqual([HEALTH, START]);
  });

  it("refuses every fault visible from argv alone, before it reaches a daemon", async () => {
    await refuses(["start"], "chat start needs a task id");
    await refuses(["start", "a/b"], "not a task id: a/b");
    await refuses(["start", "SAGA-1", "SAGA-2"], "chat start takes one argument: SAGA-2");
  });
});

describe("the chat noun", () => {
  it("lists its verb for a bare noun", async () => {
    const { io, out } = capture();

    expect(await chat.run([], io, at("http://127.0.0.1:8278"), CWD)).toBe(0);
    expect(out.join("")).toContain("  start");
  });

  it("prints the usage block of start, reaching no daemon", async () => {
    for (const flag of ["--help", "-h"]) {
      const { code, out, err, seen } = await runChat(["start", flag]);

      expect(code, flag).toBe(0);
      expect(out).toBe("Usage: tasma chat start <task-id>\n\n  -h, --help  Print this help\n");
      expect(err).toBe("");
      expect(seen).toEqual([]);
    }
  });
});
