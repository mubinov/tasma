import type { Frontmatter, TaskEntry } from "@tasma/protocol";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskCard } from "../../src/components/task-card";
import type { StepView } from "../../src/lib/board";
import { renderBesideTaskRoute } from "../helpers";

function entry(fields: Partial<Frontmatter> = {}, blocked = false): TaskEntry {
  return {
    id: "SAGA-55",
    path: "/tasks/SAGA-55.md",
    blocked,
    frontmatter: {
      id: "SAGA-55",
      title: "Web: Tasks board",
      status: "In Progress",
      created: "2026-09-01T10:00:00Z",
      updated: "2026-09-01T10:00:00Z",
      next_comment_id: 1,
      ...fields,
    },
  };
}

async function renderCard(task: TaskEntry = entry(), view: StepView = { kind: "none" }, top = false) {
  // The router scrolls on navigation, which jsdom does not implement.
  vi.stubGlobal("scrollTo", () => {});
  const { container, router } = await renderBesideTaskRoute(<TaskCard tag="SAGA" entry={task} view={view} top={top} />);

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

it("shows the id and the title, with the right side of the title kept free", async () => {
  await renderCard();

  expect(screen.getByText("SAGA-55").className).toContain("font-mono");
  expect(classesOf(screen.getByText("Web: Tasks board"))).toEqual(expect.arrayContaining(["pr-6", "wrap-anywhere"]));
});

describe("opening the task", () => {
  const TASK_PATH = "/tasks/SAGA/SAGA-55";

  it("makes the title the one link and the one tab stop", async () => {
    const { card } = await renderCard();

    const stops = [...card.querySelectorAll("a, button, [tabindex]")];
    expect(stops.map((stop) => stop.textContent)).toEqual(["Web: Tasks board"]);
    expect(stops[0]?.getAttribute("href")).toBe(TASK_PATH);
    expect(card.tabIndex).toBe(-1);
    expect(card.getAttribute("role")).toBeNull();
  });

  it("opens the task from the title", async () => {
    const user = userEvent.setup();
    const { router } = await renderCard();

    await user.click(screen.getByRole("link", { name: "Web: Tasks board" }));

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

    const id = screen.getByText("SAGA-55");
    window.getSelection()?.selectAllChildren(id);
    await act(async () => {
      fireEvent.click(id);
    });

    expect(router.state.location.pathname).toBe("/");
  });

  it("stays on the board when a modifier key is held", async () => {
    const { router } = await renderCard();

    await act(async () => {
      fireEvent.click(screen.getByText("SAGA-55"), { ctrlKey: true });
    });

    expect(router.state.location.pathname).toBe("/");
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

    expect(card.children).toHaveLength(2);
  });

  it("shows a stale step as its name alone", async () => {
    const { card } = await renderCard(entry(), { kind: "stale", name: "review" });

    const row = card.children[2]!;
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

    const [mark, name, spoken, segments] = [...card.children[2]!.children];
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

  expect(card.children).toHaveLength(2);
});
