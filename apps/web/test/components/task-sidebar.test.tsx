import type { Frontmatter, TaskEntry } from "@tasma/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { TaskSidebar } from "../../src/components/task-sidebar";
import { isFinalStatus, stepView } from "../../src/lib/board";
import { relationRows } from "../../src/lib/task-page";
import { stepChoices, type PickerRow, type PropertyChoice, type PropertyRow } from "../../src/lib/task-properties";
import type { TaskProperties } from "../../src/lib/use-task-properties";
import { WORKFLOW, field, frontmatter, sidebar } from "../task-screen-fixtures";

const STATUSES = ["Backlog", "In Progress", "Done"];

const PRIORITIES = ["high", "medium", "low"];

function row(names: readonly string[], extra: Partial<PropertyRow> = {}): PropertyRow {
  const choices: PropertyChoice[] = names.map((value) => ({ value, label: value }));

  return { choices, match: "without case", busy: false, onPick: () => {}, ...extra };
}

function pickerRow<Value>(extra: Partial<PickerRow<Value>> = {}): PickerRow<Value> {
  return { busy: false, onPick: () => {}, ...extra };
}

type SidebarProps = {
  fields?: Partial<Frontmatter>;
  /** `undefined` leaves the Step row a control over the workflow's steps. */
  step?: PropertyRow | null;
  status?: Partial<PropertyRow>;
  priority?: Partial<PropertyRow>;
  labels?: Partial<PickerRow<readonly string[]>>;
  entries?: TaskEntry[];
};

function Sidebar(props: SidebarProps): ReactNode {
  const { fields = {}, step, status = {}, priority = {}, labels = {}, entries = [] } = props;
  const values = frontmatter(fields);
  const view = stepView(values, isFinalStatus(values.status, ["Done"]), WORKFLOW);
  const properties: TaskProperties = {
    frontmatter: values,
    status: row(STATUSES, status),
    priority: row(PRIORITIES, priority),
    step: step === undefined
      ? row(stepChoices(WORKFLOW).map((choice) => choice.value), { match: "exact" })
      : step,
    entries,
    labels: pickerRow(labels),
    blockedBy: pickerRow(),
    parent: pickerRow(),
  };

  return (
    <TaskSidebar
      tag="SAGA"
      view={view}
      relations={relationRows(values, entries, ["Done"])}
      outline={{ headings: [], comments: [] }}
      pageScrollPadding={undefined}
      properties={properties}
    />
  );
}

function renderSidebar(props: SidebarProps = {}) {
  const result = render(<Sidebar {...props} />);

  return { ...result, rerender: (next: SidebarProps) => result.rerender(<Sidebar {...props} {...next} />) };
}

function control(label: string): HTMLElement {
  return within(field(label)).getByRole("button");
}

afterEach(() => {
  cleanup();
});

describe("the rows", () => {
  it("makes Status, Priority and Step menus, Labels a picker, and leaves the other rows text", () => {
    renderSidebar({ fields: { priority: "high", labels: ["web"], workflow: "dev", step: "research" } });

    expect(control("Status").textContent).toBe("In Progress");
    expect(control("Priority").textContent).toBe("high");
    expect(within(control("Step")).getByText("research")).toBeTruthy();
    expect(within(field("Labels")).getByRole("combobox").textContent).toBe("web");
    for (const label of ["Workflow", "Created", "Updated"]) {
      expect(within(field(label)).queryByRole("button")).toBeNull();
      expect(within(field(label)).queryByRole("combobox")).toBeNull();
    }
  });

  it("names each control by its row label and its own value", () => {
    renderSidebar({ fields: { priority: "high" } });

    expect(screen.getByRole("button", { name: "Status In Progress" })).toBe(control("Status"));
    expect(screen.getByRole("button", { name: "Priority high" })).toBe(control("Priority"));
  });

  it("labels an empty value None, in dim, inside the control", () => {
    renderSidebar();

    const none = within(control("Priority")).getByText("None");
    expect(none.className).toBe("text-dim");
    expect(screen.getByRole("button", { name: "Priority None" })).toBe(control("Priority"));
  });

  it("offers the project's priorities with None, and the statuses without it", async () => {
    const user = userEvent.setup();
    renderSidebar({ fields: { priority: "high" } });

    await user.click(control("Priority"));
    const priorities = await screen.findByRole("menu", { name: "Priority" });
    expect(within(priorities).getAllByRole("menuitemradio").map((item) => item.textContent))
      .toEqual([...PRIORITIES, "None"]);

    await user.keyboard("{Escape}");
    await user.click(control("Status"));
    const statuses = await screen.findByRole("menu", { name: "Status" });
    expect(within(statuses).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(STATUSES);
  });

  it("shows the wait of each row in that row's own label", () => {
    renderSidebar({ fields: { priority: "high" }, status: { busy: true } });

    expect(control("Status").textContent).toBe("In Progress…");
    expect(control("Priority").textContent).toBe("high");
  });
});

describe("the Step row", () => {
  it("wraps the owner's dot and the name, and keeps the track outside the control", () => {
    renderSidebar({ fields: { workflow: "dev", step: "research" } });

    const trigger = control("Step");
    expect(trigger.textContent).toBe("research, step 1 of 2, an agent's step");
    expect(trigger.querySelector("i")).toBeNull();
    expect(field("Step").querySelectorAll("i")).toHaveLength(2);
  });

  const DIM: { case: string; fields: Partial<Frontmatter> }[] = [
    { case: "a stale step", fields: { workflow: "gone", step: "review" } },
    { case: "the step of a task in a final status", fields: { status: "Done", workflow: "dev", step: "review" } },
  ];

  it.each(DIM)("shows $case as its name in dim inside the control, with no dot and no track", ({ fields }) => {
    renderSidebar({ fields });

    const trigger = control("Step");
    expect(trigger.children).toHaveLength(1);
    expect(trigger.firstElementChild?.textContent).toBe("review");
    expect(trigger.firstElementChild?.className).toBe("font-mono text-xs text-dim");
    expect(field("Step").querySelector("i")).toBeNull();
  });

  it("stays plain text while the page knows no step to offer and the task holds none", () => {
    renderSidebar({ step: null });

    expect(within(field("Step")).queryByRole("button")).toBeNull();
    expect(field("Step").textContent).toBe("None");
  });

  it("offers None alone for a stored step whose workflow the page cannot read", async () => {
    const user = userEvent.setup();
    renderSidebar({ fields: { workflow: "gone", step: "review" }, step: row([]) });

    await user.click(control("Step"));
    const menu = await screen.findByRole("menu", { name: "Step" });

    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["None"]);
  });
});

describe("a control that leaves the page", () => {
  // The aside is focusable whether or not it scrolls, so focus never falls to <body>.
  it("moves focus to the sidebar when the control held it", async () => {
    const { rerender } = renderSidebar({ fields: { workflow: "dev", step: "research" } });

    control("Step").focus();
    rerender({ step: null });

    await waitFor(() => {
      expect(document.activeElement).toBe(sidebar());
    });
  });

  // The focused item renders through a portal, and Base UI would return that
  // focus to a trigger that is no longer there.
  it("moves focus to the sidebar when the control's own open menu held it", async () => {
    const user = userEvent.setup();
    const { rerender } = renderSidebar({ fields: { workflow: "dev", step: "research" } });

    control("Step").focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu", { name: "Step" });
    await waitFor(() => {
      expect(menu.contains(document.activeElement)).toBe(true);
    });

    rerender({ step: null });

    await waitFor(() => {
      expect(document.activeElement).toBe(sidebar());
    });
  });

  it("leaves focus alone when the control was not holding it", async () => {
    const { rerender } = renderSidebar({ fields: { workflow: "dev", step: "research" } });

    control("Status").focus();
    rerender({ step: null });

    await waitFor(() => {
      expect(document.activeElement).toBe(control("Status"));
    });
  });
});

describe("the Labels row", () => {
  function labels(): HTMLElement {
    return within(field("Labels")).getByRole("combobox");
  }

  // The separators are the ones a screen reader hears between the labels; the
  // rows would run together without them.
  it("is named by the row and the labels, with a separator between them", () => {
    renderSidebar({ fields: { labels: ["web", "sidebar"] } });

    expect(screen.getByRole("combobox", { name: "Labels web, sidebar" })).toBe(labels());
    expect(within(labels()).queryByRole("list")).toBeNull();
  });

  it("reads None, in dim, inside the control when the task carries no label", () => {
    renderSidebar();

    expect(screen.getByRole("combobox", { name: "Labels None" })).toBe(labels());
    expect(within(labels()).getByText("None").className).toBe("text-dim");
  });

  it("shows the wait after the labels, in its own name", () => {
    renderSidebar({ fields: { labels: ["web"] }, labels: { busy: true } });

    expect(labels().textContent).toBe("web…");
    expect(screen.getByRole("combobox", { name: "Labels web…" })).toBe(labels());
    expect(labels().hasAttribute("disabled")).toBe(false);
  });
});

describe("the relation rows", () => {
  function pencil(label: string): HTMLElement {
    return within(field(label)).getByRole("combobox");
  }

  it("carries a pencil named by Edit and the row", () => {
    renderSidebar();

    expect(screen.getByRole("combobox", { name: "Edit Blocked by" })).toBe(pencil("Blocked by"));
    expect(screen.getByRole("combobox", { name: "Edit Parent" })).toBe(pencil("Parent"));
  });

  // The reveal on hover and focus is a CSS rule; what jsdom can hold is that the
  // pencil is in the tab order and named whatever the pointer does.
  it("keeps each pencil in the tab order at all times", () => {
    renderSidebar();

    for (const label of ["Blocked by", "Parent"]) {
      expect(pencil(label).tabIndex).toBe(0);
      expect(pencil(label).classList.contains("opacity-0")).toBe(true);
      expect(pencil(label).classList.contains("group-focus-within:opacity-100")).toBe(true);
      expect(pencil(label).classList.contains("data-[popup-open]:opacity-100")).toBe(true);
      expect(field(label).classList.contains("group")).toBe(true);
    }
  });

  it("puts the pencil before the relation list in the DOM and after it on screen", () => {
    renderSidebar({ fields: { blocked_by: ["SAGA-8"], parent: "SAGA-9" } });

    for (const label of ["Blocked by", "Parent"]) {
      expect(field(label).firstElementChild).toBe(pencil(label));
      expect(pencil(label).classList.contains("order-last")).toBe(true);
      expect(field(label).lastElementChild?.textContent).toContain("[Not found]");
    }
  });
});
