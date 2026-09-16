import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUiStore } from "../../src/store/ui";
import { renderWithRouter, stubTransport, successReply } from "../helpers";

const PROJECTS = [
  { tag: "SAGA", name: "Saga", path: "/repos/saga" },
  { tag: "ACME" },
  { tag: "DELTA", name: "Delta", path: "/repos/delta" },
];

const CONFIG = {
  statuses: ["Backlog", "Done"],
  default_status: "Backlog",
  final_statuses: ["Done"],
  priorities: ["high", "low"],
  workflows: [],
  instructions: [],
};

/** Every project of the listing answers with the same configuration and no task. */
function renderBoard(path: string) {
  const replies = Object.fromEntries(
    PROJECTS.flatMap((project) => [
      [`/projects/${project.tag}`, successReply({ ...project, live: true, config: CONFIG })],
      [`/projects/${project.tag}/tasks`, successReply({ entries: [], excluded: [] })],
    ]),
  );
  const { transport } = stubTransport({ "/projects": successReply(PROJECTS), ...replies });

  return renderWithRouter(path, transport);
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await renderBoard("/tasks");
  await user.click(screen.getByRole("button", { name: /^Project / }));

  return screen.findByRole("menu");
}

function highlighted(menu: HTMLElement): HTMLElement[] {
  return within(menu).getAllByRole("menuitemradio").filter((item) => item.hasAttribute("data-highlighted"));
}

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ lastTasksProject: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("names the trigger with its label, the project's name and its tag", async () => {
  await renderBoard("/tasks?projects=SAGA");

  expect(screen.getByRole("button", { name: "Project Saga SAGA" })).toBeTruthy();
});

it("names the trigger with the tag alone for a project with no name", async () => {
  await renderBoard("/tasks?projects=ACME");

  expect(screen.getByRole("button", { name: "Project ACME" })).toBeTruthy();
});

it("lists the projects in the daemon's order with the current one checked", async () => {
  const user = userEvent.setup();
  await renderBoard("/tasks?projects=SAGA");

  await user.click(screen.getByRole("button", { name: "Project Saga SAGA" }));

  const items = await screen.findAllByRole("menuitemradio");
  expect(items.map((item) => item.textContent)).toEqual(["Saga SAGA", "ACME", "Delta DELTA"]);
  expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
});

it("lets a long name grow the trigger and the menu items down, and keeps the menu inside the viewport", async () => {
  const user = userEvent.setup();
  await renderBoard("/tasks?projects=SAGA");

  const trigger = screen.getByRole("button", { name: "Project Saga SAGA" });
  expect(trigger.classList.contains("min-h-8")).toBe(true);
  expect(trigger.classList.contains("h-8")).toBe(false);
  expect(trigger.firstElementChild?.textContent).toBe("Saga SAGA");
  expect(trigger.firstElementChild?.classList.contains("wrap-anywhere")).toBe(true);

  await user.click(trigger);
  const menu = await screen.findByRole("menu");
  expect(menu.classList.contains("max-w-(--available-width)")).toBe(true);
  const [item] = within(menu).getAllByRole("menuitemradio");
  expect(item?.classList.contains("min-h-8")).toBe(true);
  expect(item?.classList.contains("h-8")).toBe(false);
  expect(item?.lastElementChild?.textContent).toBe("Saga SAGA");
});

it("highlights an item on the arrow keys, not on hover", async () => {
  const user = userEvent.setup();
  const menu = await openMenu(user);

  await user.hover(within(menu).getAllByRole("menuitemradio")[1]!);

  expect(highlighted(menu)).toEqual([]);

  await user.keyboard("{ArrowDown}");

  expect(highlighted(menu)).toHaveLength(1);
});

it("marks a hovered item by its background, and a highlighted item by the ring unless the mouse holds it", async () => {
  const user = userEvent.setup();
  const menu = await openMenu(user);

  const [item] = within(menu).getAllByRole("menuitemradio");
  expect([...item!.classList]).toEqual(
    expect.arrayContaining([
      "hover:bg-surface-2",
      "data-[highlighted]:outline-3",
      "data-[highlighted]:outline-graphic",
      "data-[highlighted]:active:outline-hidden",
    ]),
  );
});

it("opens another project with no labels, and closes the menu", async () => {
  const user = userEvent.setup();
  const router = await renderBoard("/tasks?projects=SAGA&labels=web");

  await user.click(screen.getByRole("button", { name: "Project Saga SAGA" }));
  const menu = await screen.findByRole("menu");
  await act(async () => {
    await user.click(within(menu).getByRole("menuitemradio", { name: "Delta DELTA" }));
  });

  expect(router.state.location.search).toEqual({ projects: "DELTA" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  expect(screen.getByRole("button", { name: "Project Delta DELTA" })).toBeTruthy();
});
