import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUiStore } from "../../src/store/ui";
import { renderWithRouter, stubTransport, successReply } from "../helpers";

const PROJECTS = [
  { tag: "TASM", name: "Tasma", path: "/repos/tasma" },
  { tag: "CLIB" },
  { tag: "DOBBY", name: "Dobby", path: "/repos/dobby" },
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

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ lastTasksProject: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("names the trigger with its label, the project's name and its tag", async () => {
  await renderBoard("/tasks?projects=TASM");

  expect(screen.getByRole("button", { name: "Project Tasma TASM" })).toBeTruthy();
});

it("names the trigger with the tag alone for a project with no name", async () => {
  await renderBoard("/tasks?projects=CLIB");

  expect(screen.getByRole("button", { name: "Project CLIB" })).toBeTruthy();
});

it("lists the projects in the daemon's order with the current one checked", async () => {
  const user = userEvent.setup();
  await renderBoard("/tasks?projects=TASM");

  await user.click(screen.getByRole("button", { name: "Project Tasma TASM" }));

  const items = await screen.findAllByRole("menuitemradio");
  expect(items.map((item) => item.textContent)).toEqual(["Tasma TASM", "CLIB", "Dobby DOBBY"]);
  expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
});

it("lets a long name grow the trigger and the menu items down, and keeps the menu inside the viewport", async () => {
  const user = userEvent.setup();
  await renderBoard("/tasks?projects=TASM");

  const trigger = screen.getByRole("button", { name: "Project Tasma TASM" });
  expect(trigger.classList.contains("min-h-8")).toBe(true);
  expect(trigger.classList.contains("h-8")).toBe(false);
  expect(trigger.firstElementChild?.textContent).toBe("Tasma TASM");
  expect(trigger.firstElementChild?.classList.contains("wrap-anywhere")).toBe(true);

  await user.click(trigger);
  const menu = await screen.findByRole("menu");
  expect(menu.classList.contains("max-w-(--available-width)")).toBe(true);
  const [item] = within(menu).getAllByRole("menuitemradio");
  expect(item?.classList.contains("min-h-8")).toBe(true);
  expect(item?.classList.contains("h-8")).toBe(false);
  expect(item?.lastElementChild?.textContent).toBe("Tasma TASM");
});

it("opens another project with no labels, and closes the menu", async () => {
  const user = userEvent.setup();
  const router = await renderBoard("/tasks?projects=TASM&labels=web");

  await user.click(screen.getByRole("button", { name: "Project Tasma TASM" }));
  const menu = await screen.findByRole("menu");
  await act(async () => {
    await user.click(within(menu).getByRole("menuitemradio", { name: "Dobby DOBBY" }));
  });

  expect(router.state.location.search).toEqual({ projects: "DOBBY" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  expect(screen.getByRole("button", { name: "Project Dobby DOBBY" })).toBeTruthy();
});
