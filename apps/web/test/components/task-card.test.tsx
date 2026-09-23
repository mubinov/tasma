import type { TaskEntry } from "@tasma/protocol";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PointerEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskCard, type CardPart } from "../../src/components/task-card";
import type { StepView } from "../../src/lib/board";
import { entry } from "../card-fixture";
import { renderBesideTaskRoute } from "../helpers";

type CardState = {
  pending?: boolean;
  focusPart?: CardPart | null;
  onFocused?: () => void;
  onOpen?: () => void;
  onDelete?: (id: string) => void;
  dragging?: boolean;
  onPress?: (event: PointerEvent<HTMLElement>) => void;
};

async function renderCard(
  task: TaskEntry = entry(),
  view: StepView = { kind: "none" },
  top = false,
  {
    pending = false,
    focusPart = null,
    onFocused = () => {},
    onOpen = () => {},
    onDelete = () => {},
    dragging = false,
    onPress = () => {},
  }: CardState = {},
) {
  // The router scrolls on navigation, which jsdom does not implement.
  vi.stubGlobal("scrollTo", () => {});
  const { container, router } = await renderBesideTaskRoute(
    <TaskCard
      tag="SAGA"
      entry={task}
      view={view}
      top={top}
      statuses={["To Do", "In Progress", "Done"]}
      pending={pending}
      dragging={dragging}
      onMove={() => {}}
      onOpen={onOpen}
      onDelete={onDelete}
      focusPart={focusPart}
      onFocused={onFocused}
      onPress={onPress}
    />,
  );

  return { card: container.firstElementChild as HTMLElement, router };
}

function classesOf(element: Element | null | undefined): string[] {
  return (element?.getAttribute("class") ?? "").split(" ");
}

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

it("shows the id and the title, with the right side of the top row kept free and the title across the card", async () => {
  await renderCard(entry({ priority: "high" }));

  const id = screen.getByText("SAGA-7");
  const title = screen.getByText("Build the parser");
  expect(id.className).toContain("font-mono");
  expect(classesOf(id.parentElement)).toContain("pr-6");
  expect(id.parentElement?.lastElementChild?.textContent).toBe("high");
  expect(classesOf(title)).toContain("wrap-anywhere");
  expect(classesOf(title)).not.toContain("pr-6");
});

describe("opening the task", () => {
  const TASK_PATH = "/tasks/SAGA/SAGA-7";

  it("makes the title the one link, and the title and then the menu button the tab stops", async () => {
    const { card } = await renderCard();

    const stops = [...card.querySelectorAll<HTMLElement>("a, button, [tabindex]")];
    expect(stops.map((stop) => stop.textContent || stop.getAttribute("aria-label"))).toEqual(["Build the parser", "Task menu"]);
    expect(stops[0]?.getAttribute("href")).toBe(TASK_PATH);
    expect(stops.map((stop) => stop.tabIndex)).toEqual([0, 0]);
    expect(card.tabIndex).toBe(-1);
    expect(card.getAttribute("role")).toBeNull();
  });

  it("describes the menu button by the title, so the menu buttons of a board are told apart", async () => {
    await renderCard();

    expect(screen.getByRole("button", { name: "Task menu", description: "Build the parser" })).toBeTruthy();
  });

  it("stays on the board when the click is on the menu button", async () => {
    const user = userEvent.setup();
    const { router } = await renderCard();

    await user.click(screen.getByRole("button", { name: "Task menu" }));

    expect(router.state.location.pathname).toBe("/");
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("opens the task from the title", async () => {
    const user = userEvent.setup();
    const { router } = await renderCard();

    await user.click(screen.getByRole("link", { name: "Build the parser" }));

    expect(router.state.location.pathname).toBe(TASK_PATH);
  });

  it("opens the task from a click anywhere on the card", async () => {
    const user = userEvent.setup();
    const { card, router } = await renderCard(entry({ labels: ["web"] }));

    await user.click(screen.getByText("web"));

    expect(router.state.location.pathname).toBe(TASK_PATH);
    expect(card.classList.contains("cursor-pointer")).toBe(true);
  });

  it("stays on the board when the click ends a text selection", async () => {
    const { router } = await renderCard();

    const id = screen.getByText("SAGA-7");
    window.getSelection()?.selectAllChildren(id);
    await act(async () => {
      fireEvent.click(id);
    });

    expect(router.state.location.pathname).toBe("/");
  });

  it("stays on the board when a modifier key is held", async () => {
    const { router } = await renderCard();

    await act(async () => {
      fireEvent.click(screen.getByText("SAGA-7"), { ctrlKey: true });
    });

    expect(router.state.location.pathname).toBe("/");
  });

  const OPENS_FROM = [
    { from: "the title", text: "Build the parser" },
    { from: "the card", text: "SAGA-7" },
  ];

  it.each(OPENS_FROM)("says the task is opening, from $from", async ({ text }) => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    await renderCard(entry(), { kind: "none" }, false, { onOpen });

    await user.click(screen.getByText(text));

    expect(onOpen).toHaveBeenCalledOnce();
  });

  // A modified click asks for a new tab, which opens the task page with no board behind it.
  it.each(OPENS_FROM)("says nothing when a modifier key is held on $from", async ({ text }) => {
    const onOpen = vi.fn();
    await renderCard(entry(), { kind: "none" }, false, { onOpen });

    await act(async () => {
      fireEvent.click(screen.getByText(text), { ctrlKey: true });
    });

    expect(onOpen).not.toHaveBeenCalled();
  });
});

it("marks a blocked task, and only a blocked task", async () => {
  await renderCard(entry({}, true));
  expect(screen.getByText("blocked")).toBeTruthy();

  cleanup();
  await renderCard(entry({}, false));
  expect(screen.queryByText("blocked")).toBeNull();
});

describe("the priority", () => {
  it("is strong for the top priority", async () => {
    await renderCard(entry({ priority: "high" }), { kind: "none" }, true);

    expect(classesOf(screen.getByText("high"))).toEqual(expect.arrayContaining(["font-medium", "text-text"]));
  });

  it("is muted for another priority", async () => {
    await renderCard(entry({ priority: "low" }), { kind: "none" }, false);

    const priority = classesOf(screen.getByText("low"));
    expect(priority).toContain("text-muted");
    expect(priority).not.toContain("font-medium");
  });

  it("is absent when the task states none", async () => {
    const { card } = await renderCard(entry());

    expect(card.firstElementChild?.children).toHaveLength(1);
  });
});

describe("the flow row", () => {
  it("is absent for no step", async () => {
    const { card } = await renderCard(entry(), { kind: "none" });

    expect(card.children).toHaveLength(3);
  });

  it("shows a stale step as its name alone", async () => {
    const { card } = await renderCard(entry(), { kind: "stale", name: "review" });

    const row = card.children[3]!;
    expect(row.children).toHaveLength(1);
    expect(row.textContent).toBe("review");
    expect(classesOf(row.firstElementChild)).toContain("text-dim");
  });

  it.each([
    { owner: "agent" as const, dot: "bg-running", words: ", step 2 of 4, an agent's step" },
    { owner: "human" as const, dot: "bg-signal", words: ", step 2 of 4, a human's step" },
  ])("shows $owner's current step with its dot, its name and what a screen reader says", async ({ owner, dot, words }) => {
    const { card } = await renderCard(entry(), {
      kind: "step",
      name: "implement",
      owner,
      current: 1,
      owners: ["agent", owner, "human", "agent"],
    });

    const [mark, name, spoken, segments] = [...card.children[3]!.children];
    expect(classesOf(mark)).toContain(dot);
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(name?.textContent).toBe("implement");
    expect(spoken?.textContent).toBe(words);
    expect(classesOf(spoken)).toContain("sr-only");
    expect(segments?.getAttribute("aria-hidden")).toBe("true");
    expect(classesOf(segments)).toContain("ml-auto");
  });

  it("draws one segment per step: a bar for an agent, a ring for a human, by position", async () => {
    const { card } = await renderCard(entry(), {
      kind: "step",
      name: "approve",
      owner: "human",
      current: 2,
      owners: ["agent", "human", "human", "agent", "human"],
    });

    const segments = [...card.querySelectorAll("i")].map((segment) => segment.getAttribute("class"));
    expect(segments).toEqual([
      "h-[3px] w-2 rounded-[2px] bg-graphic",
      "size-[7px] rounded-full border-[1.5px] border-graphic",
      "size-[9px] rounded-full border-[1.5px] border-signal bg-signal",
      "h-[3px] w-2 rounded-[2px] bg-line",
      "size-[7px] rounded-full border-[1.5px] border-line",
    ]);
  });

  it("draws the current agent's step as the larger running bar", async () => {
    const { card } = await renderCard(entry(), { kind: "step", name: "implement", owner: "agent", current: 0, owners: ["agent"] });

    expect(card.querySelector("i")?.getAttribute("class")).toBe("h-[5px] w-2.5 rounded-[2px] bg-running");
  });
});

it("lists the labels in file order, each with its dot", async () => {
  const { card } = await renderCard(entry({ labels: ["web", "infra", "api"] }));

  const labels = within(card).getAllByRole("listitem");
  expect(labels.map((label) => label.textContent)).toEqual(["web", "infra", "api"]);
  expect(classesOf(labels[0]?.firstElementChild)).toContain("bg-graphic");
});

it("lets a long label wrap inside the card, with its dot kept whole", async () => {
  const { card } = await renderCard(entry({ labels: ["infrastructureautomationpipelinestagingeurope"] }));

  const [dot, word] = [...card.lastElementChild!.firstElementChild!.children];
  expect(classesOf(dot)).toContain("shrink-0");
  expect(word?.textContent).toBe("infrastructureautomationpipelinestagingeurope");
  expect(classesOf(word)).toEqual(expect.arrayContaining(["min-w-0", "wrap-anywhere"]));
});

it("shows no label row when the task has no label", async () => {
  const { card } = await renderCard(entry({ labels: [] }));

  expect(card.children).toHaveLength(3);
});

describe("the menu button", () => {
  it("sits at the right end of the top row, shown only while the card is hovered or holds focus or the menu is open", async () => {
    const { card } = await renderCard();

    const button = screen.getByRole("button", { name: "Task menu" });
    expect(classesOf(card)).toEqual(expect.arrayContaining(["group/card", "relative"]));
    expect(classesOf(button)).toEqual(
      expect.arrayContaining([
        "absolute",
        "top-1.5",
        "right-2",
        "size-6",
        "opacity-0",
        "group-hover/card:opacity-100",
        "group-focus-within/card:opacity-100",
        "data-[popup-open]:opacity-100",
      ]),
    );
  });

  it("asks to delete the card's task from Delete", async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    await renderCard(entry(), { kind: "none" }, false, { onDelete });

    await user.click(screen.getByRole("button", { name: "Task menu" }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Delete SAGA-7" }));

    expect(onDelete.mock.calls).toEqual([["SAGA-7"]]);
  });
});

describe("a card a pending write changes", () => {
  it("is at 55% opacity and busy, and its border does not change on hover", async () => {
    const { card } = await renderCard(entry(), { kind: "none" }, false, { pending: true });

    expect(classesOf(card)).toContain("opacity-55");
    expect(classesOf(card)).not.toContain("hover:border-graphic");
    expect(card.getAttribute("aria-busy")).toBe("true");
  });

  it("is neither dimmed nor busy once the write has an answer", async () => {
    const { card } = await renderCard();

    expect(classesOf(card)).not.toContain("opacity-55");
    expect(classesOf(card)).toContain("hover:border-graphic");
    expect(card.hasAttribute("aria-busy")).toBe(false);
  });
});

describe("focus the board hands the card", () => {
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("scrolls the card into view, focuses its menu button after a move and reports it", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const onFocused = vi.fn();

    const { card } = await renderCard(entry(), { kind: "none" }, false, { focusPart: "menu", onFocused });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Task menu" }));
    expect(scrollIntoView.mock.contexts).toEqual([card]);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(onFocused).toHaveBeenCalledOnce();
  });

  it("scrolls the card into view, focuses its title link after a create and reports it", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const onFocused = vi.fn();

    const { card } = await renderCard(entry(), { kind: "none" }, false, { focusPart: "title", onFocused });

    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Build the parser" }));
    expect(scrollIntoView.mock.contexts).toEqual([card]);
    expect(onFocused).toHaveBeenCalledOnce();
  });

  it("leaves focus alone while the board asks for none", async () => {
    const onFocused = vi.fn();

    await renderCard(entry(), { kind: "none" }, false, { onFocused });

    expect(document.activeElement).toBe(document.body);
    expect(onFocused).not.toHaveBeenCalled();
  });
});

it("names the task on the card and marks the title link, for the board to find both", async () => {
  const { card } = await renderCard();

  expect(card.getAttribute("data-task-id")).toBe("SAGA-7");
  expect(card.querySelector("[data-task-title]")).toBe(screen.getByRole("link", { name: "Build the parser" }));
});

describe("dragging a card", () => {
  it("hands a press on the card to the board", async () => {
    const onPress = vi.fn();
    const { card } = await renderCard(entry(), { kind: "none" }, false, { onPress });

    fireEvent.pointerDown(card, { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });

    expect(onPress).toHaveBeenCalledOnce();
  });

  it("leaves the card a drag carries at 35%, with its border unchanged on hover", async () => {
    const { card } = await renderCard(entry(), { kind: "none" }, false, { dragging: true });

    expect(classesOf(card)).toContain("opacity-35");
    expect(classesOf(card)).not.toContain("hover:border-graphic");
  });

  it("keeps the browser from starting a link drag of the title", async () => {
    await renderCard();

    expect(screen.getByRole("link").getAttribute("draggable")).toBe("false");
  });
});
