import type { TransportReply } from "@tasma/protocol";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SEARCH_DELAY } from "../../src/components/search-field";
import { useUiStore } from "../../src/store/ui";
import { daemon, entry, listing } from "../board-fixtures";
import { heldBack, refusalReply, renderWithRouter } from "../helpers";

const ENTRIES = [entry(1, { title: "Fix the parser" }), entry(2, { title: "Write the docs" })];

const PARSER = listing([ENTRIES[0]!]);

async function renderBoard(search = "", replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  const { transport } = daemon({
    "/projects/SAGA/tasks": listing(ENTRIES),
    "/projects/SAGA/tasks?q=parser": PARSER,
    ...replies,
  });

  return renderWithRouter(`/tasks?projects=SAGA${search}`, transport);
}

function input(): HTMLInputElement {
  return screen.getByRole("searchbox", { name: "Search" });
}

function clearButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Clear search" });
}

function setUser() {
  return userEvent.setup({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) });
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage.clear();
  useUiStore.setState({ lastTasksProject: null, boardReturn: null, boardRestorePending: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("names the input by the visible label, in the toolbar between the project and the labels", async () => {
  await renderBoard();

  const field = input();
  const labels = screen.getByRole("combobox", { name: /^Labels/ });
  const project = screen.getByRole("button", { name: /^Project/ });

  expect(field.getAttribute("type")).toBe("text");
  expect(field.getAttribute("autocomplete")).toBe("off");
  expect(field.getAttribute("spellcheck")).toBe("false");
  expect(field.getAttribute("placeholder")).toBe("Id, title, body, comments");
  expect(project.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(field.compareDocumentPosition(labels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("writes q the search delay after the last key, trimmed, in place of the history entry", async () => {
  const user = setUser();
  const router = await renderBoard();
  const entries = router.history.length;

  await user.type(input(), "  pars");
  await wait(SEARCH_DELAY - 100);
  await user.type(input(), "er ");
  await wait(SEARCH_DELAY - 50);
  expect(router.state.location.search.q).toBeUndefined();

  await wait(50);
  expect(router.state.location.search.q).toBe("parser");
  expect(router.history.length).toBe(entries);
});

it("keeps a space typed after a word in the field after the write", async () => {
  const user = setUser();
  const router = await renderBoard();

  await user.type(input(), "parser ");
  await wait(SEARCH_DELAY);

  expect(router.state.location.search.q).toBe("parser");
  expect(input().value).toBe("parser ");
});

it("does not move the page scroll on a write", async () => {
  const user = setUser();
  const scrollTo = vi.fn();
  vi.stubGlobal("scrollTo", scrollTo);
  const router = await renderBoard();
  scrollTo.mockClear();

  await user.type(input(), "parser");
  await wait(SEARCH_DELAY);

  expect(router.state.location.search.q).toBe("parser");
  expect(scrollTo).not.toHaveBeenCalled();
});

it("writes at once on Enter", async () => {
  const user = setUser();
  const router = await renderBoard();

  await user.type(input(), "parser{Enter}");

  expect(router.state.location.search.q).toBe("parser");
});

it("leaves an Enter or an Escape that ends a composition to the input method", async () => {
  const user = setUser();
  const router = await renderBoard();

  await user.type(input(), "parser");
  fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
  fireEvent.keyDown(input(), { key: "Escape", isComposing: true });

  expect(router.state.location.search).toEqual({ projects: "SAGA" });
  expect(input().value).toBe("parser");
});

it("removes q for a text that is empty after the trim", async () => {
  const user = setUser();
  const router = await renderBoard("&q=parser");

  await user.clear(input());
  await user.type(input(), "   ");
  await wait(SEARCH_DELAY);

  expect(router.state.location.search).toEqual({ projects: "SAGA" });
});

it("shows the clear button only while the field holds text, and a press clears at once and focuses the input", async () => {
  const user = setUser();
  const router = await renderBoard();
  expect(clearButton()).toBeNull();

  await user.type(input(), "parser{Enter}");
  await user.click(clearButton()!);

  expect(router.state.location.search).toEqual({ projects: "SAGA" });
  expect(input().value).toBe("");
  expect(document.activeElement).toBe(input());
  expect(clearButton()).toBeNull();
});

it("clears on Escape at once, also before the delayed write", async () => {
  const user = setUser();
  const router = await renderBoard("&q=parser");

  await user.type(input(), " docs");
  await user.keyboard("{Escape}");

  expect(router.state.location.search).toEqual({ projects: "SAGA" });
  expect(input().value).toBe("");

  await wait(SEARCH_DELAY);
  expect(router.state.location.search).toEqual({ projects: "SAGA" });
});

it("does nothing on Escape in an empty field", async () => {
  const user = setUser();
  const router = await renderBoard();
  const before = router.state.location;
  const onKeyDown = vi.fn();
  document.addEventListener("keydown", onKeyDown);

  await user.click(input());
  await user.keyboard("{Escape}");
  document.removeEventListener("keydown", onKeyDown);

  expect(router.state.location).toBe(before);
  expect(onKeyDown).toHaveBeenCalledOnce();
});

it("stops an Escape that clears the field", async () => {
  const user = setUser();
  await renderBoard();
  const onKeyDown = vi.fn();

  await user.type(input(), "parser");
  document.addEventListener("keydown", onKeyDown);
  await user.keyboard("{Escape}");
  document.removeEventListener("keydown", onKeyDown);

  expect(onKeyDown).not.toHaveBeenCalled();
});

it("shows a q from the address", async () => {
  await renderBoard("&q=parser");

  expect(input().value).toBe("parser");
});

it("shows a q that changes from outside, and drops the write that was pending", async () => {
  const user = setUser();
  const router = await renderBoard("", { "/projects/SAGA/tasks?q=docs": listing([ENTRIES[1]!]) });

  await user.type(input(), "pars");
  await act(async () => {
    await router.navigate({ to: "/tasks", search: { projects: "SAGA", q: "docs" } });
  });
  expect(input().value).toBe("docs");

  await wait(SEARCH_DELAY);
  expect(router.state.location.search.q).toBe("docs");
  expect(input().value).toBe("docs");
});

it("writes no q to the next project when the project changes inside the delay, and empties the field", async () => {
  const user = setUser();
  const router = await renderBoard();

  await user.type(input(), "parser");
  await user.click(screen.getByRole("button", { name: /^Project/ }));
  await user.click(await screen.findByRole("menuitemradio", { name: /Delta/ }));
  await wait(SEARCH_DELAY);

  expect(router.state.location.search).toEqual({ projects: "DELTA" });
  expect(input().value).toBe("");
});

it("writes no q when the address leaves the project while the next board loads", async () => {
  const user = setUser();
  const delta = heldBack();
  const router = await renderBoard("", { "/projects/DELTA": delta.reply });

  await user.type(input(), "parser");
  void router.navigate({ to: "/tasks", search: { projects: "DELTA" } });
  await wait(SEARCH_DELAY);

  expect(router.latestLocation.search).toEqual({ projects: "DELTA" });
});

it("turns the magnifier into a turning spinner while the search request runs", async () => {
  const user = setUser();
  const held = heldBack();
  await renderBoard("", { "/projects/SAGA/tasks?q=parser": held.reply });
  const row = input().parentElement!;
  const icon = () => row.querySelector("svg")!;
  const magnifier = icon().innerHTML;

  expect(icon().classList.contains("animate-spin")).toBe(false);

  await user.type(input(), "parser{Enter}");
  expect(icon().innerHTML).not.toBe(magnifier);
  expect([...icon().classList]).toEqual(expect.arrayContaining(["animate-spin", "motion-reduce:animate-none"]));

  await act(async () => {
    held.answer(PARSER);
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(icon().innerHTML).toBe(magnifier);
  expect(icon().classList.contains("animate-spin")).toBe(false);
});

it("ties the failure line to the input while a search with no result fails", async () => {
  await renderBoard("&q=parser", {
    "/projects/SAGA/tasks?q=parser": refusalReply(422, { kind: "store", code: "project-invalid", message: "broken" }),
  });
  await wait(10);

  const line = screen.getByText("The search failed. The board shows all tasks.", { selector: "p" });
  expect(input().getAttribute("aria-describedby")).toBe(line.id);
  expect(line.classList.contains("text-muted")).toBe(true);
});

it("describes the input by nothing while the search has not failed", async () => {
  await renderBoard("&q=parser");
  await wait(10);

  expect(input().hasAttribute("aria-describedby")).toBe(false);
});
