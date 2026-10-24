import { describe, expect, it } from "vitest";
import { matchRanges, searchWords } from "../../src/lib/match-ranges";

describe("searchWords", () => {
  it("splits the text on whitespace and lowers its case", () => {
    expect(searchWords("Parse  the\tFILE")).toEqual(["parse", "the", "file"]);
  });

  it("drops the empty words at the ends", () => {
    expect(searchWords("  parse ")).toEqual(["parse"]);
  });

  it("gives no words for an empty text or a text of spaces", () => {
    expect(searchWords("")).toEqual([]);
    expect(searchWords("   ")).toEqual([]);
  });
});

describe("matchRanges", () => {
  it("finds one word", () => {
    expect(matchRanges("Build the parser", ["parse"])).toEqual([{ start: 10, end: 15 }]);
  });

  it("finds two words, sorted by place", () => {
    expect(matchRanges("Build the parser", ["parser", "build"])).toEqual([{ start: 0, end: 5 }, { start: 10, end: 16 }]);
  });

  it("finds each place of a word that occurs twice", () => {
    expect(matchRanges("parse and parse", ["parse"])).toEqual([{ start: 0, end: 5 }, { start: 10, end: 15 }]);
  });

  it("merges the places that overlap", () => {
    expect(matchRanges("database", ["data", "tab"])).toEqual([{ start: 0, end: 5 }]);
    expect(matchRanges("aaa", ["aa"])).toEqual([{ start: 0, end: 3 }]);
  });

  it("merges the places that touch", () => {
    expect(matchRanges("database", ["data", "base"])).toEqual([{ start: 0, end: 8 }]);
  });

  it("keeps a place inside another one within it", () => {
    expect(matchRanges("database", ["database", "tab"])).toEqual([{ start: 0, end: 8 }]);
  });

  it("ignores the case of the text", () => {
    expect(matchRanges("ACME-7 Ship", ["acme-7", "ship"])).toEqual([{ start: 0, end: 6 }, { start: 7, end: 11 }]);
  });

  it("keeps the offsets of the text where the lower case of a character is longer", () => {
    expect(matchRanges("İstanbul map", ["map"])).toEqual([{ start: 9, end: 12 }]);
  });

  it("marks a character whose lower case is longer with the whole character", () => {
    expect(matchRanges("İstanbul map", searchWords("İstanbul"))).toEqual([{ start: 0, end: 8 }]);
    expect(matchRanges("İstanbul map", ["i"])).toEqual([{ start: 0, end: 1 }]);
  });

  it("lowers a capital sigma at the end of a word to the final sigma, as the daemon does", () => {
    expect(matchRanges("ΟΔΟΣ ΚΑΙ", searchWords("ΟΔΟΣ"))).toEqual([{ start: 0, end: 4 }]);
    expect(matchRanges("ΟΔΟΣΑ", searchWords("ΟΔΟΣ"))).toEqual([]);
  });

  it("ignores the case of a letter outside the basic plane", () => {
    expect(matchRanges("𐐀𐐁 map", searchWords("𐐁"))).toEqual([{ start: 2, end: 4 }]);
  });

  it("gives no places when no word matches, and for no words", () => {
    expect(matchRanges("Build the parser", ["lexer"])).toEqual([]);
    expect(matchRanges("Build the parser", [])).toEqual([]);
  });

  it("ignores an empty word", () => {
    expect(matchRanges("Build", [""])).toEqual([]);
  });
});
