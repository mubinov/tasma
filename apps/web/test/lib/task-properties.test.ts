import type { Frontmatter, Workflow } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import type { PendingWrite } from "../../src/lib/board";
import {
  applyPendingFrontmatter,
  groupValue,
  priorityChoices,
  statusChoices,
  stepChoices,
} from "../../src/lib/task-properties";

const CONFIG = {
  statuses: ["Backlog", "In Progress", "Done"],
  priorities: ["high", "medium", "low"],
};

const WORKFLOW: Workflow = {
  name: "dev",
  instructions: [],
  steps: [
    { name: "research", file: "/w/dev/research.md", owner: "agent" },
    { name: "approve", file: "/w/dev/approve.md", owner: "human" },
  ],
};

function frontmatter(fields: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: "SAGA-3",
    title: "Build the parser",
    status: "In Progress",
    created: "2026-09-01T10:00:00Z",
    updated: "2026-09-01T10:00:00Z",
    next_comment_id: 1,
    ...fields,
  };
}

function write(id: string, change: Record<string, unknown>, submittedAt = 0): PendingWrite {
  return { id, change, submittedAt };
}

describe("applyPendingFrontmatter", () => {
  // The same object, not an equal one: it is the input to the whole sidebar
  // subtree, which a fresh object each render would re-render entire.
  it.each([
    { what: "nothing is pending", writes: [] },
    { what: "only another task is written", writes: [write("SAGA-9", { status: "Done" })] },
    { what: "the pending write of this task states none of the three keys", writes: [write("SAGA-3", { title: "Renamed" })] },
  ])("returns the frontmatter it was given when $what", ({ writes }) => {
    const read = frontmatter({ priority: "high" });

    expect(applyPendingFrontmatter(read, writes)).toBe(read);
  });

  it("lays status, priority and step over the read values", () => {
    const overlaid = applyPendingFrontmatter(
      frontmatter({ priority: "low", workflow: "dev", step: "research" }),
      [write("SAGA-3", { status: "Done" }), write("SAGA-3", { priority: "high" }), write("SAGA-3", { step: "approve" })],
    );

    expect(overlaid.status).toBe("Done");
    expect(overlaid.priority).toBe("high");
    expect(overlaid.step).toBe("approve");
  });

  it("applies the writes in send order, so the last one wins", () => {
    const overlaid = applyPendingFrontmatter(frontmatter(), [
      write("SAGA-3", { status: "Backlog" }, 1),
      write("SAGA-3", { status: "Done" }, 2),
    ]);

    expect(overlaid.status).toBe("Done");
  });

  it("removes the key a write clears", () => {
    const overlaid = applyPendingFrontmatter(
      frontmatter({ priority: "high", workflow: "dev", step: "research" }),
      [write("SAGA-3", { priority: null }), write("SAGA-3", { step: null })],
    );

    expect("priority" in overlaid).toBe(false);
    expect("step" in overlaid).toBe(false);
  });

  // Status is required and its menu offers no "None", so a null under it is not a removal.
  it("keeps the status a write states as null", () => {
    const overlaid = applyPendingFrontmatter(frontmatter(), [write("SAGA-3", { status: null })]);

    expect(overlaid.status).toBe("In Progress");
  });

  it("ignores the writes of another task", () => {
    const overlaid = applyPendingFrontmatter(frontmatter(), [write("SAGA-9", { status: "Done" })]);

    expect(overlaid.status).toBe("In Progress");
  });

  // The Save of the text editor is a pending write for this very id.
  it("ignores every key beyond the three it applies", () => {
    const read = frontmatter({ labels: ["web"] });
    const overlaid = applyPendingFrontmatter(read, [
      write("SAGA-3", { title: "Renamed", body: "New text.", labels: ["infra"], order: 12 }),
    ]);

    expect(overlaid).toEqual(read);
  });

  it("leaves the frontmatter it was given untouched", () => {
    const read = frontmatter({ priority: "high" });
    applyPendingFrontmatter(read, [write("SAGA-3", { status: "Done" }), write("SAGA-3", { priority: null })]);

    expect(read.status).toBe("In Progress");
    expect(read.priority).toBe("high");
  });
});

describe("the choices of a row", () => {
  it("offers the project's statuses in the project's order", () => {
    expect(statusChoices(CONFIG)).toEqual([
      { value: "Backlog", label: "Backlog" },
      { value: "In Progress", label: "In Progress" },
      { value: "Done", label: "Done" },
    ]);
  });

  it("offers the project's priorities in the project's order", () => {
    expect(priorityChoices(CONFIG)).toEqual([
      { value: "high", label: "high" },
      { value: "medium", label: "medium" },
      { value: "low", label: "low" },
    ]);
  });

  it("offers the workflow's steps in order, as plain names", () => {
    expect(stepChoices(WORKFLOW)).toEqual([
      { value: "research", label: "research" },
      { value: "approve", label: "approve" },
    ]);
  });

  // A workflow read that refused answers null, and one still in flight undefined.
  it.each([{ what: "a refused read", workflow: null }, { what: "a read in flight", workflow: undefined }])(
    "offers no step for $what",
    ({ workflow }) => {
      expect(stepChoices(workflow)).toEqual([]);
    },
  );
});

describe("groupValue", () => {
  const CHOICES = statusChoices(CONFIG);
  const STEPS = stepChoices(WORKFLOW);

  it("answers the configured spelling of a stored value, matched without case", () => {
    expect(groupValue("in progress", CHOICES, "without case")).toBe("In Progress");
  });

  it("answers the declared name of a stored step, matched as written", () => {
    expect(groupValue("research", STEPS, "exact")).toBe("research");
  });

  // The daemon declares a step by its exact name, so a step differing in case is
  // stale: checking the declared step would contradict the value beside the menu
  // and let the guard on the checked item swallow the pick that repairs the row.
  it("answers null for a stored step that differs from a declared one in case alone", () => {
    expect(groupValue("Research", STEPS, "exact")).toBeNull();
    expect(groupValue("Research", STEPS, "without case")).toBe("research");
  });

  // "None" carries the check, so an empty field reads its own state in the open menu.
  it.each(["exact", "without case"] as const)("answers the empty string for an absent value, %s", (match) => {
    expect(groupValue(undefined, CHOICES, match)).toBe("");
  });

  // Not the empty string: that would check "None" on a task that does hold a value.
  it("answers null for a stored value the choices do not hold", () => {
    expect(groupValue("Waiting", CHOICES, "without case")).toBeNull();
  });
});
