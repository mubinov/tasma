import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { cell, fieldsOf, table, withLineBreak } from "../src/output.js";

describe("cell", () => {
  // A column that went empty would let the columns after it slide left, so the
  // three ways a record states nothing print one mark.
  it("marks a value a record does not state", () => {
    expect(cell(undefined)).toBe("-");
    expect(cell(null)).toBe("-");
    expect(cell("")).toBe("-");
  });

  it("prints text as it stands, and a number as it reads", () => {
    expect(cell("In Progress")).toBe("In Progress");
    expect(cell(1204)).toBe("1204");
    expect(cell(false)).toBe("false");
  });

  // A tab or a break inside a value would break the line the table is made of.
  it("escapes a control character rather than writing it to the terminal", () => {
    expect(cell("a\tb")).toBe("a\\u0009b");
    expect(cell("a\nb")).toBe("a\\u000ab");
  });

  it("names a value that defeats rendering rather than throwing on it", () => {
    expect(cell({ toString: "x" })).toBe('{"toString":"x"}');
    expect(cell(0n)).toBe("[unprintable]");
  });
});

describe("table", () => {
  it("pads every column but the last, two spaces apart", () => {
    expect(table([["TASM-1", "To Do", "a title"], ["TASM-46", "Done", "b"]])).toBe(
      "TASM-1   To Do  a title\nTASM-46  Done   b\n",
    );
  });

  it("leaves the last column unpadded, so no line ends in spaces", () => {
    expect(table([["a", "long"], ["b", "x"]])).toBe("a  long\nb  x\n");
  });

  it("ends the last line with a break", () => {
    expect(table([["a"]])).toBe("a\n");
  });

  // An empty listing prints nothing at all rather than a blank line.
  it("prints nothing for no rows", () => {
    expect(table([])).toBe("");
  });
});

describe("withLineBreak", () => {
  it("adds a break where the text has none", () => {
    expect(withLineBreak("text")).toBe("text\n");
    expect(withLineBreak("")).toBe("\n");
  });

  it("adds none where the text already ends with one", () => {
    expect(withLineBreak("text\n")).toBe("text\n");
    expect(withLineBreak("text\n\n")).toBe("text\n\n");
  });
});

describe("fieldsOf", () => {
  it("reads the fields of a record", () => {
    expect(fieldsOf({ tag: "TASM" }).tag).toBe("TASM");
  });

  // An element of a listing is whatever answered the port, and a writer reads a
  // field off every one of them.
  it("answers with no field at all for a value that is no record", () => {
    for (const value of [undefined, null, "TASM", 1]) {
      expect(fieldsOf(value)).toEqual({});
    }
  });
});
