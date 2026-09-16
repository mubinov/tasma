import type { Diagnostic, Frontmatter, TaskEntry, Workflow } from "@tasma/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boardWarnings,
  type CardClick,
  buildColumns,
  distinctLabels,
  isFinalStatus,
  isTopPriority,
  joinList,
  labelChoices,
  opensTask,
  splitList,
  stepView,
  workflowNames,
} from "../../src/lib/board";

const CONFIG = { statuses: ["Backlog", "To Do", "Done"], final_statuses: ["Done"] };

function entry(id: string, fields: Partial<Frontmatter> = {}, blocked = false): TaskEntry {
  return {
    id,
    path: `/tasks/${id}.md`,
    blocked,
    frontmatter: {
      id,
      title: `Task ${id}`,
      status: "Backlog",
      created: "2026-09-01T10:00:00Z",
      updated: "2026-09-01T10:00:00Z",
      next_comment_id: 1,
      ...fields,
    },
  };
}

function ids(entries: readonly TaskEntry[]): string[] {
  return entries.map((task) => task.id);
}

const WORKFLOW: Workflow = {
  name: "dev",
  instructions: [],
  steps: [
    { name: "research", file: "/w/dev/research.md", owner: "agent" },
    { name: "approve", file: "/w/dev/approve.md", owner: "human" },
    { name: "implement", file: "/w/dev/implement.md", owner: "agent" },
  ],
};

describe("splitList", () => {
  it.each([
    { value: undefined, parts: [] },
    { value: "", parts: [] },
    { value: "web", parts: ["web"] },
    { value: " web , infra ", parts: ["web", "infra"] },
    { value: "web,,infra,", parts: ["web", "infra"] },
    { value: " , ", parts: [] },
  ])("splits $value into $parts", ({ value, parts }) => {
    expect(splitList(value)).toEqual(parts);
  });
});

describe("joinList", () => {
  it("joins with a comma", () => {
    expect(joinList(["web", "infra"])).toBe("web,infra");
  });

  it("gives undefined for an empty list", () => {
    expect(joinList([])).toBeUndefined();
  });
});

describe("isFinalStatus", () => {
  it.each([
    { status: "Done", final: true },
    { status: "done", final: true },
    { status: "CLOSED", final: true },
    { status: "In Progress", final: false },
  ])("says $final for $status", ({ status, final }) => {
    expect(isFinalStatus(status, ["Done", "Closed"])).toBe(final);
  });

  it("says false when no status is final", () => {
    expect(isFinalStatus("Done", [])).toBe(false);
  });
});

describe("buildColumns", () => {
  it("gives one column per status, in the configured order", () => {
    const columns = buildColumns(CONFIG, [], []);

    expect(columns.map((column) => [column.status, column.final, column.total])).toEqual([
      ["Backlog", false, 0],
      ["To Do", false, 0],
      ["Done", true, 0],
    ]);
  });

  it("gives no column when no status is configured", () => {
    expect(buildColumns({ statuses: [], final_statuses: [] }, [entry("T-1")], [])).toEqual([]);
  });

  it("puts a task in the column its status names, ignoring case", () => {
    const columns = buildColumns(CONFIG, [entry("T-1", { status: "to do" })], []);

    expect(ids(columns[1]!.matching)).toEqual(["T-1"]);
  });

  it("puts a task whose status matches no column in the first column", () => {
    const columns = buildColumns(CONFIG, [entry("T-1", { status: "Waiting" })], []);

    expect(ids(columns[0]!.matching)).toEqual(["T-1"]);
    expect(columns[0]!.total).toBe(1);
  });

  it("puts a task in the first of two equal statuses", () => {
    const columns = buildColumns({ statuses: ["Backlog", "Backlog"], final_statuses: [] }, [entry("T-1")], []);

    expect(columns.map((column) => column.total)).toEqual([1, 0]);
  });

  it("marks a column final ignoring case", () => {
    const columns = buildColumns({ statuses: ["Open", "Done"], final_statuses: ["done"] }, [], []);

    expect(columns.map((column) => column.final)).toEqual([false, true]);
  });

  it("orders an open column by order, then by id number, then the tasks with no order", () => {
    const columns = buildColumns(
      CONFIG,
      [
        entry("T-9"),
        entry("T-4", { order: 2 }),
        entry("T-12", { order: 1 }),
        entry("T-3"),
        entry("T-10", { order: 2 }),
        entry("T-2", { order: 2 }),
      ],
      [],
    );

    expect(ids(columns[0]!.matching)).toEqual(["T-12", "T-2", "T-4", "T-10", "T-3", "T-9"]);
  });

  it("orders a final column by the parsed update time, newest first", () => {
    const columns = buildColumns(
      CONFIG,
      [
        // 10:00Z, written with an offset that sorts it after T-2 as a string.
        entry("T-1", { status: "Done", updated: "2026-09-01T12:00:00+02:00" }),
        entry("T-2", { status: "Done", updated: "2026-09-01T11:00:00Z" }),
        entry("T-3", { status: "Done", updated: "2026-09-01T09:30:00Z" }),
      ],
      [],
    );

    expect(ids(columns[2]!.matching)).toEqual(["T-2", "T-1", "T-3"]);
  });

  it("orders equal times in a final column by id number, highest first", () => {
    const updated = "2026-09-01T10:00:00Z";
    const columns = buildColumns(
      CONFIG,
      [entry("T-2", { status: "Done", updated }), entry("T-10", { status: "Done", updated }), entry("T-3", { status: "Done", updated })],
      [],
    );

    expect(ids(columns[2]!.matching)).toEqual(["T-10", "T-3", "T-2"]);
  });

  it("puts a final task whose update time does not parse after every task whose time parses", () => {
    const columns = buildColumns(
      CONFIG,
      [
        entry("T-1", { status: "Done", updated: "yesterday" }),
        entry("T-2", { status: "Done", updated: "2026-09-01T10:00:00Z" }),
        entry("T-3", { status: "Done", updated: "not a time" }),
        entry("T-4", { status: "Done", updated: "2026-08-01T10:00:00Z" }),
      ],
      [],
    );

    expect(ids(columns[2]!.matching)).toEqual(["T-2", "T-4", "T-3", "T-1"]);
  });

  it("matches every task when no label is selected", () => {
    const columns = buildColumns(CONFIG, [entry("T-1", { labels: ["web"] }), entry("T-2")], []);

    expect(ids(columns[0]!.matching)).toEqual(["T-1", "T-2"]);
  });

  it("matches a task that carries any selected label, ignoring case", () => {
    const columns = buildColumns(
      CONFIG,
      [entry("T-1", { labels: ["Web"] }), entry("T-2", { labels: ["infra", "docs"] }), entry("T-3", { labels: ["ui"] }), entry("T-4")],
      ["web", "DOCS"],
    );

    expect(ids(columns[0]!.matching)).toEqual(["T-1", "T-2"]);
    expect(columns[0]!.total).toBe(4);
  });
});

describe("labelChoices", () => {
  it("counts each label over every task, sorted by label", () => {
    expect(
      labelChoices([
        entry("T-1", { labels: ["web", "infra"] }),
        entry("T-2", { labels: ["web"] }),
        entry("T-3"),
        entry("T-4", { status: "Done", labels: ["api"] }),
      ]),
    ).toEqual([
      { label: "api", count: 1 },
      { label: "infra", count: 1 },
      { label: "web", count: 2 },
    ]);
  });

  it("merges labels that differ in case under the first spelling, and counts a task once", () => {
    expect(labelChoices([entry("T-1", { labels: ["Web", "web"] }), entry("T-2", { labels: ["WEB"] })])).toEqual([
      { label: "Web", count: 2 },
    ]);
  });
});

describe("distinctLabels", () => {
  it("keeps the first spelling of labels that differ only in case, in order", () => {
    expect(distinctLabels(["docs", "web", "DOCS", "docs", "Web"])).toEqual(["docs", "web"]);
  });

  it("gives an empty list for no label", () => {
    expect(distinctLabels([])).toEqual([]);
  });
});

describe("workflowNames", () => {
  it("names each workflow of the listing once, in listing order", () => {
    expect(
      workflowNames([
        entry("T-1", { workflow: "dev" }),
        entry("T-2"),
        entry("T-3", { workflow: "design" }),
        entry("T-4", { workflow: "dev" }),
      ]),
    ).toEqual(["dev", "design"]);
  });

  it("gives an empty list when no task names a workflow", () => {
    expect(workflowNames([entry("T-1")])).toEqual([]);
  });
});

describe("stepView", () => {
  it("shows no step for a task with no step", () => {
    expect(stepView(entry("T-1", { workflow: "dev" }).frontmatter, false, WORKFLOW)).toEqual({ kind: "none" });
  });

  it("shows no step in a final column", () => {
    expect(stepView(entry("T-1", { workflow: "dev", step: "research" }).frontmatter, true, WORKFLOW)).toEqual({ kind: "none" });
  });

  it.each([
    { case: "a task that names no workflow", fields: { step: "research" }, workflow: WORKFLOW },
    { case: "a refused workflow", fields: { workflow: "dev", step: "research" }, workflow: null },
    { case: "a workflow not read yet", fields: { workflow: "dev", step: "research" }, workflow: undefined },
    { case: "a step the workflow does not declare", fields: { workflow: "dev", step: "deploy" }, workflow: WORKFLOW },
  ])("shows the stale step for $case", ({ fields, workflow }) => {
    expect(stepView(entry("T-1", fields).frontmatter, false, workflow)).toEqual({ kind: "stale", name: fields.step });
  });

  it("shows the step with its owner, its position and every owner", () => {
    expect(stepView(entry("T-1", { workflow: "dev", step: "approve" }).frontmatter, false, WORKFLOW)).toEqual({
      kind: "step",
      name: "approve",
      owner: "human",
      current: 1,
      owners: ["agent", "human", "agent"],
    });
  });
});

describe("opensTask", () => {
  function card(): { card: HTMLElement; text: HTMLElement; link: HTMLElement } {
    document.body.innerHTML = "<div><span>SAGA-1</span><a href=\"#\"><b>Title</b></a></div>";
    const root = document.body.firstElementChild as HTMLElement;

    return { card: root, text: root.querySelector("span")!, link: root.querySelector("b")! };
  }

  function click(fields: Partial<CardClick> & Pick<CardClick, "currentTarget">): CardClick {
    return { target: null, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...fields };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("opens the task for a primary click on the card's text", () => {
    const { card: currentTarget, text } = card();

    expect(opensTask(click({ currentTarget, target: text }))).toBe(true);
  });

  it("leaves a click inside a link or a button to that control", () => {
    const { card: currentTarget, link } = card();

    expect(opensTask(click({ currentTarget, target: link }))).toBe(false);
  });

  it("leaves a click whose target is outside the card element, as in a portal", () => {
    const { card: currentTarget } = card();
    const popup = document.createElement("div");
    document.body.append(popup);

    expect(opensTask(click({ currentTarget, target: popup }))).toBe(false);
  });

  it("leaves a click whose target is no element", () => {
    const { card: currentTarget } = card();

    expect(opensTask(click({ currentTarget, target: document }))).toBe(false);
  });

  it.each([
    { case: "the button is not the primary one", fields: { button: 1 } },
    { case: "Meta is held", fields: { metaKey: true } },
    { case: "Ctrl is held", fields: { ctrlKey: true } },
    { case: "Shift is held", fields: { shiftKey: true } },
    { case: "Alt is held", fields: { altKey: true } },
  ])("leaves the click when $case", ({ fields }) => {
    const { card: currentTarget, text } = card();

    expect(opensTask(click({ currentTarget, target: text, ...fields }))).toBe(false);
  });

  it("opens the task where the document has no selection", () => {
    const { card: currentTarget, text } = card();
    vi.spyOn(window, "getSelection").mockReturnValue(null);

    expect(opensTask(click({ currentTarget, target: text }))).toBe(true);
  });

  it("leaves a click that ends a text selection", () => {
    const { card: currentTarget, text } = card();
    window.getSelection()?.selectAllChildren(text);

    expect(opensTask(click({ currentTarget, target: text }))).toBe(false);
  });
});

describe("isTopPriority", () => {
  const PRIORITIES = ["high", "medium", "low"];

  it.each([
    { priority: "high", top: true },
    { priority: "HIGH", top: true },
    { priority: "medium", top: false },
    { priority: undefined, top: false },
  ])("says $top for $priority", ({ priority, top }) => {
    expect(isTopPriority(priority, PRIORITIES)).toBe(top);
  });

  it("says false when no priority is configured", () => {
    expect(isTopPriority("high", [])).toBe(false);
  });
});

describe("boardWarnings", () => {
  const MISSING: Diagnostic = { code: "path-missing", message: "the repository is not on disk", path: "/repos/a" };
  const UNKNOWN: Diagnostic = { code: "config-key-unknown", message: "unknown key: colour", path: "/p/config.yml", line: 4 };
  const BLOCKER: Diagnostic = { code: "blocked-by-unresolved", message: "T-9 names no task", path: "/p/T-1.md" };

  it("puts the project warnings first, then the listing warnings", () => {
    expect(boardWarnings([MISSING], [BLOCKER])).toEqual([MISSING, BLOCKER]);
  });

  it("drops a listing warning equal to a project warning", () => {
    expect(boardWarnings([MISSING, UNKNOWN], [{ ...UNKNOWN }, BLOCKER])).toEqual([MISSING, UNKNOWN, BLOCKER]);
  });

  it.each([
    { field: "code", changed: { ...UNKNOWN, code: "config-unreadable" } },
    { field: "message", changed: { ...UNKNOWN, message: "unknown key: size" } },
    { field: "path", changed: { ...UNKNOWN, path: "/q/config.yml" } },
    { field: "line", changed: { ...UNKNOWN, line: 5 } },
  ] satisfies { field: string; changed: Diagnostic }[])("keeps a listing warning that differs in $field", ({ changed }) => {
    expect(boardWarnings([UNKNOWN], [changed])).toEqual([UNKNOWN, changed]);
  });

  it("keeps two equal warnings inside one read", () => {
    expect(boardWarnings([MISSING, MISSING], [BLOCKER, BLOCKER])).toEqual([MISSING, MISSING, BLOCKER, BLOCKER]);
  });
});
