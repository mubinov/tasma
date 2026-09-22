import { Dialog } from "@base-ui/react/dialog";
import type { TaskEntry } from "@tasma/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELD_TRIGGER_CLASS, PROPERTY_BUTTON_CLASS, type PropertyLook } from "../../src/components/control-classes";
import { LabelPicker } from "../../src/components/label-picker";
import { frontmatter } from "../task-screen-fixtures";

const LABEL_ID = "labels-label";

function entry(id: string, labels: string[]): TaskEntry {
  return { id, path: `/tasks/${id}.md`, blocked: false, frontmatter: frontmatter({ id, labels }) };
}

const ENTRIES = [entry("P-1", ["web", "infra"]), entry("P-2", ["Web"]), entry("P-4", ["api"])];

type HarnessProps = {
  entries?: readonly TaskEntry[];
  initial?: readonly string[];
  picks: (readonly string[])[];
  look?: PropertyLook;
};

/** The page's part: the labels a pick sends become the task's labels at once, as the overlay makes them. */
function Harness({ entries = ENTRIES, initial = [], picks, look }: HarnessProps): ReactNode {
  const [labels, setLabels] = useState(initial);

  return (
    <dl>
      <dt id={LABEL_ID}>Labels</dt>
      <dd>
        <LabelPicker
          labelId={LABEL_ID}
          entries={entries}
          labels={labels}
          look={look}
          row={{
            busy: false,
            onPick: (next) => {
              picks.push(next);
              setLabels(next);
            },
          }}
        />
      </dd>
    </dl>
  );
}

function renderPicker(props: Omit<HarnessProps, "picks"> = {}) {
  const picks: (readonly string[])[] = [];
  const result = render(<Harness {...props} picks={picks} />);

  return {
    picks,
    rerender: (next: Omit<HarnessProps, "picks">) => {
      result.rerender(<Harness {...props} {...next} picks={picks} />);
    },
  };
}

function trigger(): HTMLElement {
  return screen.getByRole("combobox", { name: /^Labels/ });
}

function input(): HTMLElement {
  return screen.getByPlaceholderText("Filter or add a label");
}

async function open(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(trigger());
  return screen.findByRole("listbox", { name: "Labels" });
}

/** Each option as its text, its count and whether it is checked. */
function options(): [string, string | null, boolean][] {
  return screen.queryAllByRole("option").map((option) => {
    const count = option.querySelector(".ml-auto")?.textContent ?? null;
    const text = [...option.querySelectorAll("span")].find((span) => span.className.includes("wrap-anywhere"));

    return [text?.textContent ?? "", count, option.getAttribute("aria-selected") === "true"];
  });
}

function status(): string {
  // Base UI appends a word joiner to the text it mounts with, so the first text is announced too.
  return screen.getByRole("status").textContent.replace("\u2060", "");
}

function described(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => document.getElementById(id)?.textContent ?? `missing ${id}`);
}

afterEach(() => {
  cleanup();
});

describe("the items", () => {
  it("lists every label of the project once, folded without case, with its count, in order", async () => {
    const user = userEvent.setup();
    renderPicker({ initial: ["web"] });

    await open(user);

    expect(options()).toEqual([["api", "1", false], ["infra", "1", false], ["web", "2", true]]);
  });

  it("names the popup, the filter field and the list by the row", async () => {
    const user = userEvent.setup();
    renderPicker();

    const listbox = await open(user);

    expect(listbox).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Labels" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Labels" })).toBe(input());
  });

  // A 0 would state that no task carries a label this very task carries.
  it("lists a label of the task the listing has not counted, checked and with no count", async () => {
    const user = userEvent.setup();
    renderPicker({ initial: ["docs"] });

    await open(user);

    expect(options()).toEqual([["api", "1", false], ["docs", null, true], ["infra", "1", false], ["web", "2", false]]);
  });

  it("filters the labels by the text typed, without case", async () => {
    const user = userEvent.setup();
    renderPicker();
    await open(user);

    await user.type(input(), "FR");

    expect(options()).toEqual([["infra", "1", false], ['Add "FR"', null, false]]);
  });

  it("says how many labels match while no Add row is offered", async () => {
    const user = userEvent.setup();
    renderPicker();
    await open(user);
    expect(status()).toBe("3 labels");

    await user.type(input(), "api");

    expect(status()).toBe("1 label");
  });

  it("says the project has no labels", async () => {
    const user = userEvent.setup();
    renderPicker({ entries: [entry("P-1", [])] });

    await open(user);

    expect(options()).toEqual([]);
    expect(screen.getByText("No labels in this project", { ignore: "[role=status]" })).toBeTruthy();
    expect(status()).toBe("No labels in this project");
  });

  // "-" breaks the form rule, so no Add row stands in the list either.
  it("says no label matches the text typed", async () => {
    const user = userEvent.setup();
    renderPicker();
    await open(user);

    await user.type(input(), "-");

    expect(options()).toEqual([]);
    expect(screen.getByText("No label matches", { ignore: "[role=status]" })).toBeTruthy();
  });
});

describe("the Add row", () => {
  it("is offered for a name that matches no label, with no empty line beside it", async () => {
    const user = userEvent.setup();
    renderPicker();
    await open(user);

    await user.type(input(), "backend");

    expect(screen.getByRole("option", { name: 'Add "backend"' })).toBeTruthy();
    expect(screen.queryByText("No label matches")).toBeNull();
    expect(status()).toBe('Add "backend"');
  });

  it("is not offered for a name that matches a label in another case", async () => {
    const user = userEvent.setup();
    renderPicker();
    await open(user);

    await user.type(input(), "WEB");

    expect(options()).toEqual([["web", "2", false]]);
    expect(screen.queryByRole("option", { name: /^Add/ })).toBeNull();
  });

  it("is not offered for a name that breaks the form rule", async () => {
    const user = userEvent.setup();
    renderPicker();
    await open(user);

    await user.type(input(), "customer request");

    expect(screen.queryByRole("option", { name: /^Add/ })).toBeNull();
    expect(screen.getByText("No label matches", { ignore: "[role=status]" })).toBeTruthy();
  });

  it("sends the name as typed, after the labels of the task", async () => {
    const user = userEvent.setup();
    const { picks } = renderPicker({ initial: ["web"] });
    await open(user);

    await user.type(input(), "Backend");
    await user.click(screen.getByRole("option", { name: 'Add "Backend"' }));

    expect(picks).toEqual([["web", "Backend"]]);
  });

  it.each([
    { path: "the row", take: async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole("option", { name: 'Add "docs"' }));
    } },
    { path: "Enter", take: async (user: ReturnType<typeof userEvent.setup>) => {
      await user.keyboard("{Enter}");
    } },
  ])("taken by $path, clears the query, keeps focus and says the label was added", async ({ take }) => {
    const user = userEvent.setup();
    const { picks } = renderPicker({ initial: ["web"] });
    await open(user);
    await user.type(input(), "docs");

    await take(user);

    expect(picks).toEqual([["web", "docs"]]);
    await waitFor(() => {
      expect(input()).toHaveProperty("value", "");
    });
    expect(document.activeElement).toBe(input());
    expect(status()).toBe('Added "docs"');
    // The row stands checked in its sorted place: a held list that did not
    // take the task's own labels would announce an add over no such row.
    expect(options()).toEqual([
      ["api", "1", false],
      ["docs", null, true],
      ["infra", "1", false],
      ["web", "2", true],
    ]);
  });

  it("gives a row to a label the listing counted after the popup opened, once it is added", async () => {
    const user = userEvent.setup();
    const { picks, rerender } = renderPicker();
    await open(user);
    rerender({ entries: [...ENTRIES, entry("P-5", ["zeta"])] });
    await user.type(input(), "zeta");

    await user.click(screen.getByRole("option", { name: 'Add "zeta"' }));

    expect(picks).toEqual([["zeta"]]);
    expect(status()).toBe('Added "zeta"');
    expect(options()).toEqual([
      ["api", "1", false],
      ["infra", "1", false],
      ["web", "2", false],
      ["zeta", null, true],
    ]);
  });

  it("says nothing of the add after the next keystroke", async () => {
    const user = userEvent.setup();
    renderPicker();
    await open(user);
    await user.type(input(), "docs");
    await user.keyboard("{Enter}");

    await user.type(input(), "a");

    expect(status()).toBe('Add "a"');
  });

  it("says nothing of the add once the popup opens again", async () => {
    const user = userEvent.setup();
    renderPicker();
    await open(user);
    await user.type(input(), "docs");
    await user.keyboard("{Enter}");

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
    await open(user);

    expect(status()).toBe("4 labels");
  });
});

describe("Enter", () => {
  it("toggles the highlighted row rather than adding the text", async () => {
    const user = userEvent.setup();
    const { picks } = renderPicker();
    await open(user);
    await user.type(input(), "fr");

    await user.keyboard("{ArrowDown}{Enter}");

    expect(picks).toEqual([["infra"]]);
  });

  it("closes the popup and adds nothing while the text is no new label", async () => {
    const user = userEvent.setup();
    const { picks } = renderPicker();
    await open(user);
    await user.type(input(), "web");

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
    expect(picks).toEqual([]);
  });

  it("adds nothing while an input method is composing the text", async () => {
    const user = userEvent.setup();
    const { picks } = renderPicker();
    await open(user);
    await user.type(input(), "docs");

    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });

    expect(picks).toEqual([]);
  });
});

describe("a name that breaks the form rule", () => {
  it("marks the search row and the input not valid, and ties the correction and the hint to the input", async () => {
    const user = userEvent.setup();
    const { picks } = renderPicker();
    await open(user);

    await user.type(input(), "a_");

    const correction = 'A label cannot carry "_". Use lower-case letters, digits and dashes.';
    expect(input().parentElement?.hasAttribute("data-invalid")).toBe(true);
    expect(input().parentElement?.className).toContain("data-invalid:border-signal");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(described(input())).toEqual(["Type a name that does not exist to add it.", correction]);
    expect(status()).toBe(correction);

    await user.keyboard("{Enter}");
    expect(picks).toEqual([]);
  });

  it("is cleared by the keystroke that repairs the name", async () => {
    const user = userEvent.setup();
    renderPicker();
    await open(user);
    await user.type(input(), "a_");

    await user.keyboard("{Backspace}");

    expect(input().parentElement?.hasAttribute("data-invalid")).toBe(false);
    expect(input().hasAttribute("aria-invalid")).toBe(false);
    expect(described(input())).toEqual(["Type a name that does not exist to add it."]);
    expect(screen.queryByText(/A label cannot/)).toBeNull();
    expect(status()).toBe('Add "a"');
  });
});

describe("a stored label of a form the daemon refuses", () => {
  const STORED = ["web", "customer request"];

  function renderStored() {
    return renderPicker({ entries: [...ENTRIES, entry("P-5", ["customer request", "a_b"])], initial: STORED });
  }

  it("is shown checked and not interactive, and a line tied to the filter field names it", async () => {
    const user = userEvent.setup();
    const { picks } = renderStored();
    await open(user);

    const row = screen.getByRole("option", { name: /customer request/ });
    expect(row.textContent).toBe("[Not valid]customer request");
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    const line = '"customer request" is not a valid label. Changing this list removes it.';
    expect(screen.getByText(/is not a valid label/).textContent).toBe(line);
    expect(described(input())).toEqual(["Type a name that does not exist to add it.", line]);

    await user.click(row);
    expect(picks).toEqual([]);
  });

  it("is not offered when the task does not carry it", async () => {
    const user = userEvent.setup();
    renderStored();
    await open(user);

    expect(screen.queryByRole("option", { name: /a_b/ })).toBeNull();
  });

  it("is left out of the list a check sends, and keeps its row and the line until the popup closes", async () => {
    const user = userEvent.setup();
    const { picks } = renderStored();
    await open(user);

    await user.click(screen.getByRole("option", { name: /infra/ }));

    expect(picks).toEqual([["web", "infra"]]);
    expect(screen.getByRole("option", { name: /customer request/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(/is not a valid label/)).toBeTruthy();
  });

  it.each([
    { path: "the row", take: async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole("option", { name: 'Add "docs"' }));
    } },
    { path: "Enter", take: async (user: ReturnType<typeof userEvent.setup>) => {
      await user.keyboard("{Enter}");
    } },
  ])("is left out of the list an add by $path sends", async ({ take }) => {
    const user = userEvent.setup();
    const { picks } = renderStored();
    await open(user);
    await user.type(input(), "docs");

    await take(user);

    expect(picks).toEqual([["web", "docs"]]);
  });

  it("names every stored label of that form", async () => {
    const user = userEvent.setup();
    renderPicker({ initial: ["x y", "a_b", "c:d"] });

    await open(user);

    expect(screen.getByText(/are not valid labels/).textContent)
      .toBe('"a_b", "c:d" and "x y" are not valid labels. Changing this list removes them.');
  });
});

describe("a check", () => {
  it("adds the item's own spelling to the labels of the task", async () => {
    const user = userEvent.setup();
    const { picks } = renderPicker({ initial: ["api"] });
    await open(user);

    await user.click(screen.getByRole("option", { name: /web/ }));

    expect(picks).toEqual([["api", "web"]]);
  });

  it("removes every label of the task equal to the item without case", async () => {
    const user = userEvent.setup();
    const { picks } = renderPicker({ initial: ["web", "api", "Web"] });
    await open(user);

    await user.click(screen.getByRole("option", { name: /web/ }));

    expect(picks).toEqual([["api"]]);
  });

  it("sends an empty list when the last label is unchecked", async () => {
    const user = userEvent.setup();
    const { picks } = renderPicker({ initial: ["api"] });
    await open(user);

    await user.click(screen.getByRole("option", { name: /api/ }));

    expect(picks).toEqual([[]]);
  });

  // Frozen, the row stays with its check cleared, and a second click puts the label back.
  it("leaves the row of a label whose last carrier was unchecked in place", async () => {
    const user = userEvent.setup();
    const { picks, rerender } = renderPicker({ entries: [entry("P-3", ["docs"])], initial: ["docs"] });
    await open(user);

    await user.click(screen.getByRole("option", { name: /docs/ }));
    rerender({ entries: [entry("P-3", [])] });

    expect(options()).toEqual([["docs", "1", false]]);
    await user.click(screen.getByRole("option", { name: /docs/ }));
    expect(picks).toEqual([[], ["docs"]]);
  });

  it("keeps the rows of a listing that changes while the popup is open, and takes the new one on reopen", async () => {
    const user = userEvent.setup();
    const { rerender } = renderPicker();
    await open(user);

    rerender({ entries: [entry("P-1", ["zeta"])] });

    expect(options().map(([label]) => label)).toEqual(["api", "infra", "web"]);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
    await open(user);
    expect(options()).toEqual([["zeta", "1", false]]);
  });
});

describe("the look", () => {
  it("keeps the property button class and no caret by default", () => {
    renderPicker();

    expect(trigger().className).toBe(PROPERTY_BUTTON_CLASS);
    expect(trigger().querySelector("svg")).toBeNull();
  });

  it("takes the field class for a form row, and ends with a caret after its value", () => {
    renderPicker({ look: "field", initial: ["web"] });

    expect(trigger().className).toBe(FIELD_TRIGGER_CLASS);
    const caret = trigger().lastElementChild;
    expect(caret?.tagName.toLowerCase()).toBe("svg");
    expect(caret?.getAttribute("aria-hidden")).toBe("true");
    expect(trigger().textContent).toBe("web");
  });
});

describe("Escape in a list with no row", () => {
  function renderInDialog(entries: readonly TaskEntry[]) {
    const onOpenChange = vi.fn();
    render(
      <Dialog.Root open onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Popup>
            <Dialog.Title>Parent</Dialog.Title>
            <Harness entries={entries} picks={[]} />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>,
    );

    return onOpenChange;
  }

  it("closes the picker alone when no label matches the text typed", async () => {
    const user = userEvent.setup();
    const onOpenChange = renderInDialog(ENTRIES);
    await open(user);
    await user.type(input(), "-");

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes the picker alone when the project has no labels", async () => {
    const user = userEvent.setup();
    const onOpenChange = renderInDialog([entry("P-1", [])]);
    await open(user);
    await waitFor(() => {
      expect(document.activeElement).toBe(input());
    });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("speaks the empty text through the one status region, and leaves the empty part silent", async () => {
    const user = userEvent.setup();
    renderPicker({ entries: [entry("P-1", [])] });
    await open(user);

    const live = [...document.querySelectorAll('[role="status"], [aria-live="polite"], [aria-live="assertive"]')];
    expect(live.filter((region) => region.textContent.includes("No labels in this project"))).toHaveLength(1);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(document.querySelector('[role="presentation"][aria-live="off"]')?.textContent).toBe("");
  });
});
