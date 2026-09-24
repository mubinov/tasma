import { ProtocolError, TransportError, type SerializeErrorCode } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { failureKind, TaskWriteError, WriteError, type FailureKind } from "../../src/api/mutations";
import { boardFailureLine, pageFailureLine } from "../../src/lib/write-failure";

const CAUSES: Record<FailureKind, { label: string; cause: unknown }> = {
  refused: {
    label: "a refusal",
    cause: new ProtocolError({ kind: "store", code: "status-unknown", message: "status \"Gone\" is not configured" }, 422),
  },
  unanswered: { label: "no answer", cause: new TransportError("PATCH /projects/NOTE/tasks/NOTE-1 reached no daemon") },
  address: { label: "an answer that is not the daemon's", cause: new TransportError("answered with no envelope", 502) },
  unsent: { label: "a write that could not start", cause: new Error("\"..\" is not one path component") },
};

const KINDS = Object.keys(CAUSES) as FailureKind[];

function serialize(code: SerializeErrorCode, field?: string): ProtocolError {
  return new ProtocolError({ kind: "serialize", code, message: `refused: ${code}`, line: 4, field }, 422);
}

it.each(KINDS)("builds a %s cause", (kind) => {
  expect(failureKind(CAUSES[kind].cause)).toBe(kind);
});

describe("boardFailureLine", () => {
  const LINES: Record<FailureKind, { line: string; partial: string }> = {
    refused: {
      line: "The daemon refused the write, and the task is back where it was. Its own words are below.",
      partial: "The daemon refused a write, and the move did not complete. The board shows what the daemon holds. "
        + "Its own words are below.",
    },
    unanswered: {
      line: "No daemon answered, so nothing was written.",
      partial: "The daemon stopped answering, and the move did not complete. "
        + "The board shows what the daemon holds after the next read.",
    },
    address: {
      line: "The daemon did not answer through the address below. Start the daemon there if it is not running. "
        + "The board shows the task where the daemon holds it after the next read.",
      partial: "The daemon did not answer through the address below, and the move did not complete. "
        + "Start the daemon there if it is not running. The board shows what the daemon holds after the next read.",
    },
    unsent: {
      line: "The write did not start, and the task is back where it was.",
      partial: "A write did not start, and the move did not complete. The board shows what the daemon holds.",
    },
  };
  const CASES = KINDS.map((kind) => ({ ...CAUSES[kind], ...LINES[kind] }));

  it.each(CASES)("says the task is back for $label when no write succeeded", ({ cause, line }) => {
    expect(boardFailureLine(new TaskWriteError(cause, 0))).toBe(line);
  });

  it.each(CASES)("says the move did not complete for $label after a write that succeeded", ({ cause, partial }) => {
    expect(boardFailureLine(new TaskWriteError(cause, 2))).toBe(partial);
  });
});

describe("pageFailureLine", () => {
  const LINES: Record<FailureKind, string> = {
    refused: "The daemon refused the write, so nothing changed on disk. Its own words are below.",
    unanswered: "No daemon answered, so nothing was written.",
    address: "The daemon did not answer through the address below. Start the daemon there if it is not running. "
      + "The page shows the task as the daemon holds it after the next read.",
    unsent: "The write did not start, so nothing changed on disk.",
  };
  const CASES = KINDS.map((kind) => ({ ...CAUSES[kind], line: LINES[kind] }));
  const REFUSED = LINES.refused;

  it.each(CASES)("says nothing changed on disk for $label", ({ cause, line }) => {
    expect(pageFailureLine(new WriteError(cause))).toBe(line);
  });

  const BODY_REFUSALS: { code: SerializeErrorCode; correction: string }[] = [
    {
      code: "marker-collision",
      correction: "The body starts a line with a comment marker. Indent that line, or change its first characters.",
    },
    { code: "fence-unterminated", correction: "The body opens a code fence that never closes. Close the fence." },
  ];

  it.each(BODY_REFUSALS)("names the correction for $code at the end of its line", ({ code, correction }) => {
    expect(pageFailureLine(new WriteError(serialize(code)))).toBe(`${REFUSED} ${correction}`);
  });

  it("names the correction where the daemon refused the title for an arrow", () => {
    expect(pageFailureLine(new WriteError(serialize("value-contains-arrow", "title"))))
      .toBe(`${REFUSED} The title contains "-->", which closes the comment marker. Remove it.`);
  });

  it("names no title correction for the same code raised about another field", () => {
    expect(pageFailureLine(new WriteError(serialize("value-contains-arrow", "author")))).toBe(REFUSED);
  });

  it("names the property in front of the line, so the reader is told which control refused", () => {
    expect(pageFailureLine(new TaskWriteError(CAUSES.refused.cause, 0), "Status")).toBe(`Status. ${REFUSED}`);
  });
});
