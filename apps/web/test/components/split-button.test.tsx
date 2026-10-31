import { Menu } from "@base-ui/react/menu";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MENU_ITEM_CLASS, POPUP_CLASS } from "../../src/components/control-classes";
import * as SplitButton from "../../src/components/split-button";
import { Tooltip } from "../../src/components/tooltip";
import { ChatCircleIcon } from "../../src/lib/icons";

type User = ReturnType<typeof userEvent.setup>;

type ControlProps = {
  present?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onAction?: () => void;
  onArchive?: () => void;
  onFocusLost?: () => void;
};

/** The control between two buttons, which a test can take off the page. */
function Control(props: ControlProps): ReactNode {
  const { present = true, busy = false, disabled = false, onAction, onArchive, onFocusLost } = props;

  return (
    <>
      <button type="button">Before</button>
      {present && (
        <SplitButton.Root>
          <SplitButton.Action
            icon={<ChatCircleIcon size={14} aria-hidden="true" />}
            busy={busy}
            disabled={disabled}
            onClick={onAction}
          >
            Open draft
          </SplitButton.Action>
          <SplitButton.Menu label="More draft actions" busy={busy} disabled={disabled} onFocusLost={onFocusLost}>
            <Menu.Item onClick={onArchive} className={MENU_ITEM_CLASS}>Archive draft</Menu.Item>
            <Menu.Item className={MENU_ITEM_CLASS}>Copy link</Menu.Item>
            <Menu.Item className={MENU_ITEM_CLASS}>Delete draft</Menu.Item>
          </SplitButton.Menu>
        </SplitButton.Root>
      )}
      <button type="button">After</button>
    </>
  );
}

function renderControl(props: ControlProps = {}) {
  const result = render(<Control {...props} />);

  return { ...result, rerender: (next: ControlProps) => result.rerender(<Control {...props} {...next} />) };
}

/** Archive draft makes the control busy, as a caller does while its write runs. */
function BusyOnArchive(): ReactNode {
  const [busy, setBusy] = useState(false);

  return (
    <Control
      busy={busy}
      onArchive={() => {
        setBusy(true);
      }}
    />
  );
}

function action(): HTMLElement {
  return screen.getByRole("button", { name: "Open draft" });
}

function menuPart(): HTMLElement {
  return screen.getByRole("button", { name: "More draft actions" });
}

function items(menu: HTMLElement): HTMLElement[] {
  return within(menu).getAllByRole("menuitem");
}

function highlighted(menu: HTMLElement): string[] {
  return items(menu).filter((item) => item.hasAttribute("data-highlighted")).map((item) => item.textContent);
}

function spinning(button: HTMLElement): boolean {
  return button.querySelector("svg")!.classList.contains("animate-spin");
}

function focusOn(element: HTMLElement): void {
  act(() => {
    element.focus();
  });
}

afterEach(() => {
  cleanup();
});

describe("the parts", () => {
  it("marks the root with its variant, outline by default, adds the caller's class and gives the root no role", () => {
    const { rerender } = render(
      <SplitButton.Root className="ml-auto">
        <SplitButton.Action>Open draft</SplitButton.Action>
        <SplitButton.Menu label="More draft actions">{null}</SplitButton.Menu>
      </SplitButton.Root>,
    );
    const root = action().parentElement!;

    expect(root.dataset.variant).toBe("outline");
    expect(root.classList.contains("ml-auto")).toBe(true);
    expect(root.getAttribute("role")).toBeNull();

    rerender(
      <SplitButton.Root variant="filled">
        <SplitButton.Action>Open draft</SplitButton.Action>
        <SplitButton.Menu label="More draft actions">{null}</SplitButton.Menu>
      </SplitButton.Root>,
    );

    expect(root.dataset.variant).toBe("filled");
  });

  it("passes data attributes to the root, and keeps its own variant", () => {
    render(
      <SplitButton.Root data-place="top-bar" data-variant="filled">
        <SplitButton.Action>Open draft</SplitButton.Action>
        <SplitButton.Menu label="More draft actions">{null}</SplitButton.Menu>
      </SplitButton.Root>,
    );
    const root = action().parentElement!;

    expect(root.dataset.place).toBe("top-bar");
    expect(root.dataset.variant).toBe("outline");
  });

  it("makes the action a button of type button, named by its text or by its aria-label", () => {
    const { rerender } = render(
      <SplitButton.Root>
        <SplitButton.Action>Open draft</SplitButton.Action>
        <SplitButton.Menu label="More draft actions">{null}</SplitButton.Menu>
      </SplitButton.Root>,
    );

    expect(action().getAttribute("type")).toBe("button");

    rerender(
      <SplitButton.Root>
        <SplitButton.Action aria-label="Open draft, opening">Open draft</SplitButton.Action>
        <SplitButton.Menu label="More draft actions">{null}</SplitButton.Menu>
      </SplitButton.Root>,
    );

    expect(screen.getByRole("button", { name: "Open draft, opening" })).toBeTruthy();
  });

  it("names the menu part by its label, as a button that opens a menu", async () => {
    const user = userEvent.setup();
    renderControl();

    expect(menuPart().getAttribute("aria-haspopup")).toBe("menu");
    expect(menuPart().getAttribute("aria-expanded")).toBe("false");
    expect(menuPart().querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");

    await user.click(menuPart());
    await screen.findByRole("menu");

    expect(menuPart().getAttribute("aria-expanded")).toBe("true");
  });

  it("passes a ref, a data attribute and a class to the button of the action, and a ref to the menu part", () => {
    const actionRef = createRef<HTMLButtonElement>();
    const menuRef = createRef<HTMLButtonElement>();
    render(
      <SplitButton.Root>
        <SplitButton.Action ref={actionRef} data-kind="open" className="max-w-40">Open draft</SplitButton.Action>
        <SplitButton.Menu ref={menuRef} label="More draft actions">{null}</SplitButton.Menu>
      </SplitButton.Root>,
    );

    expect(actionRef.current).toBe(action());
    expect(action().dataset.kind).toBe("open");
    expect(action().classList.contains("max-w-40")).toBe(true);
    expect(menuRef.current).toBe(menuPart());
  });

  it("calls the action pressed inside the app's tooltip", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <SplitButton.Root>
        <Tooltip content="Open the draft in its editor">
          <SplitButton.Action onClick={onAction}>Open draft</SplitButton.Action>
        </Tooltip>
        <SplitButton.Menu label="More draft actions">{null}</SplitButton.Menu>
      </SplitButton.Root>,
    );

    await user.click(action());

    expect(onAction).toHaveBeenCalledOnce();
  });

  it("opens its menu in a popup with the class of every menu", async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(menuPart());
    const menu = await screen.findByRole("menu");

    for (const name of POPUP_CLASS.split(" ")) {
      expect(menu.classList.contains(name)).toBe(true);
    }
  });
});

describe("the keyboard and the pointer", () => {
  it("takes the action, then the menu part, in the tab order", async () => {
    const user = userEvent.setup();
    renderControl();
    focusOn(screen.getByRole("button", { name: "Before" }));

    await user.tab();
    expect(document.activeElement).toBe(action());
    await user.tab();
    expect(document.activeElement).toBe(menuPart());
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
  });

  it.each([
    { how: "a click", press: (user: User) => user.click(action()) },
    { how: "Enter", press: (user: User) => user.keyboard("{Enter}") },
    { how: "Space", press: (user: User) => user.keyboard(" ") },
  ])("calls the action on $how", async ({ press }) => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderControl({ onAction });
    focusOn(action());

    await press(user);

    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each([
    { key: "{Enter}", first: "Archive draft" },
    { key: " ", first: "Archive draft" },
    { key: "{ArrowDown}", first: "Archive draft" },
    { key: "{ArrowUp}", first: "Delete draft" },
  ])("opens the menu on $key with $first highlighted", async ({ key, first }) => {
    const user = userEvent.setup();
    renderControl();
    focusOn(menuPart());

    await user.keyboard(key);
    const menu = await screen.findByRole("menu");

    await waitFor(() => {
      expect(highlighted(menu)).toEqual([first]);
    });
  });

  it("opens the menu on a click with no item highlighted", async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(menuPart());
    const menu = await screen.findByRole("menu");

    expect(highlighted(menu)).toEqual([]);
  });

  it.each([
    { how: "a click", choose: (user: User, menu: HTMLElement) => user.click(items(menu)[0]!) },
    { how: "Enter", choose: (user: User) => user.keyboard("{Enter}") },
  ])("runs an item chosen by $how, closes the menu and returns focus to the menu part", async ({ choose }) => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    renderControl({ onArchive });
    focusOn(menuPart());
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");

    await choose(user, menu);

    expect(onArchive).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(menuPart());
    });
  });

  it("closes the menu on Esc and returns focus to the menu part", async () => {
    const user = userEvent.setup();
    renderControl();
    await user.click(menuPart());
    await screen.findByRole("menu");

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(menuPart());
    });
  });
});

describe("busy", () => {
  it("keeps the action focusable with no effect, and shows a spinner in place of its icon", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const { rerender } = renderControl({ onAction });
    expect(action().querySelectorAll("svg")).toHaveLength(1);
    expect(spinning(action())).toBe(false);

    rerender({ busy: true });
    await user.click(action());
    focusOn(action());
    await user.keyboard("{Enter}");

    expect(action().getAttribute("aria-disabled")).toBe("true");
    expect(action().hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(action());
    expect(action().querySelectorAll("svg")).toHaveLength(1);
    expect(spinning(action())).toBe(true);
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each([
    { how: "a click", press: (user: User) => user.click(menuPart()) },
    { how: "Enter", press: (user: User) => user.keyboard("{Enter}") },
    { how: "Space", press: (user: User) => user.keyboard(" ") },
    { how: "ArrowDown", press: (user: User) => user.keyboard("{ArrowDown}") },
    { how: "ArrowUp", press: (user: User) => user.keyboard("{ArrowUp}") },
  ])("keeps the menu part focusable and closed on $how", async ({ press }) => {
    const user = userEvent.setup();
    renderControl({ busy: true });
    focusOn(menuPart());

    await press(user);

    expect(menuPart().getAttribute("aria-disabled")).toBe("true");
    expect(menuPart().hasAttribute("disabled")).toBe(false);
    expect(menuPart().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(menuPart());
  });

  it("returns focus to the menu part after an item makes the control busy", async () => {
    const user = userEvent.setup();
    render(<BusyOnArchive />);
    await user.click(menuPart());

    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Archive draft" }));

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(menuPart());
    });
    expect(menuPart().getAttribute("aria-disabled")).toBe("true");
    expect(action().getAttribute("aria-disabled")).toBe("true");
  });

  it.each(["busy", "disabled"] as const)("closes an open menu when %s turns on, and keeps it closed when it turns off", async (state) => {
    const user = userEvent.setup();
    const { rerender } = renderControl();
    await user.click(menuPart());
    await screen.findByRole("menu");

    rerender({ [state]: true });

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });

    rerender({ [state]: false });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(menuPart().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("disabled", () => {
  it("takes both parts out of the tab order, and does not open the menu", async () => {
    const user = userEvent.setup();
    renderControl({ disabled: true });
    focusOn(screen.getByRole("button", { name: "Before" }));

    await user.tab();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
    expect(action().hasAttribute("disabled")).toBe(true);
    expect(menuPart().hasAttribute("disabled")).toBe(true);

    await user.click(menuPart());

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("takes the action alone out of the tab order, and the menu part still opens", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <>
        <button type="button">Before</button>
        <SplitButton.Root>
          <SplitButton.Action disabled onClick={onAction}>Open draft</SplitButton.Action>
          <SplitButton.Menu label="More draft actions">
            <Menu.Item className={MENU_ITEM_CLASS}>Archive draft</Menu.Item>
          </SplitButton.Menu>
        </SplitButton.Root>
      </>,
    );
    focusOn(screen.getByRole("button", { name: "Before" }));

    await user.tab();

    expect(document.activeElement).toBe(menuPart());
    expect(action().hasAttribute("disabled")).toBe(true);

    await user.click(action());
    focusOn(menuPart());
    await user.keyboard("{Enter}");

    expect(onAction).not.toHaveBeenCalled();
    expect(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Archive draft" })).toBeTruthy();
  });
});

describe("focus recovery", () => {
  it.each([
    { holder: "the open menu", open: true },
    { holder: "the menu part", open: false },
  ])("calls onFocusLost when the control leaves the page while $holder holds focus", async ({ open }) => {
    const user = userEvent.setup();
    const onFocusLost = vi.fn();
    const { rerender } = renderControl({ onFocusLost });
    if (open) {
      await user.click(menuPart());
      await screen.findByRole("menu");
    } else {
      focusOn(menuPart());
    }

    rerender({ present: false });

    expect(onFocusLost).toHaveBeenCalledOnce();
  });

  it("does not call onFocusLost when the control leaves the page while focus is elsewhere", async () => {
    const user = userEvent.setup();
    const onFocusLost = vi.fn();
    const { rerender } = renderControl({ onFocusLost });
    await user.click(menuPart());
    await screen.findByRole("menu");
    rerender({ busy: true });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    rerender({ busy: false });
    focusOn(screen.getByRole("button", { name: "After" }));

    rerender({ present: false });

    expect(onFocusLost).not.toHaveBeenCalled();
  });

  it("leaves the page with its menu open when no onFocusLost is given", async () => {
    const user = userEvent.setup();
    const { rerender } = renderControl();
    await user.click(menuPart());
    await screen.findByRole("menu");

    rerender({ present: false });

    expect(screen.queryByRole("menu")).toBeNull();
  });
});
