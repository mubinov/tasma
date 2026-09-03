import { describe, expect, it } from "vitest";
import { commentIdOf, toChange } from "../../src/tasks/input.js";
import { refused } from "../helpers.js";

describe("toChange", () => {
  it("carries every field of the body through", () => {
    expect(toChange({ title: "Write it", body: "text", labels: ["dev"] })).toEqual({
      title: "Write it",
      body: "text",
      labels: ["dev"],
    });
  });

  it("reads an absent body as a change that sets nothing", () => {
    expect(toChange(undefined)).toEqual({});
  });

  it("converts a top-level null into the undefined the engine clears a field with", () => {
    const change = toChange({ priority: null });

    expect(Object.hasOwn(change, "priority")).toBe(true);
    expect(change.priority).toBeUndefined();
  });

  it("leaves a null nested under a value alone, because the pass is shallow", () => {
    expect(toChange({ custom: { a: null } })).toEqual({ custom: { a: null } });
  });

  it("carries a key that names a property of the prototype chain as its own", () => {
    const change = toChange({ toString: "text" });

    expect(Object.hasOwn(change, "toString")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(change, "toString")?.value).toBe("text");
  });

  // `JSON.parse` gives the key as an own property, and the change must keep it
  // one: an assignment onto a prototyped object would set the prototype instead
  // and drop the key the caller sent.
  it("carries a __proto__ key of the body as an own key", () => {
    const change = toChange(JSON.parse('{"__proto__": {"cleared": true}}'));

    expect(Object.hasOwn(change, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(change)).not.toMatchObject({ cleared: true });
  });

  it.each([
    ["an array", []],
    ["a string", "text"],
    ["a number", 3],
    ["a boolean", true],
    ["null", null],
  ])("refuses a body that is %s rather than an object", (_description, body) => {
    expect(refused(() => toChange(body)).code).toBe("malformed-request");
  });
});

describe("commentIdOf", () => {
  it("reads a decimal integer", () => {
    expect(commentIdOf("7")).toBe(7);
  });

  // No comment ever carries one, so it reads through and the engine answers
  // that the file holds no such comment, which is the accurate answer.
  it("reads a negative integer, which is a decimal integer like any other", () => {
    expect(commentIdOf("-7")).toBe(-7);
  });

  it.each([
    ["a decimal fraction", "1.5"],
    ["an exponent", "1e3"],
    ["a hexadecimal literal", "0x7"],
    ["a leading plus", "+7"],
    ["surrounding space", " 7 "],
    ["nothing at all", ""],
    ["a word", "seven"],
  ])("refuses %s", (_description, raw) => {
    expect(refused(() => commentIdOf(raw)).code).toBe("malformed-request");
  });

  it("refuses an integer outside the range a number carries exactly", () => {
    expect(refused(() => commentIdOf("9007199254740993")).code).toBe("malformed-request");
  });
});
