import { type Diagnostic } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { freshDiagnostics } from "../../../src/api/mutations/notices";

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
