import type { Frontmatter } from "@tasma/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { TaskSidebar } from "../../src/components/task-sidebar";
import { isFinalStatus, stepView } from "../../src/lib/board";
import { relationRows } from "../../src/lib/task-page";
import { stepChoices, type PropertyChoice, type PropertyRow } from "../../src/lib/task-properties";
import type { TaskProperties } from "../../src/lib/use-task-properties";
import { WORKFLOW, field, frontmatter, sidebar } from "../task-screen-fixtures";

const STATUSES = ["Backlog", "In Progress", "Done"];

const PRIORITIES = ["high", "medium", "low"];

function row(names: readonly string[], extra: Partial<PropertyRow> = {}): PropertyRow {
  const choices: PropertyChoice[] = names.map((value) => ({ value, label: value }));

  return { choices, match: "without case", busy: false, onPick: () => {}, ...extra };
}

type SidebarProps = {
  fields?: Partial<Frontmatter>;
  /** `undefined` leaves the Step row a control over the workflow's steps. */
  step?: PropertyRow | null;
  status?: Partial<PropertyRow>;
  priority?: Partial<PropertyRow>;
};

function Sidebar({ fields = {}, step, status = {}, priority = {} }: SidebarProps): ReactNode {
  const values = frontmatter(fields);
  const view = stepView(values, isFinalStatus(values.status, ["Done"]), WORKFLOW);
  const properties: TaskProperties = {
    frontmatter: values,
    status: row(STATUSES, status),
    priority: row(PRIORITIES, priority),
    step: step === undefined
      ? row(stepChoices(WORKFLOW).map((choice) => choice.value), { match: "exact" })
      : step,
  };

  return (
    <TaskSidebar
      tag="SAGA"
      view={view}
      relations={relationRows(values, [], ["Done"])}
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
  it("makes Status, Priority and Step controls and leaves every other row text", () => {
    renderSidebar({ fields: { priority: "high", labels: ["web"], workflow: "dev", step: "research" } });

    expect(control("Status").textContent).toBe("In Progress");
    expect(control("Priority").textContent).toBe("high");
    expect(within(control("Step")).getByText("research")).toBeTruthy();
    for (const label of ["Labels", "Workflow", "Blocked by", "Parent", "Created", "Updated"]) {
      expect(within(field(label)).queryByRole("button")).toBeNull();
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
