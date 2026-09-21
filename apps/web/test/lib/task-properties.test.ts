import type { Frontmatter, TaskEntry, Workflow } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import type { PendingWrite } from "../../src/lib/board";
import {
  applyPendingFrontmatter,
  carriedLabelItems,
  chosenTaskItem,
  groupValue,
  isUnsendableTask,
  labelItems,
  labelMatches,
  NO_TASK,
  priorityChoices,
  sameLabelItem,
  sameTaskItem,
  statusChoices,
  stepChoices,
  taskItemIds,
  taskItems,
  taskMatches,
  type TaskItem,
} from "../../src/lib/task-properties";

const CONFIG = {
  statuses: ["Backlog", "In Progress", "Done"],
  priorities: ["high", "medium", "low"],
};

const WORKFLOW: Workflow = {
  name: "dev",
  file: "/w/dev/workflow.yml",
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
    {
      what: "the pending write of this task states none of the keys",
      writes: [write("SAGA-3", { title: "Renamed", body: "New text." })],
    },
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
  it("ignores every key beyond the ones it applies", () => {
    const read = frontmatter({ labels: ["web"] });
    const overlaid = applyPendingFrontmatter(read, [
      write("SAGA-3", { title: "Renamed", body: "New text.", order: 12, status: "Done" }),
    ]);

    expect(overlaid).toEqual({ ...read, status: "Done" });
  });

  it("lays labels and blockers over the read lists", () => {
    const overlaid = applyPendingFrontmatter(
      frontmatter({ labels: ["web"], blocked_by: ["SAGA-1"] }),
      [write("SAGA-3", { labels: ["web", "infra"] }), write("SAGA-3", { blocked_by: ["SAGA-2"] })],
    );

    expect(overlaid.labels).toEqual(["web", "infra"]);
    expect(overlaid.blocked_by).toEqual(["SAGA-2"]);
  });

  it("removes a list a write clears", () => {
    const overlaid = applyPendingFrontmatter(
      frontmatter({ labels: ["web"], blocked_by: ["SAGA-1"] }),
      [write("SAGA-3", { labels: null, blocked_by: null })],
    );

    expect("labels" in overlaid).toBe(false);
    expect("blocked_by" in overlaid).toBe(false);
  });

  it("sets and removes the parent as it does the other keys a control clears", () => {
    const set = applyPendingFrontmatter(frontmatter(), [write("SAGA-3", { parent: "SAGA-1" })]);
    const removed = applyPendingFrontmatter(frontmatter({ parent: "SAGA-1" }), [write("SAGA-3", { parent: null })]);

    expect(set.parent).toBe("SAGA-1");
    expect("parent" in removed).toBe(false);
  });

  it("keeps a list of its own, so a later change to the sent list does not reach it", () => {
    const sent = ["web"];
    const overlaid = applyPendingFrontmatter(frontmatter(), [write("SAGA-3", { labels: sent })]);
    sent.push("infra");

    expect(overlaid.labels).toEqual(["web"]);
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

describe("the items of a task picker", () => {
  function entry(id: string, status = "Backlog", title = `Task ${id}`): TaskEntry {
    return { id, path: `/tasks/${id}.md`, blocked: false, frontmatter: frontmatter({ id, status, title }) };
  }

  it("offers every task of the project but this one, the newest id first", () => {
    const items = taskItems([entry("P-99"), entry("SAGA-3"), entry("P-100", "Done", "Close"), entry("P-7")], "SAGA-3", []);

    expect(items).toEqual([
      { kind: "task", id: "P-100", status: "Done", title: "Close" },
      { kind: "task", id: "P-99", status: "Backlog", title: "Task P-99" },
      { kind: "task", id: "P-7", status: "Backlog", title: "Task P-7" },
    ]);
  });

  it("puts a chosen id the listing holds no task for first, once", () => {
    const items = taskItems([entry("P-1")], "SAGA-3", ["P-9", "P-1", "P-9", "P-12"]);

    expect(items).toEqual([
      { kind: "missing", id: "P-9" },
      { kind: "missing", id: "P-12" },
      { kind: "task", id: "P-1", status: "Backlog", title: "Task P-1" },
    ]);
  });

  it("puts this task's own id among the chosen ones first, as itself", () => {
    expect(taskItems([entry("SAGA-3"), entry("P-1")], "SAGA-3", ["P-1", "SAGA-3", "P-9"])).toEqual([
      { kind: "self", id: "SAGA-3" },
      { kind: "missing", id: "P-9" },
      { kind: "task", id: "P-1", status: "Backlog", title: "Task P-1" },
    ]);
  });

  it("answers the item a chosen id stands for", () => {
    const entries = [entry("P-1", "Done", "Close"), entry("SAGA-3")];

    expect(chosenTaskItem(entries, "SAGA-3", "P-1")).toEqual({ kind: "task", id: "P-1", status: "Done", title: "Close" });
    expect(chosenTaskItem(entries, "SAGA-3", "P-9")).toEqual({ kind: "missing", id: "P-9" });
    expect(chosenTaskItem(entries, "SAGA-3", "SAGA-3")).toEqual({ kind: "self", id: "SAGA-3" });
  });

  it.each([
    { item: { kind: "missing", id: "P-9" }, unsendable: true },
    { item: { kind: "self", id: "SAGA-3" }, unsendable: true },
    { item: { kind: "task", id: "P-1", status: "Done", title: "Close" }, unsendable: false },
    { item: NO_TASK, unsendable: false },
  ] satisfies { item: TaskItem; unsendable: boolean }[])("holds a $item.kind item unsendable: $unsendable", ({ item, unsendable }) => {
    expect(isUnsendableTask(item)).toBe(unsendable);
  });

  it.each([
    { query: "", matches: true },
    { query: "9", matches: true },
    { query: "p-9", matches: true },
    { query: "EXPORT", matches: true },
    { query: "ledger as", matches: true },
    { query: "p-8", matches: false },
  ])("matches the query $query against the id or the title, without case", ({ query, matches }) => {
    expect(taskMatches({ kind: "task", id: "P-9", status: "To Do", title: "Export the ledger as CSV" }, query))
      .toBe(matches);
  });

  it("answers the ids of the items in order, the clearing row standing for none", () => {
    expect(taskItemIds([
      { kind: "task", id: "P-1", status: "Done", title: "Close" },
      NO_TASK,
      { kind: "missing", id: "P-9" },
      { kind: "self", id: "SAGA-3" },
    ])).toEqual(["P-1", "P-9", "SAGA-3"]);
  });

  it.each(["missing", "self"] as const)("matches a %s item by the id alone", (kind) => {
    expect(taskMatches({ kind, id: "P-9" }, "p-9")).toBe(true);
    expect(taskMatches({ kind, id: "P-9" }, "found")).toBe(false);
  });

  it("matches the row that clears the field only while nothing is typed", () => {
    expect(taskMatches(NO_TASK, "")).toBe(true);
    expect(taskMatches(NO_TASK, "none")).toBe(false);
  });

  it("holds two items equal by their id, and the clearing row equal to itself alone", () => {
    expect(sameTaskItem({ kind: "task", id: "P-1", status: "Done", title: "Close" }, { kind: "missing", id: "P-1" }))
      .toBe(true);
    expect(sameTaskItem({ kind: "missing", id: "P-1" }, { kind: "missing", id: "P-2" })).toBe(false);
    expect(sameTaskItem(NO_TASK, { kind: "none" })).toBe(true);
    expect(sameTaskItem(NO_TASK, { kind: "missing", id: "P-1" })).toBe(false);
    expect(sameTaskItem({ kind: "missing", id: "P-1" }, NO_TASK)).toBe(false);
  });
});

describe("the items of the labels picker", () => {
  function entry(id: string, labels: string[]): TaskEntry {
    return { id, path: `/tasks/${id}.md`, blocked: false, frontmatter: frontmatter({ id, labels }) };
  }

  it("offers every label of the project with its count, folded without case, in order", () => {
    expect(labelItems([entry("P-1", ["web", "infra"]), entry("P-2", ["Web"]), entry("P-3", ["api"])])).toEqual([
      { kind: "label", label: "api", count: 1 },
      { kind: "label", label: "infra", count: 1 },
      { kind: "label", label: "web", count: 2 },
    ]);
  });

  it("carries each label of the task once, in its first spelling, with no count", () => {
    expect(carriedLabelItems(["WEB", "docs", "Docs", "web"])).toEqual([
      { kind: "label", label: "WEB" },
      { kind: "label", label: "docs" },
    ]);
  });

  it("matches the query anywhere in the label, without case", () => {
    expect(labelMatches({ kind: "label", label: "infra" }, "FR")).toBe(true);
    expect(labelMatches({ kind: "label", label: "infra" }, "web")).toBe(false);
  });

  it("holds two labels equal without case, and the Add row equal to no label", () => {
    expect(sameLabelItem({ kind: "label", label: "web", count: 2 }, { kind: "label", label: "Web" })).toBe(true);
    expect(sameLabelItem({ kind: "label", label: "web" }, { kind: "label", label: "api" })).toBe(false);
    expect(sameLabelItem({ kind: "add", label: "web" }, { kind: "label", label: "web" })).toBe(false);
    expect(sameLabelItem({ kind: "label", label: "web" }, { kind: "add", label: "web" })).toBe(false);
  });
});
