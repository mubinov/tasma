import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardContextMenu, CardMenu, type CardMenuItemsProps } from "../../src/components/card-menu";
import { renderBesideTaskRoute } from "../helpers";

const STATUSES = ["Backlog", "In Progress", "Done"];

function Card({ status, onMove }: Pick<CardMenuItemsProps, "status" | "onMove">): ReactNode {
  const menu = { tag: "SAGA", id: "SAGA-7", status, statuses: STATUSES, onMove };

  return (
    <CardContextMenu menu={menu} data-testid="card">
      <span>Draft the schema</span>
      <CardMenu {...menu} />
    </CardContextMenu>
  );
}

async function renderMenu(status = "In Progress", onMove: (status: string) => void = () => {}) {
  // The router scrolls on navigation, which jsdom does not implement.
  vi.stubGlobal("scrollTo", () => {});

  return renderBesideTaskRoute(<Card status={status} onMove={onMove} />);
}

async function openFromButton() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Task menu" }));

  return { user, menu: await screen.findByRole("menu") };
}

function statusItems(menu: HTMLElement): HTMLElement[] {
  return within(menu).getAllByRole("menuitemradio");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the items", () => {
  it("are Open task, a separator, and the statuses in order under the Move to label", async () => {
    await renderMenu();
    const { menu } = await openFromButton();

    const [open, separator, group] = [...menu.children];
    expect(open?.getAttribute("role")).toBe("menuitem");
    expect(open?.textContent).toBe("Open task");
    expect(separator?.getAttribute("role")).toBe("separator");
    expect(group).toBe(within(menu).getByRole("group", { name: "Move to" }));
    expect(statusItems(menu).map((item) => item.textContent)).toEqual(STATUSES);
  });

  it("check and dim the status the task has, ignoring case", async () => {
    await renderMenu("in progress");
    const { menu } = await openFromButton();

    expect(statusItems(menu).map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(statusItems(menu)[1]?.className).toContain("data-[checked]:text-dim");
    expect(statusItems(menu)[1]?.hasAttribute("data-checked")).toBe(true);
  });

  it("check no status for a task whose status the project does not configure", async () => {
    await renderMenu("Waiting");
    const { menu } = await openFromButton();

    expect(statusItems(menu).map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
  });
});

describe("choosing an item", () => {
  it("moves the task with Enter on another status, and closes the menu", async () => {
    const onMove = vi.fn();
    await renderMenu("In Progress", onMove);
    const user = userEvent.setup();

    screen.getByRole("button", { name: "Task menu" }).focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(menu.contains(document.activeElement)).toBe(true);
    });
    while (document.activeElement?.textContent !== "Done") {
      await user.keyboard("{ArrowDown}");
    }
    await user.keyboard("{Enter}");

    expect(onMove.mock.calls).toEqual([["Done"]]);
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  it("writes nothing for the checked status, and closes the menu", async () => {
    const onMove = vi.fn();
    await renderMenu("In Progress", onMove);
    const { user, menu } = await openFromButton();

    await user.click(within(menu).getByRole("menuitemradio", { name: "In Progress" }));

    expect(onMove).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  it("moves a task whose status the project does not configure to the status its column shows", async () => {
    const onMove = vi.fn();
    await renderMenu("Waiting", onMove);
    const { user, menu } = await openFromButton();

    await user.click(within(menu).getByRole("menuitemradio", { name: "Backlog" }));

    expect(onMove.mock.calls).toEqual([["Backlog"]]);
  });

  it("opens the task from Open task", async () => {
    const { router } = await renderMenu();
    const { user, menu } = await openFromButton();

    await act(async () => {
      await user.click(within(menu).getByRole("menuitem", { name: "Open task" }));
    });

    expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-7");
  });
});

describe("right click", () => {
  it("opens the same items on the card", async () => {
    await renderMenu();

    fireEvent.contextMenu(screen.getByText("Draft the schema"), { clientX: 40, clientY: 20 });

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem").textContent).toBe("Open task");
    expect(statusItems(menu).map((item) => item.textContent)).toEqual(STATUSES);
  });

  it("opens nothing from inside the menu of the button, which renders outside the card", async () => {
    await renderMenu();
    const { menu } = await openFromButton();

    fireEvent.contextMenu(within(menu).getByRole("menuitem", { name: "Open task" }));

    expect(screen.getAllByRole("menu")).toEqual([menu]);
  });
});

describe("a long press", () => {
  function longPress(target: HTMLElement): void {
    vi.useFakeTimers();
    try {
      fireEvent.touchStart(target, { touches: [{ clientX: 40, clientY: 20 }] });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it("opens the items on the card", async () => {
    await renderMenu();

    longPress(screen.getByText("Draft the schema"));

    expect(statusItems(await screen.findByRole("menu")).map((item) => item.textContent)).toEqual(STATUSES);
  });

  it("opens nothing from inside the menu of the button", async () => {
    await renderMenu();
    const { menu } = await openFromButton();

    longPress(within(menu).getByRole("menuitem", { name: "Open task" }));

    expect(screen.getAllByRole("menu")).toEqual([menu]);
  });
});
