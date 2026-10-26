import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatOptionMenu } from "../../src/components/chat-option-menu";
import type { ChatOption } from "../../src/lib/chat-fold";

const MODE: ChatOption = {
  id: "mode",
  name: "Mode",
  category: "mode",
  current: "acceptEdits",
  values: [
    { value: "default", name: "Manual", description: "Always ask before making changes" },
    { value: "acceptEdits", name: "Accept edits", description: "Automatically accept all file edits" },
    { value: "plan", name: "Plan", description: "Create a plan before making changes" },
    { value: "auto", name: "Auto" },
  ],
};

type MenuProps = Partial<ComponentProps<typeof ChatOptionMenu>> & { present?: boolean };

function Menu({ present = true, ...props }: MenuProps): ReactNode {
  return present && <ChatOptionMenu option={MODE} hidden={["plan"]} onPick={() => {}} onFocusLost={() => {}} {...props} />;
}

function renderMenu(props: MenuProps = {}) {
  const result = render(<Menu {...props} />);

  return { ...result, rerender: (next: MenuProps) => result.rerender(<Menu {...props} {...next} />) };
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

afterEach(() => {
  cleanup();
});

describe("the trigger", () => {
  it("shows the visible label of the option and the name of the current value", () => {
    renderMenu();

    expect(screen.getByText("Mode")).toBeDefined();
    expect(screen.getByRole("button", { name: "Mode Accept edits" })).toBe(trigger());
  });

  it("shows a pending value with an ellipsis, and is not disabled", () => {
    renderMenu({ pending: "auto" });

    expect(screen.getByRole("button", { name: "Mode Auto…" })).toBe(trigger());
    expect(trigger().hasAttribute("disabled")).toBe(false);
    expect(trigger().hasAttribute("aria-busy")).toBe(false);
  });

  it("shows the name of a hidden current value", () => {
    renderMenu({ option: { ...MODE, current: "plan" } });

    expect(screen.getByRole("button", { name: "Mode Plan" })).toBe(trigger());
  });

  it("shows the id of a value that the option does not offer", () => {
    renderMenu({ option: { ...MODE, current: "dontAsk" } });

    expect(screen.getByRole("button", { name: "Mode dontAsk" })).toBe(trigger());
  });
});

describe("the menu", () => {
  it("is named by the label, and lists the names and the descriptions without the hidden values", async () => {
    renderMenu();
    const { menu } = await openMenu();

    expect(screen.getByRole("menu", { name: "Mode" })).toBe(menu);
    expect(items(menu).map((item) => item.textContent)).toEqual([
      "ManualAlways ask before making changes",
      "Accept editsAutomatically accept all file edits",
      "Auto",
    ]);
  });

  it("names each item by its name alone, with the description as its description", async () => {
    renderMenu();
    const { menu } = await openMenu();

    const manual = within(menu).getByRole("menuitemradio", { name: "Manual" });
    expect(manual.getAttribute("aria-describedby")).not.toBeNull();
    expect(document.getElementById(manual.getAttribute("aria-describedby")!)?.textContent)
      .toBe("Always ask before making changes");
    expect(within(menu).getByRole("menuitemradio", { name: "Auto" }).hasAttribute("aria-describedby")).toBe(false);
  });

  it("checks the current value", async () => {
    renderMenu();
    const { menu } = await openMenu();

    expect(items(menu).map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  });

  it("checks the pending value", async () => {
    renderMenu({ pending: "auto" });
    const { menu } = await openMenu();

    expect(items(menu).map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
  });

  it("checks no item when the current value is hidden", async () => {
    renderMenu({ option: { ...MODE, current: "plan" } });
    const { menu } = await openMenu();

    expect(items(menu).map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
  });
});

describe("picking a value", () => {
  it("calls back once with another value, and closes the menu", async () => {
    const onPick = vi.fn();
    renderMenu({ onPick });
    const { user, menu } = await openMenu();

    await user.click(within(menu).getByRole("menuitemradio", { name: "Auto" }));

    expect(onPick.mock.calls).toEqual([["auto"]]);
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  it("closes the menu and calls nothing for the checked value", async () => {
    const onPick = vi.fn();
    renderMenu({ onPick });
    const { user, menu } = await openMenu();

    await user.click(within(menu).getByRole("menuitemradio", { name: "Accept edits" }));

    expect(onPick).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  it("opens, moves and picks from the keyboard, and gives focus back to the trigger", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    renderMenu({ onPick });

    trigger().focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(menu.contains(document.activeElement)).toBe(true);
    });
    while (document.activeElement?.getAttribute("aria-labelledby") !== within(menu).getByText("Manual").id) {
      await user.keyboard("{ArrowDown}");
    }
    await user.keyboard("{Enter}");

    expect(onPick.mock.calls).toEqual([["default"]]);
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger());
    });
  });

  it("closes with Escape and gives focus back to the trigger", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    renderMenu({ onPick });

    trigger().focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(document.activeElement).toBe(trigger());
    expect(onPick).not.toHaveBeenCalled();
  });

  it("moves to an item by the first letters of its name", async () => {
    const user = userEvent.setup();
    renderMenu();

    trigger().focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(menu.contains(document.activeElement)).toBe(true);
    });
    await user.keyboard("au");

    await waitFor(() => {
      expect(document.activeElement).toBe(within(menu).getByRole("menuitemradio", { name: "Auto" }));
    });
  });
});

describe("leaving the page", () => {
  it("reports the loss when the trigger holds focus", () => {
    const onFocusLost = vi.fn();
    const { rerender } = renderMenu({ onFocusLost });

    trigger().focus();
    rerender({ present: false });

    expect(onFocusLost).toHaveBeenCalledOnce();
  });

  it("reports the loss while its open menu holds focus", async () => {
    const onFocusLost = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderMenu({ onFocusLost });

    trigger().focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(menu.contains(document.activeElement)).toBe(true);
    });

    rerender({ present: false });

    expect(onFocusLost).toHaveBeenCalledOnce();
  });
});
