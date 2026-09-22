import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELD_TRIGGER_CLASS, PROPERTY_BUTTON_CLASS } from "../../src/components/control-classes";
import { PropertyMenu, type PropertyMenuProps } from "../../src/components/property-menu";
import type { PropertyRow } from "../../src/lib/task-properties";

const LABEL_ID = "status-row-label";

const CHOICES = ["Backlog", "In Progress", "Done"].map((value) => ({ value, label: value }));

/** The row's own fields stand beside the menu's, so a test names the one it changes. */
type RowProps = Partial<Omit<PropertyMenuProps, "row">> & Partial<PropertyRow> & { present?: boolean };

/** The control in the row it names itself by, which a test can take off the page. */
function Row(props: RowProps): ReactNode {
  const {
    present = true,
    choices = CHOICES,
    match = "without case",
    busy = false,
    onPick = () => {},
    ...menu
  } = props;

  return (
    <dl>
      <dt id={LABEL_ID}>Status</dt>
      <dd>
        {present && (
          <PropertyMenu
            labelId={LABEL_ID}
            value="In Progress"
            clearable={false}
            trigger={menu.value ?? "In Progress"}
            onFocusLost={() => {}}
            {...menu}
            row={{ choices, match, busy, onPick }}
          />
        )}
      </dd>
    </dl>
  );
}

function renderRow(props: RowProps = {}) {
  const result = render(<Row {...props} />);

  return { ...result, rerender: (next: RowProps) => result.rerender(<Row {...props} {...next} />) };
}

function trigger(): HTMLElement {
  return screen.getByRole("button");
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(trigger());

  return { user, menu: await screen.findByRole("menu") };
}

function items(menu: HTMLElement): HTMLElement[] {
  return within(menu).getAllByRole("menuitemradio");
}

function checked(menu: HTMLElement): (string | null)[] {
  return items(menu).map((item) => item.getAttribute("aria-checked"));
}

afterEach(() => {
  cleanup();
});

describe("the trigger", () => {
  it("is named by the row's label and its own value, and carries the property button class", () => {
    renderRow();

    expect(screen.getByRole("button", { name: "Status In Progress" })).toBe(trigger());
    expect(trigger().className).toBe(PROPERTY_BUTTON_CLASS);
  });

  it("takes the field class for a form row, and shows the content the caller gives it, caret included", () => {
    renderRow({
      look: "field",
      trigger: (
        <>
          <span>In Progress</span>
          <svg aria-hidden="true" data-caret="" />
        </>
      ),
    });

    expect(trigger().className).toBe(FIELD_TRIGGER_CLASS);
    expect(screen.getByRole("button", { name: "Status In Progress" })).toBe(trigger());
    expect(trigger().lastElementChild?.hasAttribute("data-caret")).toBe(true);
  });

  it("shows the wait as an ellipsis in its own name rather than as disabled", () => {
    renderRow({ busy: true, value: "Done", trigger: "Done" });

    expect(screen.getByRole("button", { name: "Status Done…" })).toBe(trigger());
    expect(trigger().hasAttribute("disabled")).toBe(false);
  });

  // `aria-busy` asks a reader to hold back the very name that carries the wait.
  it("carries no aria-busy, busy or not", () => {
    const { rerender } = renderRow();
    expect(trigger().hasAttribute("aria-busy")).toBe(false);

    rerender({ busy: true });

    expect(trigger().hasAttribute("aria-busy")).toBe(false);
  });
});

describe("the menu", () => {
  it("is named by the row's label, and lists the choices as radio items", async () => {
    renderRow();
    const { menu } = await openMenu();

    expect(screen.getByRole("menu", { name: "Status" })).toBe(menu);
    expect(items(menu).map((item) => item.textContent)).toEqual(["Backlog", "In Progress", "Done"]);
  });

  it("checks the stored value, matched without case", async () => {
    renderRow({ value: "in progress" });
    const { menu } = await openMenu();

    expect(checked(menu)).toEqual(["false", "true", "false"]);
  });

  // A step is declared by its exact name, so one differing in case is stale and
  // the item that would repair it has to stay pickable.
  it("checks nothing for a stored value matched as written that differs in case", async () => {
    renderRow({ value: "in progress", match: "exact" });
    const { menu } = await openMenu();

    expect(checked(menu)).toEqual(["false", "false", "false"]);
  });

  // The empty string there would report a state the file does not hold.
  it("checks nothing for a stored value the choices do not hold", async () => {
    renderRow({ value: "Waiting", clearable: true });
    const { menu } = await openMenu();

    expect(checked(menu)).toEqual(["false", "false", "false", "false"]);
  });

  it("ends with a separator and None when the field is clearable", async () => {
    renderRow({ clearable: true });
    const { menu } = await openMenu();

    const last = [...menu.firstElementChild!.children].slice(-2);
    expect(last[0]?.getAttribute("role")).toBe("separator");
    expect(last[1]?.textContent).toBe("None");
  });

  it("offers no None when the field is not clearable", async () => {
    renderRow();
    const { menu } = await openMenu();

    expect(within(menu).queryByRole("menuitemradio", { name: "None" })).toBeNull();
    expect(within(menu).queryByRole("separator")).toBeNull();
  });

  // A menu of None alone opens on the item, not on a rule.
  it("opens on None with no separator above it when it is the only item", async () => {
    renderRow({ choices: [], clearable: true, value: "review" });
    const { menu } = await openMenu();

    expect(items(menu).map((item) => item.textContent)).toEqual(["None"]);
    expect(within(menu).queryByRole("separator")).toBeNull();
  });

  it("checks None on an empty field", async () => {
    renderRow({ value: undefined, clearable: true, trigger: "None" });
    const { menu } = await openMenu();

    expect(checked(menu)).toEqual(["false", "false", "false", "true"]);
  });
});

describe("picking a value", () => {
  it("calls back with the value reached by arrows and Enter, and closes the menu", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    renderRow({ onPick });

    trigger().focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(menu.contains(document.activeElement)).toBe(true);
    });
    while (document.activeElement?.textContent !== "Done") {
      await user.keyboard("{ArrowDown}");
    }
    await user.keyboard("{Enter}");

    expect(onPick.mock.calls).toEqual([["Done"]]);
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  it("calls nothing for the value already checked", async () => {
    const onPick = vi.fn();
    renderRow({ onPick });
    const { user, menu } = await openMenu();

    await user.click(within(menu).getByRole("menuitemradio", { name: "In Progress" }));

    expect(onPick).not.toHaveBeenCalled();
  });

  it("calls back with null for None", async () => {
    const onPick = vi.fn();
    renderRow({ clearable: true, onPick });
    const { user, menu } = await openMenu();

    await user.click(within(menu).getByRole("menuitemradio", { name: "None" }));

    expect(onPick.mock.calls).toEqual([[null]]);
  });

  // Clearing a field that is already empty would write nothing and still move `updated`.
  it("calls nothing for None on an empty field", async () => {
    const onPick = vi.fn();
    renderRow({ value: undefined, clearable: true, trigger: "None", onPick });
    const { user, menu } = await openMenu();

    await user.click(within(menu).getByRole("menuitemradio", { name: "None" }));

    expect(onPick).not.toHaveBeenCalled();
  });

  // This is how the wait reaches a reader: the menu hands focus back to the
  // trigger, which is named by its row and by the value it is now sending.
  it("hands focus back to a trigger that names the value it sends", async () => {
    function Sending(): ReactNode {
      const [sent, setSent] = useState<string | null>(null);

      return (
        <Row
          value={sent ?? "In Progress"}
          trigger={sent ?? "In Progress"}
          busy={sent !== null}
          onPick={(next) => {
            setSent(next);
          }}
        />
      );
    }

    const user = userEvent.setup();
    render(<Sending />);
    await user.click(trigger());
    await user.click(await screen.findByRole("menuitemradio", { name: "Done" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger());
    });
    expect(screen.getByRole("button", { name: "Status Done…" })).toBe(trigger());
  });
});

describe("leaving the page", () => {
  it("reports the loss when the trigger holds focus", () => {
    const onFocusLost = vi.fn();
    const { rerender } = renderRow({ onFocusLost });

    trigger().focus();
    rerender({ present: false });

    expect(onFocusLost).toHaveBeenCalledOnce();
  });

  // A menu opened from the keyboard holds focus on an item rendered through a
  // portal, outside the trigger's subtree, and its focus manager would return
  // that focus to a trigger that is no longer there.
  it("reports the loss while its own menu holds the focus", async () => {
    const onFocusLost = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderRow({ onFocusLost });

    trigger().focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(menu.contains(document.activeElement)).toBe(true);
    });
    expect(trigger().contains(document.activeElement)).toBe(false);

    rerender({ present: false });

    expect(onFocusLost).toHaveBeenCalledOnce();
  });

  it("reports nothing while the control stays on the page", () => {
    const onFocusLost = vi.fn();
    const { rerender } = renderRow({ onFocusLost });

    trigger().focus();
    rerender({ busy: true });

    expect(onFocusLost).not.toHaveBeenCalled();
  });

  // The open state is read at cleanup time: in the dependency list it would run
  // the cleanup on every open and close and drag focus away after each pick.
  it("reports nothing on an ordinary pick", async () => {
    const onFocusLost = vi.fn();
    renderRow({ onFocusLost });
    const { user, menu } = await openMenu();

    await user.click(within(menu).getByRole("menuitemradio", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });

    expect(onFocusLost).not.toHaveBeenCalled();
  });

  it("reports nothing when the trigger leaves with focus elsewhere", () => {
    const onFocusLost = vi.fn();
    const { rerender } = renderRow({ onFocusLost });

    document.body.focus();
    rerender({ present: false });

    expect(onFocusLost).not.toHaveBeenCalled();
  });
});
