import type { Diagnostic, Frontmatter, TaskEntry, Workflow } from "@tasma/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPending,
  boardHolds,
  boardValue,
  boardWarnings,
  type BoardProject,
  type CardClick,
  type CardConfig,
  buildColumns,
  cardConfig,
  cardMarks,
  cardPlace,
  columnKeys,
  createdTarget,
  distinctLabels,
  isFinalStatus,
  isSeveral,
  isTopPriority,
  joinList,
  labelChoices,
  moveTarget,
  opensTask,
  readBoard,
  splitList,
  statusColumn,
  stepView,
  tagOf,
  takesCard,
  workflowNames,
} from "../../src/lib/board";

const CONFIG = { statuses: ["Backlog", "To Do", "Done"], final_statuses: ["Done"] };

const PROJECTS: BoardProject[] = [{ tag: "T", config: CONFIG }];

function project(tag: string, statuses: string[], finalStatuses: string[] = []): BoardProject {
  return { tag, config: { statuses, final_statuses: finalStatuses } };
}

const ALPHA = project("ALPHA", ["Backlog", "To Do", "In Progress", "Done"], ["Done"]);

const BETA = project("BETA", ["TO DO", "Review", "Done"], ["Done"]);

const ALPHA_CONFIG: CardConfig = { ...ALPHA.config, priorities: ["high", "medium", "low"] };

function betaConfig(finalStatuses: string[]): CardConfig {
  return { statuses: BETA.config.statuses, final_statuses: finalStatuses, priorities: ["urgent", "normal"] };
}

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
  file: "/w/dev/workflow.yml",
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

describe("readBoard", () => {
  it.each([undefined, "", ", ,"])("reads %s as no tag", (value) => {
    const board = readBoard(value);

    expect(board).toEqual({ all: false, tags: [] });
    expect(boardValue(board)).toBe("");
  });

  it("sorts the tags by code unit and drops exact repeats", () => {
    const board = readBoard("BETA,ALPHA,ALPHA");

    expect(board).toEqual({ all: false, tags: ["ALPHA", "BETA"] });
    expect(boardValue(board)).toBe("ALPHA,BETA");
  });

  it("gives one tag as the tag itself", () => {
    expect(boardValue(readBoard(" SAGA ,SAGA"))).toBe("SAGA");
  });

  it.each(["all", "ALPHA,all", " all "])("reads %s as every project", (value) => {
    const board = readBoard(value);

    expect(board).toEqual({ all: true, tags: [] });
    expect(boardValue(board)).toBe("all");
  });

  it("reads ALL as a tag", () => {
    expect(readBoard("ALL")).toEqual({ all: false, tags: ["ALL"] });
  });
});

describe("isSeveral", () => {
  it.each([
    { value: "all", several: true },
    { value: "ALPHA,BETA", several: true },
    { value: "ALPHA", several: false },
    { value: "ALPHA,ALPHA", several: false },
    { value: "", several: false },
  ])("reads $value as several: $several", ({ value, several }) => {
    expect(isSeveral(readBoard(value))).toBe(several);
  });
});

describe("boardHolds", () => {
  it.each([
    { board: "SAGA", tag: "SAGA", holds: true },
    { board: "SAGA", tag: "DELTA", holds: false },
    { board: "DELTA,SAGA", tag: "SAGA", holds: true },
    { board: "DELTA,SAGA", tag: "GAMMA", holds: false },
    { board: "all", tag: "SAGA", holds: true },
    { board: "ALL", tag: "ALL", holds: true },
    { board: "ALL", tag: "DELTA", holds: false },
    { board: "", tag: "SAGA", holds: false },
  ])("reads $board as holding $tag: $holds", ({ board, tag, holds }) => {
    expect(boardHolds(board, tag)).toBe(holds);
  });
});

describe("columnKeys", () => {
  it("gives the lowercase status of each column", () => {
    expect(columnKeys([{ status: "To Do" }, { status: "Open" }])).toEqual(["to do", "open"]);
  });

  it("counts a repeat of the lowercase status from #2", () => {
    expect(columnKeys([{ status: "Open" }, { status: "OPEN" }, { status: "open" }])).toEqual(["open", "open#2", "open#3"]);
  });

  it("gives no key twice when a status reads like a repeat", () => {
    expect(columnKeys([{ status: "Open" }, { status: "open#2" }, { status: "open" }])).toEqual(["open", "open#2", "open#3"]);
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
    const columns = buildColumns(PROJECTS, [], []);

    expect(columns.map((column) => [column.status, column.final, column.total])).toEqual([
      ["Backlog", false, 0],
      ["To Do", false, 0],
      ["Done", true, 0],
    ]);
  });

  it("gives no column when no status is configured", () => {
    expect(buildColumns([project("T", [])], [entry("T-1")], [])).toEqual([]);
  });

  it("puts a task in the column its status names, ignoring case", () => {
    const columns = buildColumns(PROJECTS, [entry("T-1", { status: "to do" })], []);

    expect(ids(columns[1]!.matching)).toEqual(["T-1"]);
  });

  it("puts a task whose status matches no column in the first column", () => {
    const columns = buildColumns(PROJECTS, [entry("T-1", { status: "Waiting" })], []);

    expect(ids(columns[0]!.matching)).toEqual(["T-1"]);
    expect(columns[0]!.total).toBe(1);
  });

  it("puts a task in the first of two equal statuses", () => {
    const columns = buildColumns([project("T", ["Backlog", "Backlog"])], [entry("T-1")], []);

    expect(columns.map((column) => column.total)).toEqual([1, 0]);
  });

  it("marks a column final ignoring case", () => {
    const columns = buildColumns([project("T", ["Open", "Done"], ["done"])], [], []);

    expect(columns.map((column) => column.final)).toEqual([false, true]);
  });

  it("orders an open column by order, then by id number, then the tasks with no order", () => {
    const columns = buildColumns(
      PROJECTS,
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

  it("orders a final column by order, then by id number, then the tasks with no order by update time", () => {
    const columns = buildColumns(
      PROJECTS,
      [
        entry("T-9", { status: "Done", updated: "2026-09-01T09:00:00Z" }),
        entry("T-4", { status: "Done", order: 2, updated: "2026-08-01T10:00:00Z" }),
        entry("T-12", { status: "Done", order: 1 }),
        entry("T-3", { status: "Done", updated: "2026-09-02T10:00:00Z" }),
        entry("T-10", { status: "Done", order: 2, updated: "2026-09-03T10:00:00Z" }),
        entry("T-2", { status: "Done", order: 2 }),
      ],
      [],
    );

    expect(ids(columns[2]!.matching)).toEqual(["T-12", "T-2", "T-4", "T-10", "T-3", "T-9"]);
  });

  it("orders the tasks with no order in a final column by the parsed update time, newest first", () => {
    const columns = buildColumns(
      PROJECTS,
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
      PROJECTS,
      [entry("T-2", { status: "Done", updated }), entry("T-10", { status: "Done", updated }), entry("T-3", { status: "Done", updated })],
      [],
    );

    expect(ids(columns[2]!.matching)).toEqual(["T-10", "T-3", "T-2"]);
  });

  it("puts a final task whose update time does not parse after every task whose time parses", () => {
    const columns = buildColumns(
      PROJECTS,
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
    const columns = buildColumns(PROJECTS, [entry("T-1", { labels: ["web"] }), entry("T-2")], []);

    expect(ids(columns[0]!.matching)).toEqual(["T-1", "T-2"]);
  });

  it("matches a task that carries any selected label, ignoring case", () => {
    const columns = buildColumns(
      PROJECTS,
      [entry("T-1", { labels: ["Web"] }), entry("T-2", { labels: ["infra", "docs"] }), entry("T-3", { labels: ["ui"] }), entry("T-4")],
      ["web", "DOCS"],
    );

    expect(ids(columns[0]!.matching)).toEqual(["T-1", "T-2"]);
    expect(columns[0]!.total).toBe(4);
  });

  it("matches a task whose id is in the id set, and counts every task in the total", () => {
    const columns = buildColumns(PROJECTS, [entry("T-1"), entry("T-2"), entry("T-3", { status: "Done" })], [], new Set(["T-2", "T-3"]));

    expect(ids(columns[0]!.matching)).toEqual(["T-2"]);
    expect(columns[0]!.total).toBe(2);
    expect(ids(columns[2]!.matching)).toEqual(["T-3"]);
  });

  it("matches no task for an empty id set", () => {
    const columns = buildColumns(PROJECTS, [entry("T-1")], [], new Set());

    expect(columns[0]!.matching).toEqual([]);
    expect(columns[0]!.total).toBe(1);
  });

  it("matches a task only when it carries a selected label and its id is in the id set", () => {
    const columns = buildColumns(
      PROJECTS,
      [entry("T-1", { labels: ["web"] }), entry("T-2", { labels: ["web"] }), entry("T-3")],
      ["web"],
      new Set(["T-2", "T-3"]),
    );

    expect(ids(columns[0]!.matching)).toEqual(["T-2"]);
    expect(columns[0]!.total).toBe(3);
  });
});

describe("tagOf", () => {
  it("gives the tag of an id", () => {
    expect(tagOf("ALPHA-12")).toBe("ALPHA");
  });
});

describe("buildColumns over several projects", () => {
  function row(projects: readonly BoardProject[]): [string, Readonly<Record<string, string>>][] {
    return buildColumns(projects, [], []).map(({ status, byTag }) => [status, byTag]);
  }

  it("gives one column per status of all the projects, statuses that differ in case joined", () => {
    expect(row([ALPHA, BETA])).toEqual([
      ["Backlog", { ALPHA: "Backlog" }],
      ["To Do", { ALPHA: "To Do", BETA: "TO DO" }],
      ["In Progress", { ALPHA: "In Progress" }],
      ["Review", { BETA: "Review" }],
      ["Done", { ALPHA: "Done", BETA: "Done" }],
    ]);
  });

  it.each([
    { case: "the first project's order wins a conflict", alpha: ["A", "B", "C"], beta: ["C", "X", "A"], statuses: ["X", "A", "B", "C"] },
    { case: "consecutive new statuses keep their order", alpha: ["A", "B"], beta: ["X", "Y", "B"], statuses: ["A", "X", "Y", "B"] },
    { case: "a new status with no later joined status goes at the end", alpha: ["A", "B"], beta: ["A", "X"], statuses: ["A", "B", "X"] },
  ])("places a new status where $case", ({ alpha, beta, statuses }) => {
    expect(row([project("ALPHA", alpha), project("BETA", beta)]).map(([status]) => status)).toEqual(statuses);
  });

  it("gives a column to each status of one project, when two of them differ only in case", () => {
    expect(row([project("ALPHA", ["Open", "Closed", "open"])])).toEqual([
      ["Open", { ALPHA: "Open" }],
      ["Closed", { ALPHA: "Closed" }],
      ["open", { ALPHA: "open" }],
    ]);
  });

  it("joins a status to the first matching column that its project is not in yet", () => {
    expect(row([project("ALPHA", ["Open", "open"]), project("BETA", ["open", "OPEN"])])).toEqual([
      ["Open", { ALPHA: "Open", BETA: "open" }],
      ["open", { ALPHA: "open", BETA: "OPEN" }],
    ]);
  });

  it.each([
    { case: "final in one project and open in the other", betaFinal: [], final: false },
    { case: "final in both projects", betaFinal: ["done"], final: true },
  ])("marks a column final only when its status is $case", ({ betaFinal, final }) => {
    const columns = buildColumns([project("ALPHA", ["Open", "Done"], ["Done"]), project("BETA", ["DONE"], betaFinal)], [], []);

    expect(columns.map((column) => column.final)).toEqual([false, final]);
  });

  it("puts a task in the column of its own project's status, else of its project's first status", () => {
    const columns = buildColumns(
      [ALPHA, BETA],
      [entry("BETA-1", { status: "review" }), entry("BETA-2", { status: "Waiting" }), entry("ALPHA-1", { status: "Waiting" })],
      [],
    );

    expect(columns.map((column) => ids(column.matching))).toEqual([["ALPHA-1"], ["BETA-2"], [], ["BETA-1"], []]);
  });

  it("puts a task whose tag names no project of the board in no column", () => {
    const columns = buildColumns([ALPHA, BETA], [entry("GAMMA-1")], []);

    expect(columns.map((column) => column.total)).toEqual([0, 0, 0, 0, 0]);
  });

  it.each([
    {
      case: "an open column with order",
      tasks: [entry("BETA-3", { order: 5 }), entry("ALPHA-3", { order: 5 }), entry("ALPHA-4", { order: 5 })],
      sorted: ["ALPHA-3", "BETA-3", "ALPHA-4"],
    },
    {
      case: "an open column without order",
      tasks: [entry("BETA-3"), entry("ALPHA-3"), entry("BETA-2")],
      sorted: ["BETA-2", "ALPHA-3", "BETA-3"],
    },
    {
      case: "a final column with order",
      tasks: [entry("BETA-3", { status: "Done", order: 5 }), entry("ALPHA-3", { status: "Done", order: 5 })],
      sorted: ["ALPHA-3", "BETA-3"],
    },
    {
      case: "a final column without order",
      tasks: [entry("BETA-3", { status: "Done" }), entry("ALPHA-3", { status: "Done" }), entry("BETA-4", { status: "Done" })],
      sorted: ["BETA-4", "ALPHA-3", "BETA-3"],
    },
  ])("sorts by tag after every other rule in $case, whatever the input order", ({ tasks, sorted }) => {
    const projects = [project("ALPHA", ["Backlog", "Done"], ["Done"]), project("BETA", ["Backlog", "Done"], ["Done"])];
    const shown = (input: TaskEntry[]): string[] =>
      buildColumns(projects, input, []).flatMap((column) => ids(column.matching));

    expect(shown(tasks)).toEqual(sorted);
    expect(shown(tasks.toReversed())).toEqual(sorted);
  });
});

describe("statusColumn", () => {
  const COLUMNS = buildColumns([ALPHA, BETA], [], []);

  it("gives the first column that holds the project's status, without case", () => {
    expect(statusColumn(COLUMNS, "BETA", "to do")).toBe(1);
    expect(statusColumn(COLUMNS, "ALPHA", "DONE")).toBe(4);
  });

  it("gives -1 for a status that the project does not have", () => {
    expect(statusColumn(COLUMNS, "BETA", "Backlog")).toBe(-1);
    expect(statusColumn(COLUMNS, "GAMMA", "Done")).toBe(-1);
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

describe("cardConfig", () => {
  const CONFIGS = new Map([["ALPHA", ALPHA_CONFIG], ["BETA", betaConfig([])]]);

  it("gives the config of the card's own project", () => {
    expect(cardConfig(CONFIGS, "ALPHA-1")).toBe(ALPHA_CONFIG);
  });

  it("gives an empty config for a card whose project the configs do not hold", () => {
    expect(cardConfig(CONFIGS, "GAMMA-3")).toEqual({ statuses: [], final_statuses: [], priorities: [] });
  });
});

describe("takesCard", () => {
  const COLUMNS = buildColumns([ALPHA, BETA], [], []);

  it("takes a card into a column of its project's status, and not into a column that only another project has", () => {
    expect(COLUMNS[1]?.byTag).toEqual({ ALPHA: "To Do", BETA: "TO DO" });
    expect(takesCard(COLUMNS[1]!, "ALPHA-1")).toBe(true);
    expect(COLUMNS[3]?.byTag).toEqual({ BETA: "Review" });
    expect(takesCard(COLUMNS[3]!, "ALPHA-1")).toBe(false);
  });
});

describe("cardMarks", () => {
  const STEP = { workflow: "dev", step: "research" };

  it("hides the step of a card whose own project marks the column's status final", () => {
    const done = buildColumns([ALPHA, project("BETA", BETA.config.statuses, [])], [], [])[4]!;

    expect(done.final).toBe(false);
    expect(cardMarks(entry("ALPHA-1", STEP), done, ALPHA_CONFIG, WORKFLOW).view).toEqual({ kind: "none" });
    expect(cardMarks(entry("BETA-2", STEP), done, betaConfig([]), WORKFLOW).view).toMatchObject({ kind: "step", name: "research" });
  });

  it("shows the step of a card in a column that its own project does not have", () => {
    const review = buildColumns([ALPHA, BETA], [], [])[3]!;
    const config = { ...ALPHA_CONFIG, final_statuses: ["Review"] };

    expect(cardMarks(entry("ALPHA-1", STEP), review, config, WORKFLOW).view).toMatchObject({ kind: "step" });
  });

  it.each([
    { id: "BETA-1", priority: "urgent", top: true },
    { id: "BETA-2", priority: "high", top: false },
    { id: "ALPHA-1", priority: "high", top: true },
  ])("says $top for $id at $priority, by the first priority of its own project", ({ id, priority, top }) => {
    const toDo = buildColumns([ALPHA, BETA], [], [])[1]!;
    const configs = new Map([["ALPHA", ALPHA_CONFIG], ["BETA", betaConfig(["Done"])]]);

    expect(cardMarks(entry(id, { priority }), toDo, cardConfig(configs, id), WORKFLOW).top).toBe(top);
  });

  it.each([
    { case: "a board of one project", statuses: ["Backlog", "To Do", "Done"] },
    { case: "a hand-edited config that holds the final status twice", statuses: ["To Do", "Done", "Done"] },
  ])("gives the view of the column's final flag on $case", ({ statuses }) => {
    const config: CardConfig = { statuses, final_statuses: ["Done"], priorities: [] };
    const task = entry("T-1", STEP);
    const columns = buildColumns([{ tag: "T", config }], [], []);

    expect(columns.map((column) => column.status)).toEqual(statuses);
    expect(columns.map((column) => cardMarks(task, column, config, WORKFLOW).view))
      .toEqual(columns.map((column) => stepView(task.frontmatter, column.final, WORKFLOW)));
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

describe("applyPending", () => {
  const SENT = Date.parse("2026-09-02T08:30:00Z");

  it("gives back the same entries while nothing is pending", () => {
    const entries = [entry("T-1")];

    expect(applyPending(entries, [])).toBe(entries);
  });

  it("copies the status and the order of a change onto a copy of its entry, and moves updated with the status", () => {
    const entries = [entry("T-1"), entry("T-2", { order: 5 })];

    const shown = applyPending(entries, [{ id: "T-2", change: { status: "Done", order: -1000 }, submittedAt: SENT }]);

    expect(shown[0]).toBe(entries[0]);
    expect(shown[1]?.frontmatter).toEqual({
      ...entries[1]!.frontmatter,
      status: "Done",
      order: -1000,
      updated: "2026-09-02T08:30:00.000Z",
    });
    expect(entries[1]?.frontmatter.status).toBe("Backlog");
  });

  it("removes the order for a change that clears it", () => {
    const shown = applyPending([entry("T-1", { order: 5 })], [{ id: "T-1", change: { order: null }, submittedAt: SENT }]);

    expect("order" in shown[0]!.frontmatter).toBe(false);
  });

  it.each([
    { name: "an order alone", change: { order: 3 } },
    { name: "the status the entry has, in another case", change: { status: "backlog" } },
  ])("keeps updated for $name", ({ change }) => {
    const shown = applyPending([entry("T-1")], [{ id: "T-1", change, submittedAt: SENT }]);

    expect(shown[0]?.frontmatter.updated).toBe("2026-09-01T10:00:00Z");
  });

  it("applies the changes to one task in the order they were sent, so the last one wins", () => {
    const later = SENT + 60_000;

    const shown = applyPending(
      [entry("T-1")],
      [
        { id: "T-1", change: { status: "To Do", order: 1 }, submittedAt: SENT },
        { id: "T-1", change: { status: "Done", order: 2 }, submittedAt: later },
      ],
    );

    expect(shown[0]?.frontmatter).toMatchObject({ status: "Done", order: 2, updated: new Date(later).toISOString() });
  });

  it("ignores a change to a task the entries do not hold, and a field it does not apply", () => {
    const entries = [entry("T-1")];

    const shown = applyPending(entries, [
      { id: "T-9", change: { status: "Done" }, submittedAt: SENT },
      { id: "T-1", change: { title: "Renamed", priority: "high" }, submittedAt: SENT },
    ]);

    expect(shown[0]?.frontmatter).toEqual(entries[0]?.frontmatter);
  });
});

describe("cardPlace", () => {
  const COLUMNS = buildColumns(
    PROJECTS,
    [entry("T-1"), entry("T-2", { status: "Done", order: 1 }), entry("T-3", { status: "Done", order: 2 })],
    [],
  );

  it("names the card's column and its place in it", () => {
    expect(cardPlace(COLUMNS, "T-3")).toMatchObject({ column: 2, index: 1 });
    expect(cardPlace(COLUMNS, "T-3")?.entry.id).toBe("T-3");
    expect(cardPlace(COLUMNS, "T-1")).toMatchObject({ column: 0, index: 0 });
  });

  it("is none for a card no column holds", () => {
    expect(cardPlace(COLUMNS, "T-9")).toBeNull();
  });
});

describe("moveTarget", () => {
  const ENTRIES = [
    entry("T-1", { status: "To Do", labels: ["web"], order: 1 }),
    entry("T-2", { status: "To Do", order: 2 }),
    entry("T-3", { status: "To Do", labels: ["web"], order: 3 }),
    entry("T-4", { labels: ["web"] }),
  ];

  it("reads the target column with the filtered tasks and without them, and never with the moved card", () => {
    const columns = buildColumns(PROJECTS, ENTRIES, ["web"]);
    const { unfiltered, visible, card } = moveTarget(PROJECTS, ENTRIES, columns, 1, "T-1");

    expect(ids(unfiltered)).toEqual(["T-2", "T-3"]);
    expect(ids(visible)).toEqual(["T-3"]);
    expect(card.id).toBe("T-1");
  });

  it("reads a card moving into a column it is no part of yet", () => {
    const columns = buildColumns(PROJECTS, ENTRIES, []);
    const { unfiltered, visible, card } = moveTarget(PROJECTS, ENTRIES, columns, 1, "T-4");

    expect(ids(unfiltered)).toEqual(["T-1", "T-2", "T-3"]);
    expect(ids(visible)).toEqual(["T-1", "T-2", "T-3"]);
    expect(card.id).toBe("T-4");
  });

  it("reads a merged column with the cards of each project in it", () => {
    const entries = [entry("ALPHA-1", { status: "To Do", order: 1 }), entry("BETA-1", { status: "TO DO", order: 2 }), entry("BETA-2", { status: "Review" })];
    const columns = buildColumns([ALPHA, BETA], entries, []);
    const { unfiltered, visible, card } = moveTarget([ALPHA, BETA], entries, columns, 1, "BETA-2");

    expect(ids(unfiltered)).toEqual(["ALPHA-1", "BETA-1"]);
    expect(ids(visible)).toEqual(["ALPHA-1", "BETA-1"]);
    expect(card.id).toBe("BETA-2");
  });
});

describe("createdTarget", () => {
  const LISTING_PROJECTS: BoardProject[] = [{ tag: "P", config: CONFIG }];

  const LISTING = [
    entry("P-1"),
    entry("P-2", { status: "to do", labels: ["web"] }),
    entry("P-3", { status: "Gone" }),
    entry("P-4", { status: "Done" }),
  ];

  it("is the card when the board shows it", () => {
    expect(createdTarget(LISTING_PROJECTS, LISTING, [], null, "P-2", "to do")).toEqual({ kind: "card" });
    expect(createdTarget(LISTING_PROJECTS, LISTING, ["WEB"], null, "P-2", "to do")).toEqual({ kind: "card" });
    expect(createdTarget(LISTING_PROJECTS, LISTING, ["web"], new Set(["P-2"]), "P-2", "to do")).toEqual({ kind: "card" });
  });

  it("is the heading of the column that holds the card when the label filter hides it", () => {
    expect(createdTarget(LISTING_PROJECTS, LISTING, ["web"], null, "P-4", "Done")).toEqual({
      kind: "column",
      column: 2,
      hiddenBy: "labels",
    });
  });

  it("names the search when the id set hides the card and the labels do not", () => {
    expect(createdTarget(LISTING_PROJECTS, LISTING, [], new Set(["P-1"]), "P-4", "Done")).toEqual({
      kind: "column",
      column: 2,
      hiddenBy: "search",
    });
    expect(createdTarget(LISTING_PROJECTS, LISTING, ["web"], new Set(["P-1"]), "P-2", "to do")).toEqual({
      kind: "column",
      column: 1,
      hiddenBy: "search",
    });
  });

  it("names both filters when each of them hides the card", () => {
    expect(createdTarget(LISTING_PROJECTS, LISTING, ["web"], new Set(["P-1"]), "P-4", "Done")).toEqual({
      kind: "column",
      column: 2,
      hiddenBy: "both",
    });
  });

  it("names the labels when the id set holds the card", () => {
    expect(createdTarget(LISTING_PROJECTS, LISTING, ["web"], new Set(["P-4"]), "P-4", "Done")).toEqual({
      kind: "column",
      column: 2,
      hiddenBy: "labels",
    });
  });

  it("takes the column from the listing, not from the status the receipt names", () => {
    expect(createdTarget(LISTING_PROJECTS, LISTING, ["web"], null, "P-3", "Done")).toEqual({
      kind: "column",
      column: 0,
      hiddenBy: "labels",
    });
  });

  it("is the heading of the column of the receipt's status, without case, when the listing holds no such task", () => {
    expect(createdTarget(LISTING_PROJECTS, LISTING, [], null, "P-9", "done")).toEqual({ kind: "column", column: 2, hiddenBy: null });
  });

  it("is the heading of the first column when no column names the receipt's status either", () => {
    expect(createdTarget(LISTING_PROJECTS, LISTING, [], null, "P-9", "Gone")).toEqual({ kind: "column", column: 0, hiddenBy: null });
  });

  it.each([
    { case: "the column of the status in the task's project", id: "BETA-9", status: "review", column: 3 },
    { case: "the column of the first status of the task's project", id: "BETA-9", status: "Gone", column: 1 },
    { case: "the first column for a tag that is not on the board", id: "GAMMA-9", status: "Done", column: 0 },
  ])("is the heading of $case when the listing holds no such task", ({ id, status, column }) => {
    expect(createdTarget([ALPHA, BETA], [], [], null, id, status)).toEqual({ kind: "column", column, hiddenBy: null });
  });
});
