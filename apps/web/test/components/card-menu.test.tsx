import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardContextMenu, CardMenu, type CardMenuItemsProps } from "../../src/components/card-menu";
import { MENU_ITEM_CLASS } from "../../src/components/control-classes";
import { renderBesideTaskRoute } from "../helpers";

const STATUSES = ["Backlog", "In Progress", "Done"];

type CardProps = Pick<CardMenuItemsProps, "status" | "onMove" | "onMoveUp" | "onMoveDown" | "onOpen">;

function Card({ status, onMove, onMoveUp, onMoveDown, onOpen }: CardProps): ReactNode {
  const menu = { tag: "SAGA", id: "SAGA-7", status, statuses: STATUSES, onMove, onMoveUp, onMoveDown, onOpen };

  return (
    <CardContextMenu menu={menu} data-testid="card">
      <span>Draft the schema</span>
      <CardMenu {...menu} />
    </CardContextMenu>
  );
}

async function renderMenu(status = "In Progress", handlers: Partial<Omit<CardProps, "status">> = {}) {
  // The router scrolls on navigation, which jsdom does not implement.
  vi.stubGlobal("scrollTo", () => {});

  return renderBesideTaskRoute(<Card status={status} onMove={() => {}} onOpen={() => {}} {...handlers} />);
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
    await renderMenu("In Progress", { onMove });
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
    await renderMenu("In Progress", { onMove });
    const { user, menu } = await openFromButton();

    await user.click(within(menu).getByRole("menuitemradio", { name: "In Progress" }));

    expect(onMove).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  it("moves a task whose status the project does not configure to the status its column shows", async () => {
    const onMove = vi.fn();
    await renderMenu("Waiting", { onMove });
    const { user, menu } = await openFromButton();

    await user.click(within(menu).getByRole("menuitemradio", { name: "Backlog" }));

    expect(onMove.mock.calls).toEqual([["Backlog"]]);
  });

  it("opens the task from Open task, and says so before it navigates", async () => {
    const onOpen = vi.fn();
    const { router } = await renderMenu("In Progress", { onOpen });
    const { user, menu } = await openFromButton();

    await act(async () => {
      await user.click(within(menu).getByRole("menuitem", { name: "Open task" }));
    });

    expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-7");
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("Move up and Move down", () => {
  it("follow the statuses inside the Move to group", async () => {
    await renderMenu("In Progress", { onMoveUp: () => {}, onMoveDown: () => {} });
    const { menu } = await openFromButton();

    const group = within(menu).getByRole("group", { name: "Move to" });
    expect([...group.querySelectorAll("[role^=menuitem]")].map((item) => item.textContent)).toEqual([
      ...STATUSES,
      "Move up",
      "Move down",
    ]);
    expect(within(group).getByRole("menuitem", { name: "Move up" }).className).toBe(MENU_ITEM_CLASS);
  });

  it.each([
    { case: "neither place is given", places: {}, items: [] },
    { case: "only a place above is given", places: { onMoveUp: () => {} }, items: ["Move up"] },
    { case: "only a place below is given", places: { onMoveDown: () => {} }, items: ["Move down"] },
  ])("show only the items whose place is given when $case", async ({ places, items }) => {
    await renderMenu("In Progress", places);
    const { menu } = await openFromButton();

    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open task", ...items]);
  });

  it.each(["Move up", "Move down"])("%s calls its handler alone, and closes the menu", async (name) => {
    const onMove = vi.fn();
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    await renderMenu("In Progress", { onMove, onMoveUp, onMoveDown });
    const { user, menu } = await openFromButton();

    await user.click(within(menu).getByRole("menuitem", { name }));

    expect([onMoveUp.mock.calls.length, onMoveDown.mock.calls.length]).toEqual(name === "Move up" ? [1, 0] : [0, 1]);
    expect(onMove).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
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
