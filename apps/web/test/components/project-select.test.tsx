import type { TaskEntry } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PICKER_ITEM_CLASS } from "../../src/components/property-picker";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { heldBack, renderWithRouter, stubTransport, successReply } from "../helpers";

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

const TASK: TaskEntry = {
  id: "SAGA-1",
  path: "/tasks/SAGA-1.md",
  blocked: false,
  frontmatter: {
    id: "SAGA-1",
    title: "Fix the parser",
    status: "Backlog",
    created: "2026-09-01T10:00:00Z",
    updated: "2026-09-01T10:00:00Z",
    next_comment_id: 1,
  },
};

/** Every project of the listing answers with the same configuration; SAGA holds one task. */
function boardDaemon() {
  const replies = Object.fromEntries(
    PROJECTS.flatMap((project) => [
      [`/projects/${project.tag}`, successReply({ ...project, live: true, config: CONFIG })],
      [`/projects/${project.tag}/tasks`, successReply({ entries: project.tag === "SAGA" ? [TASK] : [], excluded: [] })],
    ]),
  );

  return stubTransport({ "/projects": successReply(PROJECTS), ...replies });
}

function renderBoard(path: string) {
  return renderWithRouter(path, boardDaemon().transport);
}

/** The filter input of the open popup is a combobox named `Project` too. */
function trigger(): HTMLElement {
  return screen.getByRole("combobox", { name: /^Project \S/ });
}

async function open(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(trigger());
  return screen.findByRole("listbox");
}

function options(): (string | null)[] {
  return screen.queryAllByRole("option").map((option) => option.textContent);
}

function checks(): (string | null)[] {
  return screen.getAllByRole("option").map((option) => option.getAttribute("aria-selected"));
}

function option(name: string): HTMLElement {
  return screen.getByRole("option", { name });
}

function highlighted(listbox: HTMLElement): HTMLElement[] {
  return within(listbox).getAllByRole("option").filter((item) => item.hasAttribute("data-highlighted"));
}

function announced(): string[] {
  return useNoticeStore.getState().announced.map(({ words }) => words);
}

async function pick(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await act(async () => {
    await user.click(option(name));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ lastTasksProject: null, lastBoard: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  { path: "/tasks?projects=SAGA", name: "Project Saga SAGA" },
  { path: "/tasks?projects=ACME", name: "Project ACME" },
  { path: "/tasks?projects=SAGA,DELTA", name: "Project Delta, Saga" },
  { path: "/tasks?projects=ACME,SAGA", name: "Project ACME, Saga" },
  { path: "/tasks?projects=all", name: "Project All projects" },
])("names the trigger of $path with its label and its value", async ({ path, name }) => {
  await renderBoard(path);

  expect(screen.getByRole("combobox", { name })).toBe(trigger());
  expect(trigger().getAttribute("aria-labelledby")?.split(" ")).toHaveLength(2);
});

it("lists All projects, then the projects in the daemon's order, with the board's projects checked", async () => {
  const user = userEvent.setup();
  await renderBoard("/tasks?projects=DELTA,SAGA");

  await open(user);

  expect(options()).toEqual(["All projects", "Saga SAGA", "ACME", "Delta DELTA"]);
  expect(checks()).toEqual(["false", "true", "false", "true"]);
});

it("checks All projects alone on the board of all projects", async () => {
  const user = userEvent.setup();
  await renderBoard("/tasks?projects=all");

  await open(user);

  expect(checks()).toEqual(["true", "false", "false", "false"]);
});

it("names the popup, the filter input and the list by the visible label", async () => {
  const user = userEvent.setup();
  await renderBoard("/tasks?projects=SAGA");

  const listbox = await open(user);

  expect(listbox).toBe(screen.getByRole("listbox", { name: "Project" }));
  expect(screen.getByRole("dialog", { name: "Project" }).classList.contains("w-62")).toBe(true);
  expect(screen.getByRole("combobox", { name: "Project" })).toBe(screen.getByPlaceholderText("Filter projects"));
  expect(listbox.classList.contains("max-h-72")).toBe(true);
});

it("lets a long name of one project wrap in the trigger and the items, and cuts a list of names", async () => {
  const user = userEvent.setup();
  await renderBoard("/tasks?projects=SAGA");

  expect(trigger().classList.contains("min-h-8")).toBe(true);
  expect(trigger().firstElementChild?.textContent).toBe("Saga SAGA");
  expect(trigger().firstElementChild?.classList.contains("wrap-anywhere")).toBe(true);
  await open(user);
  const item = option("Saga SAGA");
  expect(item.className).toBe(PICKER_ITEM_CLASS);
  expect(item.lastElementChild?.classList.contains("wrap-anywhere")).toBe(true);
  cleanup();

  await renderBoard("/tasks?projects=DELTA,SAGA");

  expect([...trigger().firstElementChild!.classList]).toEqual(expect.arrayContaining(["max-w-64", "truncate"]));
});

it("highlights the checked item on open, and another item on the arrow keys, not on hover", async () => {
  const user = userEvent.setup();
  await renderBoard("/tasks?projects=SAGA");
  const listbox = await open(user);

  expect(highlighted(listbox)).toEqual([option("Saga SAGA")]);

  await user.hover(option("ACME"));

  expect(highlighted(listbox)).toEqual([option("Saga SAGA")]);

  await user.keyboard("{ArrowDown}");

  expect(highlighted(listbox)).toEqual([option("ACME")]);
});

it("marks a hovered item by its background and a highlighted item by the ring the pickers draw", async () => {
  const user = userEvent.setup();
  await renderBoard("/tasks?projects=SAGA");
  await open(user);

  expect([...option("ACME").classList]).toEqual(
    expect.arrayContaining([
      "hover:bg-surface-2",
      "data-[highlighted]:outline-2",
      "data-[highlighted]:-outline-offset-2",
      "data-[highlighted]:outline-focus",
    ]),
  );
});

it("adds a project, keeps the labels and the search text, and stays open", async () => {
  const user = userEvent.setup();
  const router = await renderBoard("/tasks?projects=SAGA&labels=web&q=fix");
  const listbox = await open(user);

  await pick(user, "Delta DELTA");

  expect(router.state.location.search).toEqual({ projects: "DELTA,SAGA", labels: "web", q: "fix" });
  expect(screen.getByRole("listbox")).toBe(listbox);
  await waitFor(() => {
    expect(trigger().textContent).toBe("Delta, Saga");
  });
});

it("removes a checked project, and opens all projects on the removal of the last one", async () => {
  const user = userEvent.setup();
  const router = await renderBoard("/tasks?projects=DELTA,SAGA");
  await open(user);

  await pick(user, "Delta DELTA");

  expect(router.state.location.search).toEqual({ projects: "SAGA" });

  await pick(user, "Saga SAGA");

  expect(router.state.location.search).toEqual({ projects: "all" });
  expect(option("All projects").getAttribute("aria-selected")).toBe("true");
});

it("opens only the clicked project on the board of all projects", async () => {
  const user = userEvent.setup();
  const router = await renderBoard("/tasks?projects=all");
  await open(user);

  await pick(user, "Delta DELTA");

  expect(router.state.location.search).toEqual({ projects: "DELTA" });
  expect(checks()).toEqual(["false", "false", "false", "true"]);
});

it("opens all projects on a click on All projects", async () => {
  const user = userEvent.setup();
  const router = await renderBoard("/tasks?projects=DELTA,SAGA&labels=web");
  await open(user);

  await pick(user, "All projects");

  expect(router.state.location.search).toEqual({ projects: "all", labels: "web" });
});

it("does not navigate or speak on a click on All projects on the board of all projects", async () => {
  const user = userEvent.setup();
  const router = await renderBoard("/tasks?projects=all");
  const before = router.history.length;
  await open(user);

  await pick(user, "All projects");

  expect(router.state.location.search).toEqual({ projects: "all" });
  expect(router.history.length).toBe(before);
  expect(option("All projects").getAttribute("aria-selected")).toBe("true");
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
  expect(announced()).toEqual([]);
});

it("adds a history entry for each change, so Back returns to the previous selection", async () => {
  const user = userEvent.setup();
  const router = await renderBoard("/tasks?projects=SAGA");
  await open(user);

  await pick(user, "Delta DELTA");
  act(() => {
    router.history.back();
  });

  await waitFor(() => {
    expect(router.state.location.search).toEqual({ projects: "SAGA" });
  });
});

it("applies two clicks made before the first board loads, and checks each at once", async () => {
  const user = userEvent.setup();
  const stub = boardDaemon();
  const delta = heldBack();
  stub.replies["/projects/DELTA/tasks"] = delta.reply;
  const router = await renderWithRouter("/tasks?projects=SAGA", stub.transport);
  await open(user);

  await pick(user, "Delta DELTA");

  expect(option("Delta DELTA").getAttribute("aria-selected")).toBe("true");
  expect(trigger().textContent).toBe("Delta, Saga");

  await pick(user, "ACME");

  expect(router.state.location.search).toEqual({ projects: "ACME,DELTA,SAGA" });
  expect(checks()).toEqual(["false", "true", "true", "true"]);
  await waitFor(() => {
    expect(announced()).toEqual(["Delta, Saga.", "ACME, Delta, Saga."]);
  });

  act(() => {
    delta.answer(successReply({ entries: [], excluded: [] }));
  });

  await waitFor(() => {
    expect(router.state.status).toBe("idle");
  });
  expect(router.state.location.search).toEqual({ projects: "ACME,DELTA,SAGA" });
  expect(trigger().textContent).toBe("ACME, Delta, Saga");
});

it.each([
  { path: "/tasks?projects=SAGA", name: "Delta DELTA", words: "Delta, Saga." },
  { path: "/tasks?projects=SAGA", name: "Saga SAGA", words: "All projects." },
  { path: "/tasks?projects=all", name: "Saga SAGA", words: "Saga SAGA." },
  { path: "/tasks?projects=all", name: "ACME", words: "ACME." },
])("announces the new value after a click on $name on $path", async ({ path, name, words }) => {
  const user = userEvent.setup();
  await renderBoard(path);
  await open(user);

  await pick(user, name);

  await waitFor(() => {
    expect(announced()).toEqual([words]);
  });
});

it("keeps the names of the board in the trigger while a card's task page loads", async () => {
  const user = userEvent.setup();
  const stub = boardDaemon();
  const task = heldBack();
  stub.replies["/projects/SAGA/tasks/SAGA-1"] = task.reply;
  stub.replies["/projects/SAGA/tasks/SAGA-1/chats"] = successReply([]);
  const router = await renderWithRouter("/tasks?projects=DELTA,SAGA", stub.transport);

  await act(async () => {
    await user.click(within(screen.getByText("Fix the parser").closest<HTMLElement>("[data-task-id]")!).getByRole("link"));
  });

  expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-1");
  expect(trigger().textContent).toBe("Delta, Saga");
});

it.each([
  { name: "ACME", projects: "ACME,DELTA,SAGA", words: "ACME, Delta, Saga." },
  { name: "Saga SAGA", projects: "DELTA", words: "Delta DELTA." },
])("builds a click on $name on the board while a card's task page loads", async ({ name, projects, words }) => {
  const user = userEvent.setup();
  const stub = boardDaemon();
  const labelled = { ...TASK, frontmatter: { ...TASK.frontmatter, labels: ["web"] } };
  stub.replies["/projects/SAGA/tasks"] = successReply({ entries: [labelled], excluded: [] });
  stub.replies["/projects/SAGA/tasks/SAGA-1"] = heldBack().reply;
  stub.replies["/projects/SAGA/tasks/SAGA-1/chats"] = successReply([]);
  const router = await renderWithRouter("/tasks?projects=DELTA,SAGA&labels=web&q=fix", stub.transport);
  await act(async () => {
    await user.click(within(screen.getByText("Fix the parser").closest<HTMLElement>("[data-task-id]")!).getByRole("link"));
  });
  await open(user);

  await pick(user, name);

  await waitFor(() => {
    expect(router.state.status).toBe("idle");
  });
  expect(router.state.location.pathname).toBe("/tasks");
  expect(router.state.location.search).toEqual({ projects, labels: "web", q: "fix" });
  expect(announced()).toEqual([words]);
});

it("filters the items by a name or a tag, without case", async () => {
  const user = userEvent.setup();
  await renderBoard("/tasks?projects=SAGA");
  await open(user);
  const input = screen.getByPlaceholderText("Filter projects");

  await user.type(input, "delTA");
  expect(options()).toEqual(["Delta DELTA"]);

  await user.clear(input);
  await user.type(input, "acm");
  expect(options()).toEqual(["ACME"]);

  await user.clear(input);
  await user.type(input, "all p");
  expect(options()).toEqual(["All projects"]);

  await user.clear(input);
  await user.type(input, "zzz");
  expect(options()).toEqual([]);
  expect(screen.getByText("No project matches")).toBeTruthy();
});

it("lists a tag of the address that the project list does not hold, checked, after the projects", async () => {
  const user = userEvent.setup();
  const router = await renderBoard("/tasks?projects=NOPE,SAGA");
  await open(user);

  expect(options()).toEqual(["All projects", "Saga SAGA", "ACME", "Delta DELTA", "NOPE"]);
  expect(checks()).toEqual(["false", "true", "false", "false", "true"]);

  await user.type(screen.getByPlaceholderText("Filter projects"), "nop");
  expect(options()).toEqual(["NOPE"]);

  await pick(user, "NOPE");

  expect(router.state.location.search).toEqual({ projects: "SAGA" });
});

it("drops the row of an unlisted tag removed with Enter, and highlights a row that stays on the next arrow key", async () => {
  const user = userEvent.setup();
  const router = await renderBoard("/tasks?projects=NOPE,SAGA");
  const listbox = await open(user);
  const input = screen.getByPlaceholderText("Filter projects");

  await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  expect(highlighted(listbox)).toEqual([option("NOPE")]);

  await act(async () => {
    await user.keyboard("{Enter}");
  });

  expect(router.state.location.search).toEqual({ projects: "SAGA" });
  expect(options()).toEqual(["All projects", "Saga SAGA", "ACME", "Delta DELTA"]);
  expect(highlighted(listbox)).toEqual([]);
  expect(document.activeElement).toBe(input);

  await user.keyboard("{ArrowDown}");

  expect(highlighted(listbox)).toHaveLength(1);
});
