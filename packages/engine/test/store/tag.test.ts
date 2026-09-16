import { describe, expect, it } from "vitest";
import { generateTag, isTag, TAG_RULE } from "@tasma/engine";
import { uniqueTag } from "../../src/store/tag.js";
import { storeFault } from "./helpers.js";

describe("the rule a project is created under", () => {
  it.each(["SAGA", "A1", "WEB3", "ABCDEFGH"])("accepts %s", (tag) => {
    expect(isTag(tag)).toBe(true);
    expect(TAG_RULE.test(tag)).toBe(true);
  });

  it.each([
    ["one character", "T"],
    ["a leading digit", "1A"],
    ["lowercase letters", "saga"],
    ["a dash", "SA-GA"],
    ["nine characters", "ABCDEFGHI"],
  ])("rejects %s", (_reason, tag) => {
    expect(isTag(tag)).toBe(false);
  });

  it.each<[string, unknown]>([
    ["an array whose text matches", ["SAGA"]],
    ["a number", 4],
  ])("rejects %s, which is no string", (_reason, value) => {
    expect(isTag(value)).toBe(false);
  });
});

describe("the tag a path gives", () => {
  it.each([
    ["/Users/someone/Projects/saga", "SAGA"],
    ["../ui-loader", "UILO"],
    ["~/web3/", "WEB3"],
    ["/srv/3d-viewer", "DVIE"],
    ["/tmp/x", "XX"],
    ["/tmp/.saga", "SAGA"],
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
    expect(uniqueTag("SAGA", new Set())).toBe("SAGA");
  });

  it("counts from two for a tag that is taken", () => {
    expect(uniqueTag("SAGA", new Set(["SAGA"]))).toBe("SAGA2");
  });

  it("passes nine to ten rather than stopping at one digit", () => {
    const taken = new Set(["SAGA", "SAGA2", "SAGA3", "SAGA4", "SAGA5", "SAGA6", "SAGA7", "SAGA8", "SAGA9"]);

    expect(uniqueTag("SAGA", taken)).toBe("SAGA10");
  });

  it("refuses once no number fits within the rule", () => {
    const taken = new Set(["SAGA"]);
    for (let number = 2; number < 10_000; number += 1) taken.add(`SAGA${number}`);

    expect(storeFault(() => uniqueTag("SAGA", taken)).code).toBe("project-exists");
  });

  it("refuses a taken tag no number fits behind at all", () => {
    expect(storeFault(() => uniqueTag("ABCDEFGH", new Set(["ABCDEFGH"]))).code).toBe("project-exists");
  });
});
