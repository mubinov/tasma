import { describe, expect, it } from "vitest";
import { FenceTracker } from "../../src/format/fences.js";

/** Feeds every line and returns the indexes (0-based) of the lines inside a fence. */
function fenced(text: string): number[] {
  const tracker = new FenceTracker();
  return text
    .split("\n")
    .map((line, index) => (tracker.push(line, index + 1) ? index : -1))
    .filter((index) => index >= 0);
}

describe("FenceTracker", () => {
  it("marks a backtick fence and its content", () => {
    expect(fenced("a\n```\nb\n```\nc")).toEqual([1, 2, 3]);
  });

  it("marks a tilde fence and its content", () => {
    expect(fenced("a\n~~~\nb\n~~~\nc")).toEqual([1, 2, 3]);
  });

  it("does not close a backtick fence with tildes", () => {
    expect(fenced("```\na\n~~~\nb")).toEqual([0, 1, 2, 3]);
  });

  it("accepts a closing fence longer than the opening one", () => {
    expect(fenced("```\na\n`````\nb")).toEqual([0, 1, 2]);
  });

  it("rejects a closing fence shorter than the opening one", () => {
    expect(fenced("````\na\n```\nb")).toEqual([0, 1, 2, 3]);
  });

  it("allows up to three spaces of indentation on both delimiters", () => {
    expect(fenced("   ```\na\n   ```\nb")).toEqual([0, 1, 2]);
  });

  it("does not open a fence on a line indented by four spaces", () => {
    expect(fenced("    ```\na\n    ```\nb")).toEqual([]);
  });

  it("does not open a fence on a tab-indented line", () => {
    expect(fenced("\t```\na")).toEqual([]);
  });

  // The limit stated by the format: container blocks are not modeled, so a
  // fence carried by a list item or a block quote is not recognized.
  it("does not recognize a fence inside a list item or a block quote", () => {
    expect(fenced("- item\n\n    ```\n    code\n    ```\n")).toEqual([]);
    expect(fenced("> ```\n> code\n> ```\n")).toEqual([]);
  });

  it("does not open a backtick fence whose info string contains a backtick", () => {
    expect(fenced("``` `x`\na")).toEqual([]);
  });

  it("opens a tilde fence whose info string contains a backtick", () => {
    expect(fenced("~~~ `x`\na\n~~~\nb")).toEqual([0, 1, 2]);
  });

  it("allows an info string on the opening fence and spaces on the closing one", () => {
    expect(fenced("```markdown\na\n```   \nb")).toEqual([0, 1, 2]);
  });

  it("does not close a fence on a line that carries an info string", () => {
    expect(fenced("```\na\n``` text\nb")).toEqual([0, 1, 2, 3]);
  });

  it("tolerates a trailing carriage return on both delimiters", () => {
    expect(fenced("```\r\na\n```\r\nb")).toEqual([0, 1, 2]);
  });

  it("reports the line of a fence that never closes", () => {
    const tracker = new FenceTracker();
    expect(tracker.openedAt).toBeUndefined();
    tracker.push("text", 1);
    tracker.push("```", 2);
    tracker.push("code", 3);
    expect(tracker.openedAt).toBe(2);
    tracker.push("```", 4);
    expect(tracker.openedAt).toBeUndefined();
  });
});
