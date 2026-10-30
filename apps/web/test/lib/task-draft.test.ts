import { describe, expect, it } from "vitest";
import { createInput, draftForProject, firstDraft, hasContent, type TaskDraft } from "../../src/lib/task-draft";

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

describe("draftForProject", () => {
  const DELTA = { statuses: ["backlog", "Review", "Done"], default_status: "backlog", priorities: ["Urgent", "high"] };
  const draft: TaskDraft = { title: "Map", status: "To Do", priority: "medium", labels: ["web"], body: "Notes" };

  it("gives the status of the column with no pick, and no priority", () => {
    expect(draftForProject(draft, {}, DELTA, "Review")).toEqual({ ...draft, status: "Review", priority: null });
  });

  it("gives the default status of the project with no pick and no column status", () => {
    expect(draftForProject(draft, {}, DELTA, undefined).status).toBe("backlog");
  });

  it("keeps a picked status that the project has, in the spelling of the project", () => {
    expect(draftForProject(draft, { status: "DONE" }, DELTA, "Review").status).toBe("Done");
  });

  it.each([
    { columnStatus: "Review", status: "Review" },
    { columnStatus: undefined, status: "backlog" },
  ])(
    "gives $status for a picked status that the project does not have, with the column status $columnStatus",
    ({ columnStatus, status }) => {
      expect(draftForProject(draft, { status: "To Do" }, DELTA, columnStatus).status).toBe(status);
    },
  );

  it("keeps a picked priority that the project has, in the spelling of the project", () => {
    expect(draftForProject(draft, { priority: "urgent" }, DELTA, undefined).priority).toBe("Urgent");
  });

  it.each([
    { picked: "medium" },
    { picked: null },
  ])("gives no priority for the picked priority $picked", ({ picked }) => {
    expect(draftForProject(draft, { priority: picked }, DELTA, undefined).priority).toBeNull();
  });

  it("keeps the title, the labels and the body", () => {
    const next = draftForProject(draft, { status: "Done", priority: "high" }, DELTA, undefined);

    expect(next).toEqual({ title: "Map", status: "Done", priority: "high", labels: ["web"], body: "Notes" });
    expect(next.labels).toBe(draft.labels);
  });
});
