import { describe, expect, it } from "vitest";
import {
  changedOnDisk,
  hasUnsavedText,
  isBlankTitle,
  savesNothing,
  type Draft,
} from "../../src/lib/text-draft";

const START: Draft = { title: "Build the parser", body: "First line.\n" };

describe("hasUnsavedText", () => {
  it("is false for the text the editor opened with", () => {
    expect(hasUnsavedText(START, { ...START })).toBe(false);
  });

  it("is true for a changed title", () => {
    expect(hasUnsavedText(START, { ...START, title: "Build the lexer" })).toBe(true);
  });

  it("is true for a changed body", () => {
    expect(hasUnsavedText(START, { ...START, body: "Second line.\n" })).toBe(true);
  });

  it("counts a dropped last line end as text the reader changed", () => {
    expect(hasUnsavedText(START, { ...START, body: "First line." })).toBe(true);
  });
});

describe("savesNothing", () => {
  it("holds for the text the editor opened with", () => {
    expect(savesNothing(START, { ...START }, false)).toBe(true);
  });

  it("does not hold for a changed title", () => {
    expect(savesNothing(START, { ...START, title: "Build the lexer" }, false)).toBe(false);
  });

  it("does not hold for a changed body", () => {
    expect(savesNothing(START, { ...START, body: "Second line.\n" }, false)).toBe(false);
  });

  it("holds for the start body without its last line end on a task with comments", () => {
    expect(savesNothing(START, { ...START, body: "First line." }, true)).toBe(true);
  });

  it("does not hold for that same body on a task with no comment", () => {
    expect(savesNothing(START, { ...START, body: "First line." }, false)).toBe(false);
  });

  it("does not hold for a line end the start body has not", () => {
    const start: Draft = { title: START.title, body: "First line." };

    expect(savesNothing(start, { ...start, body: "First line.\n" }, true)).toBe(false);
  });

  it("does not hold where the title changed as well", () => {
    expect(savesNothing(START, { title: "Build the lexer", body: "First line." }, true)).toBe(false);
  });

  describe("read as \"another comment follows this one\"", () => {
    it("holds for a following comment's body without its last line end", () => {
      expect(savesNothing(START, { ...START, body: "First line." }, true)).toBe(true);
    });

    it("does not hold for the last comment's body with a line end the start body has not", () => {
      const start: Draft = { title: START.title, body: "First line." };

      expect(savesNothing(start, { ...start, body: "First line.\n" }, false)).toBe(false);
    });
  });
});

describe("isBlankTitle", () => {
  it("holds for an empty title", () => {
    expect(isBlankTitle("")).toBe(true);
  });

  it("holds for a title of spaces alone", () => {
    expect(isBlankTitle("  \t ")).toBe(true);
  });

  it("does not hold for a title with a word", () => {
    expect(isBlankTitle(" Build ")).toBe(false);
  });
});

describe("changedOnDisk", () => {
  const draft = { ...START };

  it("does not hold while the disk holds the start text", () => {
    expect(changedOnDisk({ start: START, draft, disk: { ...START } })).toBe(false);
  });

  it("holds for a title written on disk since the editor opened", () => {
    expect(changedOnDisk({ start: START, draft, disk: { ...START, title: "Renamed" } })).toBe(true);
  });

  it("holds for a body written on disk since the editor opened", () => {
    expect(changedOnDisk({ start: START, draft, disk: { ...START, body: "Other.\n" } })).toBe(true);
  });

  it("does not hold where the disk already holds the text in the editor", () => {
    const typed = { ...START, title: "Renamed" };

    expect(changedOnDisk({ start: START, draft: typed, disk: { ...typed } })).toBe(false);
  });
});
