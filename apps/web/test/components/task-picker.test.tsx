import type { TaskEntry } from "@tasma/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { TaskPicker } from "../../src/components/task-picker";
import { entry } from "../task-screen-fixtures";

const ENTRIES = [
  entry("P-99", "Backlog", "Draft the parser"),
  entry("T-4", "In Progress", "This task"),
  entry("P-100", "Done", "Export the ledger as CSV"),
  entry("P-7", "Backlog", "Plan the release"),
];

type Pick = readonly string[] | string | null;

type RenderProps = { entries?: readonly TaskEntry[] } & (
  | { multiple: true; initial: readonly string[] }
  | { multiple: false; initial: string | undefined }
);

type HarnessProps = RenderProps & { picks: Pick[] };

/** The page's part: a pick becomes the task's value at once, as the overlay makes it. */
function Harness(props: HarnessProps): ReactNode {
  const { entries = ENTRIES, picks } = props;
  const [list, setList] = useState(props.multiple ? props.initial : []);
  const [single, setSingle] = useState(props.multiple ? undefined : props.initial);
  const label = props.multiple ? "Blocked by" : "Parent";

  return (
    <dl>
      <dt id="row-label">{label}</dt>
      <dd>
        {props.multiple
          ? (
              <TaskPicker
                multiple
                labelId="row-label"
                className="pencil"
                entries={entries}
                id="T-4"
                value={list}
                row={{
                  busy: false,
                  onPick: (next) => {
                    picks.push(next);
                    setList(next);
                  },
                }}
              />
            )
          : (
              <TaskPicker
                multiple={false}
                labelId="row-label"
                className="pencil"
                entries={entries}
                id="T-4"
                value={single}
                row={{
                  busy: false,
                  onPick: (next) => {
                    picks.push(next);
                    setSingle(next ?? undefined);
                  },
                }}
              />
            )}
      </dd>
    </dl>
  );
}

function renderPicker(props: RenderProps) {
  const picks: Pick[] = [];
  const result = render(<Harness {...props} picks={picks} />);

  return {
    picks,
    rerender: (entries: readonly TaskEntry[]) => {
      result.rerender(<Harness {...props} entries={entries} picks={picks} />);
    },
  };
}

function blockers(initial: readonly string[] = [], entries?: readonly TaskEntry[]) {
  return renderPicker({ multiple: true, initial, entries });
}

function parent(initial?: string, entries?: readonly TaskEntry[]) {
  return renderPicker({ multiple: false, initial, entries });
}

function input(): HTMLElement {
  return screen.getByPlaceholderText("Filter tasks");
}

async function open(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("combobox", { name: /^Edit/ }));
  return screen.findByRole("listbox");
}

/** Each option as its text and whether it is checked. */
function options(): [string, boolean][] {
  return screen.queryAllByRole("option").map((option) => [
    option.textContent,
    option.getAttribute("aria-selected") === "true",
  ]);
}

function status(): string {
  // Base UI appends a word joiner to the text it mounts with, so the first text is announced too.
  return screen.getByRole("status").textContent.replace("\u2060", "");
}

/** The rule before None: presentational, so it is no item of the list. */
function separator(): Element | null {
  return screen.getByRole("listbox").querySelector("[role=presentation]");
}

async function closed(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull();
  });
}

afterEach(() => {
  cleanup();
});

describe("the trigger", () => {
  it("is a pencil named by Edit and the row", () => {
    blockers();

    const pencil = screen.getByRole("combobox", { name: "Edit Blocked by" });
    expect(pencil.className).toBe("pencil");
    expect(pencil.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("names the popup, the filter field and the list by the row", async () => {
    const user = userEvent.setup();
    blockers();

    await open(user);

    expect(screen.getByRole("dialog", { name: "Blocked by" })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "Blocked by" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Blocked by" })).toBe(input());
  });
});

describe("the items", () => {
  it("lists every task of the project but this one, a closed one too, the newest id first", async () => {
    const user = userEvent.setup();
    blockers(["P-7"]);

    await open(user);

    expect(options()).toEqual([
      ["P-100 [Done]Export the ledger as CSV", false],
      ["P-99 [Backlog]Draft the parser", false],
      ["P-7 [Backlog]Plan the release", true],
    ]);
    expect(status()).toBe("3 tasks");
  });

  it.each([
    { query: "9", ids: ["P-99"] },
    { query: "p-1", ids: ["P-100"] },
    { query: "LEDGER", ids: ["P-100"] },
  ])("filters on the id and the title, without case: $query", async ({ query, ids }) => {
    const user = userEvent.setup();
    blockers();
    await open(user);

    await user.type(input(), query);

    expect(options().map(([text]) => text.split(" ")[0])).toEqual(ids);
    expect(status()).toBe("1 task");
  });

  it("says no task matches the text typed", async () => {
    const user = userEvent.setup();
    blockers();
    await open(user);

    await user.type(input(), "zzz");

    expect(options()).toEqual([]);
    expect(screen.getByText("No task matches", { ignore: "[role=status]" })).toBeTruthy();
    expect(status()).toBe("No task matches");
  });

  it("says the project holds no other task", async () => {
    const user = userEvent.setup();
    blockers([], [entry("T-4", "Backlog", "This task")]);

    await open(user);

    expect(options()).toEqual([]);
    expect(screen.getByText("No tasks in this project", { ignore: "[role=status]" })).toBeTruthy();
  });

  it("keeps the rows of a listing that changes while the popup is open, and takes the new one on reopen", async () => {
    const user = userEvent.setup();
    const { rerender } = blockers();
    await open(user);

    rerender([entry("P-200", "Backlog", "Arrived later"), ...ENTRIES]);

    expect(options().map(([text]) => text.split(" ")[0])).toEqual(["P-100", "P-99", "P-7"]);
    await user.keyboard("{Escape}");
    await closed();
    await open(user);
    expect(options().map(([text]) => text.split(" ")[0])).toEqual(["P-200", "P-100", "P-99", "P-7"]);
  });
});

describe("Blocked by", () => {
  it("keeps the popup open across the picks, each one sending the whole list", async () => {
    const user = userEvent.setup();
    const { picks } = blockers(["P-7"]);
    const listbox = await open(user);

    await user.click(within(listbox).getByRole("option", { name: /P-99/ }));
    await user.click(within(listbox).getByRole("option", { name: /P-7/ }));

    expect(picks).toEqual([["P-7", "P-99"], ["P-99"]]);
    expect(screen.getByRole("listbox")).toBe(listbox);
  });

  it("removes every copy of an id stored more than once", async () => {
    const user = userEvent.setup();
    const { picks } = blockers(["P-7", "P-99", "P-7"]);
    const listbox = await open(user);

    await user.click(within(listbox).getByRole("option", { name: /P-7/ }));

    expect(picks).toEqual([["P-99"]]);
  });

  it("shows an id that names no task checked and not interactive, names it, and leaves it out of the next write", async () => {
    const user = userEvent.setup();
    const { picks } = blockers(["P-9", "P-7"]);
    const listbox = await open(user);

    const missing = within(listbox).getByRole("option", { name: "[Not found] P-9" });
    expect(missing.getAttribute("aria-selected")).toBe("true");
    expect(missing.getAttribute("aria-disabled")).toBe("true");
    const line = screen.getByText(/names no task/);
    expect(line.textContent).toBe("P-9 names no task. Changing this list removes it.");
    expect(input().getAttribute("aria-describedby")).toBe(line.id);

    await user.click(missing);
    expect(picks).toEqual([]);

    await user.click(within(listbox).getByRole("option", { name: /P-99/ }));
    expect(picks).toEqual([["P-7", "P-99"]]);
    // The file no longer holds it; the row stays, still checked, until the popup closes.
    expect(within(listbox).getByRole("option", { name: "[Not found] P-9" }).getAttribute("aria-selected"))
      .toBe("true");

    await user.keyboard("{Escape}");
    await closed();
    await open(user);
    expect(screen.queryByRole("option", { name: /Not found/ })).toBeNull();
    expect(screen.queryByText(/names no task/)).toBeNull();
    expect(input().hasAttribute("aria-describedby")).toBe(false);
  });

  it("names every id that names no task", async () => {
    const user = userEvent.setup();
    blockers(["P-9", "P-12", "P-13"]);

    await open(user);

    expect(screen.getByText(/name no task/).textContent)
      .toBe("P-9, P-12 and P-13 name no task. Changing this list removes them.");
  });

  it("shows this task's own id checked and not interactive, names it, and leaves it out of the next write", async () => {
    const user = userEvent.setup();
    const { picks } = blockers(["T-4", "P-7"]);
    const listbox = await open(user);

    const self = within(listbox).getByRole("option", { name: "[This task] T-4" });
    expect(self.getAttribute("aria-selected")).toBe("true");
    expect(self.getAttribute("aria-disabled")).toBe("true");
    const line = screen.getByText(/is this task/);
    expect(line.textContent).toBe("T-4 is this task. Changing this list removes it.");
    expect(input().getAttribute("aria-describedby")).toBe(line.id);

    await user.click(within(listbox).getByRole("option", { name: /P-99/ }));
    expect(picks).toEqual([["P-7", "P-99"]]);
  });

  it("names an id that names no task and this task's own id in one line", async () => {
    const user = userEvent.setup();
    blockers(["P-9", "T-4"]);

    await open(user);

    expect(screen.getByText(/is this task/).textContent)
      .toBe("P-9 names no task. T-4 is this task. Changing this list removes them.");
  });

  it("keeps a blocker whose task leaves the listing while the popup is open", async () => {
    const user = userEvent.setup();
    const { picks, rerender } = blockers(["P-7"]);
    const listbox = await open(user);

    rerender(ENTRIES.filter((task) => task.id !== "P-7"));
    await user.click(within(listbox).getByRole("option", { name: /P-99/ }));

    expect(picks).toEqual([["P-7", "P-99"]]);
    expect(screen.queryByText(/no task/)).toBeNull();
  });

  it("leaves out an id the line names although its task joins the listing while the popup is open", async () => {
    const user = userEvent.setup();
    const { picks, rerender } = blockers(["P-9"]);
    const listbox = await open(user);

    rerender([...ENTRIES, entry("P-9", "Backlog", "Arrived later")]);
    await user.click(within(listbox).getByRole("option", { name: /P-99/ }));

    expect(picks).toEqual([["P-99"]]);
    expect(screen.getByText(/names no task/)).toBeTruthy();
  });

  it("offers no None", async () => {
    const user = userEvent.setup();
    blockers();

    await open(user);

    expect(screen.queryByRole("option", { name: "None" })).toBeNull();
    expect(separator()).toBeNull();
  });
});

describe("Parent", () => {
  it("ends with a rule and None, checked while the task has no parent", async () => {
    const user = userEvent.setup();
    parent();

    await open(user);

    expect(options()).toEqual([
      ["P-100 [Done]Export the ledger as CSV", false],
      ["P-99 [Backlog]Draft the parser", false],
      ["P-7 [Backlog]Plan the release", false],
      ["None", true],
    ]);
    expect(separator()).not.toBeNull();
  });

  it("opens on None alone, with no rule, when the project holds no other task", async () => {
    const user = userEvent.setup();
    parent(undefined, [entry("T-4", "Backlog", "This task")]);

    await open(user);

    expect(options()).toEqual([["None", true]]);
    expect(separator()).toBeNull();
    expect(screen.getByText("No tasks in this project", { ignore: "[role=status]" })).toBeTruthy();
  });

  it("hides None while a filter is typed", async () => {
    const user = userEvent.setup();
    parent();
    await open(user);

    await user.type(input(), "p-7");

    expect(options().map(([text]) => text)).toEqual(["P-7 [Backlog]Plan the release"]);
  });

  it("closes on a pick and sends the id", async () => {
    const user = userEvent.setup();
    const { picks } = parent("P-7");
    await open(user);

    await user.click(screen.getByRole("option", { name: /P-99/ }));

    expect(picks).toEqual(["P-99"]);
    await closed();
  });

  it("clears the parent with None", async () => {
    const user = userEvent.setup();
    const { picks } = parent("P-7");
    await open(user);

    await user.click(screen.getByRole("option", { name: "None" }));

    expect(picks).toEqual([null]);
  });

  it("picks the highlighted task with Enter", async () => {
    const user = userEvent.setup();
    const { picks } = parent("P-7");
    await open(user);
    await user.type(input(), "p-100");

    await user.keyboard("{ArrowDown}{Enter}");

    expect(picks).toEqual(["P-100"]);
    await closed();
  });

  it("sends nothing for a letter typed on the pencil while the popup is closed", async () => {
    const user = userEvent.setup();
    const { picks } = parent("P-7");
    await open(user);
    await user.keyboard("{Escape}");
    await closed();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: /^Edit/ }));

    await user.keyboard("n");
    await user.keyboard("i");
    await user.keyboard("i");

    expect(picks).toEqual([]);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("sends nothing when the browser autofills the value", async () => {
    const { picks } = parent("P-7");
    const hidden = screen.getByRole("combobox", { name: /^Edit/ }).parentElement?.querySelector("input[aria-hidden=true]");

    fireEvent.change(hidden ?? document.body, { target: { value: "id:P-100" } });
    await Promise.resolve();

    expect(hidden).toBeInstanceOf(HTMLInputElement);
    expect(picks).toEqual([]);
  });

  it.each([
    { what: "the parent it holds", initial: "P-7", option: /P-7/ },
    { what: "None while it holds none", initial: undefined, option: "None" },
  ])("sends nothing for $what", async ({ initial, option }) => {
    const user = userEvent.setup();
    const { picks } = parent(initial);
    await open(user);

    await user.click(screen.getByRole("option", { name: option }));

    await closed();
    expect(picks).toEqual([]);
  });

  it.each([
    { what: "names no task", initial: "P-9", option: "[Not found] P-9" },
    { what: "is this task", initial: "T-4", option: "[This task] T-4" },
  ])("shows a parent that $what checked, with no line, and replaces it with a pick", async ({ initial, option }) => {
    const user = userEvent.setup();
    const { picks } = parent(initial);
    await open(user);

    expect(screen.getByRole("option", { name: option }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText(/names no task|is this task/)).toBeNull();

    await user.click(screen.getByRole("option", { name: /P-99/ }));

    expect(picks).toEqual(["P-99"]);
  });
});
