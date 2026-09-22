import { describe, expect, it } from "vitest";
import { createInput, firstDraft, hasContent, type TaskDraft } from "../../src/lib/task-draft";

describe("firstDraft", () => {
  it("carries the given status and nothing else", () => {
    expect(firstDraft("To Do")).toEqual({ title: "", status: "To Do", priority: null, labels: [], body: "" });
  });
});

describe("hasContent", () => {
  const first = firstDraft("To Do");

  it("is false for a first draft, whose status was prefilled", () => {
    expect(hasContent(first, firstDraft("To Do"))).toBe(false);
  });

  it.each<[string, Partial<TaskDraft>]>([
    ["the title", { title: "Draw the map" }],
    ["a title of spaces", { title: " " }],
    ["the status", { status: "Done" }],
    ["the priority", { priority: "low" }],
    ["the labels", { labels: ["web"] }],
    ["the body", { body: "Notes" }],
  ])("is true for a change of %s", (_field, change) => {
    expect(hasContent(first, { ...first, ...change })).toBe(true);
  });

  it("is false for labels equal to the first ones in a new list", () => {
    const labelled: TaskDraft = { ...first, labels: ["web"] };

    expect(hasContent(labelled, { ...labelled, labels: ["web"] })).toBe(false);
  });
});

describe("createInput", () => {
  it("sends the status and the title as typed, and leaves out a null priority, empty labels and an empty body", () => {
    expect(createInput({ ...firstDraft("Backlog"), title: "  Draw the map " })).toEqual({
      title: "  Draw the map ",
      status: "Backlog",
    });
  });

  it("sends a priority, the labels and a body that are set", () => {
    expect(createInput({ title: "Map", status: "Done", priority: "high", labels: ["web", "ops"], body: "Notes\n" }))
      .toEqual({ title: "Map", status: "Done", priority: "high", labels: ["web", "ops"], body: "Notes\n" });
  });

  it("never sends a workflow or an order", () => {
    const input = createInput({ title: "Map", status: "Done", priority: "high", labels: ["web"], body: "Notes" });

    expect(Object.keys(input)).not.toContain("workflow");
    expect(Object.keys(input)).not.toContain("order");
  });

  it("sends a copy of the labels, not the draft's own list", () => {
    const labels = ["web"];
    const input = createInput({ ...firstDraft("Done"), title: "Map", labels });

    expect(input.labels).not.toBe(labels);
  });
});
