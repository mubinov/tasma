import { ProtocolError, TransportError, type Diagnostic } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { freshDiagnostics, refusalPath, WriteError } from "../../../src/api/mutations/notices";

const STALE: Diagnostic = { code: "stale-next-comment-id", message: "next_comment_id is behind the last comment" };

const FENCE: Diagnostic = { code: "unterminated-fence", message: "a code fence never closes" };

describe("freshDiagnostics", () => {
  it("returns a diagnostic the reader's screen does not already show", () => {
    expect(freshDiagnostics([STALE], [FENCE])).toEqual([STALE]);
  });

  it("drops a diagnostic matching a known one on code and message", () => {
    expect(freshDiagnostics([STALE], [FENCE, { ...STALE }])).toEqual([]);
  });

  it("returns a diagnostic matching a known one on code alone", () => {
    expect(freshDiagnostics([STALE], [{ ...STALE, message: "a different finding" }])).toEqual([STALE]);
  });
});

describe("refusalPath", () => {
  const TAKEN = new ProtocolError({ kind: "store", code: "path-taken", message: "not free", path: "/Users/sample/code" }, 409);

  it("gives the path of a refusal, also inside a WriteError", () => {
    expect(refusalPath(TAKEN)).toBe("/Users/sample/code");
    expect(refusalPath(new WriteError(TAKEN))).toBe("/Users/sample/code");
  });

  it("gives nothing for a refusal with no path", () => {
    expect(refusalPath(new ProtocolError({ kind: "store", code: "project-exists", message: "taken" }, 409))).toBeUndefined();
    expect(refusalPath(new ProtocolError({ kind: "daemon", code: "internal", message: "broke" }, 500))).toBeUndefined();
  });

  it("gives nothing for a failure that is not a refusal", () => {
    expect(refusalPath(new WriteError(new TransportError("reached no daemon")))).toBeUndefined();
    expect(refusalPath(new Error("not sent"))).toBeUndefined();
  });
});
