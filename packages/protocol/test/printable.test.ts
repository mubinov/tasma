import { describe, expect, it } from "vitest";
import { printable } from "@tasma/protocol";

describe("printable", () => {
  it("leaves ordinary text alone", () => {
    expect(printable("unknown command: frobnicate")).toBe("unknown command: frobnicate");
  });

  it("escapes a control or format character, an astral one by both its code units", () => {
    expect(printable("a\u001b\u200eb")).toBe("a\\u001b\\u200eb");
    expect(printable("\u{110bd}")).toBe("\\ud804\\udcbd");
  });

  // No terminal acts on these, but a consumer splitting the output into lines
  // does, so an argument carrying one forges a line the binary never wrote.
  it("escapes the two Unicode line separators", () => {
    expect(printable("a\u2028b\u2029c")).toBe("a\\u2028b\\u2029c");
  });
});
