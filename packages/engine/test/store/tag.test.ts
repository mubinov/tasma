import { describe, expect, it } from "vitest";
import { generateTag, isTag, TAG_RULE } from "@tasma/engine";
import { uniqueTag } from "../../src/store/tag.js";
import { storeFault } from "./helpers.js";

describe("the rule a project is created under", () => {
  it.each(["TASM", "A1", "WEB3", "ABCDEFGH"])("accepts %s", (tag) => {
    expect(isTag(tag)).toBe(true);
    expect(TAG_RULE.test(tag)).toBe(true);
  });

  it.each([
    ["one character", "T"],
    ["a leading digit", "1A"],
    ["lowercase letters", "tasm"],
    ["a dash", "TA-SM"],
    ["nine characters", "ABCDEFGHI"],
  ])("rejects %s", (_reason, tag) => {
    expect(isTag(tag)).toBe(false);
  });

  it.each<[string, unknown]>([
    ["an array whose text matches", ["TASM"]],
    ["a number", 4],
  ])("rejects %s, which is no string", (_reason, value) => {
    expect(isTag(value)).toBe(false);
  });
});

describe("the tag a path gives", () => {
  it.each([
    ["/Users/almaz/Projects/tasma", "TASM"],
    ["../ui-loader", "UILO"],
    ["~/web3/", "WEB3"],
    ["/srv/3d-viewer", "DVIE"],
    ["/tmp/x", "XX"],
    ["/tmp/.tasma", "TASM"],
  ])("makes %s into %s", (path, tag) => {
    expect(generateTag(path)).toBe(tag);
  });

  it.each([
    ["digits alone", "/tmp/42"],
    ["punctuation alone", "/tmp/_"],
    ["no last folder at all", "/"],
    ["letters of another script", "/tmp/проект"],
  ])("refuses a name holding %s", (_reason, path) => {
    expect(storeFault(() => generateTag(path)).code).toBe("tag-not-generated");
  });
});

describe("the tag a create settles on", () => {
  it("answers with the tag itself when nothing holds it", () => {
    expect(uniqueTag("TASM", new Set())).toBe("TASM");
  });

  it("counts from two for a tag that is taken", () => {
    expect(uniqueTag("TASM", new Set(["TASM"]))).toBe("TASM2");
  });

  it("passes nine to ten rather than stopping at one digit", () => {
    const taken = new Set(["TASM", "TASM2", "TASM3", "TASM4", "TASM5", "TASM6", "TASM7", "TASM8", "TASM9"]);

    expect(uniqueTag("TASM", taken)).toBe("TASM10");
  });

  it("refuses once no number fits within the rule", () => {
    const taken = new Set(["TASM"]);
    for (let number = 2; number < 10_000; number += 1) taken.add(`TASM${number}`);

    expect(storeFault(() => uniqueTag("TASM", taken)).code).toBe("project-exists");
  });

  it("refuses a taken tag no number fits behind at all", () => {
    expect(storeFault(() => uniqueTag("ABCDEFGH", new Set(["ABCDEFGH"]))).code).toBe("project-exists");
  });
});
