import type { Frontmatter, TaskEntry } from "@tasma/protocol";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUiStore } from "../../src/store/ui";
import { renderWithRouter, stubTransport, successReply } from "../helpers";

const CONFIG = {
  statuses: ["Backlog", "Done"],
  default_status: "Backlog",
  final_statuses: ["Done"],
  priorities: ["high", "low"],
  workflows: [],
  instructions: [],
};

function entry(number: number, labels?: string[]): TaskEntry {
  const id = `SAGA-${String(number)}`;
  const frontmatter: Frontmatter = {
    id,
    title: `Task ${String(number)}`,
    status: "Backlog",
    created: "2026-09-01T10:00:00Z",
    updated: "2026-09-01T10:00:00Z",
    next_comment_id: 1,
    ...(labels === undefined ? {} : { labels }),
  };

  return { id, path: `/tasks/${id}.md`, blocked: false, frontmatter };
}

const ENTRIES = [entry(1, ["web", "infra"]), entry(2, ["web"]), entry(3, ["api"]), entry(4)];

function renderBoard(search: string, entries: TaskEntry[] = ENTRIES) {
  const { transport } = stubTransport({
    "/projects": successReply([{ tag: "SAGA", name: "Saga" }]),
    "/projects/SAGA": successReply({ tag: "SAGA", name: "Saga", live: true, config: CONFIG }),
    "/projects/SAGA/tasks": successReply({ entries, excluded: [] }),
  });

  return renderWithRouter(`/tasks?projects=SAGA${search}`, transport);
}

function trigger(): HTMLElement {
  return screen.getByRole("combobox", { name: /^Labels/ });
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  return screen.findByRole("listbox");
}

/** Each option as its label and its count. */
function options(): [string | null, string | null][] {
  return screen.queryAllByRole("option").map((option) => [
    option.childNodes[2]?.textContent ?? null,
    option.lastElementChild?.textContent ?? null,
  ]);
}

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ lastTasksProject: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reads Any while no label is selected", async () => {
  await renderBoard("");

  expect(trigger().textContent).toBe("Any");
  expect(trigger().getAttribute("aria-labelledby")?.split(" ")).toHaveLength(2);
});

it("reads the selected labels, joined", async () => {
  await renderBoard("&labels=web,api");

  expect(trigger().textContent).toBe("web, api");
  expect(screen.getByRole("combobox", { name: "Labels web, api" })).toBeTruthy();
});

it("names the popup, the filter input and the list by the visible label", async () => {
  const user = userEvent.setup();
  await renderBoard("");

  const listbox = await open(user);

  expect(listbox).toBe(screen.getByRole("listbox", { name: "Labels" }));
  expect(screen.getByRole("dialog", { name: "Labels" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Labels" })).toBe(screen.getByPlaceholderText("Filter labels"));
});

it("draws the focus ring of the filter input on its field", async () => {
  const user = userEvent.setup();
  await renderBoard("");
  await open(user);

  const input = screen.getByPlaceholderText("Filter labels");
  expect(input.classList.contains("focus-visible:outline-none")).toBe(true);
  expect([...input.parentElement!.classList]).toEqual(
    expect.arrayContaining(["has-focus-visible:outline-3", "has-focus-visible:outline-offset-2", "has-focus-visible:outline-graphic"]),
  );
});

it("lists and reads a label repeated in the address once", async () => {
  const user = userEvent.setup();
  await renderBoard("&labels=docs,DOCS,docs");

  expect(trigger().textContent).toBe("docs");
  await open(user);

  expect(options()).toEqual([["api", "1"], ["infra", "1"], ["web", "2"], ["docs", "0"]]);
});

it("lets a long label wrap inside its item and grow the item down, with the count kept", async () => {
  const user = userEvent.setup();
  const label = "infrastructureautomationpipelinestagingeurope";
  await renderBoard("", [entry(1, [label])]);

  await open(user);

  const option = screen.getByRole("option", { name: new RegExp(label) });
  expect([...option.classList]).toEqual(expect.arrayContaining(["min-h-8", "py-1"]));
  expect(option.classList.contains("h-8")).toBe(false);
  const text = within(option).getByText(label);
  expect([...text.classList]).toEqual(expect.arrayContaining(["min-w-0", "wrap-anywhere"]));
  expect(text.nextElementSibling?.textContent).toBe("1");
});

it("lists every label of the project with its count, in order", async () => {
  const user = userEvent.setup();
  await renderBoard("");

  await open(user);

  expect(options()).toEqual([["api", "1"], ["infra", "1"], ["web", "2"]]);
});

it("filters the labels by the text typed, ignoring case", async () => {
  const user = userEvent.setup();
  await renderBoard("");
  await open(user);

  await user.type(screen.getByPlaceholderText("Filter labels"), "FR");

  expect(options()).toEqual([["infra", "1"]]);
});

it("says no label matches the text typed", async () => {
  const user = userEvent.setup();
  await renderBoard("");
  await open(user);

  await user.type(screen.getByPlaceholderText("Filter labels"), "zzz");

  expect(options()).toEqual([]);
  expect(screen.getByText(/^No label matches/)).toBeTruthy();
});

it("says the project has no labels", async () => {
  const user = userEvent.setup();
  await renderBoard("", [entry(1)]);

  await open(user);

  expect(options()).toEqual([]);
  expect(screen.getByText(/^No labels in this project/)).toBeTruthy();
});

it("writes a checked label to the address as the label itself", async () => {
  const user = userEvent.setup();
  const router = await renderBoard("&labels=web");
  const listbox = await open(user);

  await act(async () => {
    await user.click(within(listbox).getByRole("option", { name: /infra/ }));
  });

  expect(router.state.location.search).toEqual({ projects: "SAGA", labels: "web,infra" });
  expect(router.state.location.href).toContain("labels=web,infra");
});

it("removes the key when the last label is unchecked", async () => {
  const user = userEvent.setup();
  const router = await renderBoard("&labels=web");
  const listbox = await open(user);

  await act(async () => {
    await user.click(within(listbox).getByRole("option", { name: /web/ }));
  });

  expect(router.state.location.search).toEqual({ projects: "SAGA" });
});

it("checks a label selected in another case, with no second item", async () => {
  const user = userEvent.setup();
  await renderBoard("&labels=WEB");

  const listbox = await open(user);

  expect(options()).toEqual([["api", "1"], ["infra", "1"], ["web", "2"]]);
  expect(within(listbox).getByRole("option", { name: /web/ }).getAttribute("aria-selected")).toBe("true");
});

it("lists a selected label that no task carries, with count 0", async () => {
  const user = userEvent.setup();
  await renderBoard("&labels=docs");

  const listbox = await open(user);

  expect(options()).toEqual([["api", "1"], ["infra", "1"], ["web", "2"], ["docs", "0"]]);
  expect(within(listbox).getByRole("option", { name: /docs/ }).getAttribute("aria-selected")).toBe("true");
});
