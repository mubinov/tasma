import type { Comment } from "@tasma/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ICON_BUTTON_CLASS } from "../../src/components/control-classes";
import { FindShortcut } from "../../src/components/find-shortcut";
import { renderMermaid } from "../../src/lib/mermaid";
import { FIND_ANNOUNCE_DELAY, LONG_TEXT, NEARBY_MATCHES } from "../../src/lib/use-task-find";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import {
  renderWithRouter,
  stubHighlights,
  stubIntersectionObserver,
  stubRangeBoxes,
  stubReducedMotion,
  stubSystemTheme,
  stubResizeObservers,
} from "../helpers";
import { TASK_PATH, caret, comment, commentCard, daemon, task, topBar } from "../task-screen-fixtures";

vi.mock(import("../../src/lib/mermaid"), () => ({ renderMermaid: vi.fn(() => new Promise<never>(() => {})) }));

const PAGE = "/tasks/SAGA/SAGA-3";

const ANNOUNCE = useNoticeStore.getState().announce;

let highlights: ReturnType<typeof stubHighlights>;
let announce: ReturnType<typeof vi.fn<(words: string) => void>>;
let scrollTo: ReturnType<typeof vi.fn<(options: ScrollToOptions) => void>>;

type PageParts = { title?: string; body?: string; comments?: Comment[] };

async function openPage({ title, body = "", comments = [] }: PageParts = {}) {
  const daemonStub = daemon({ [TASK_PATH]: task({ fields: title === undefined ? {} : { title }, body, comments }) });
  const router = await renderWithRouter(PAGE, daemonStub.transport);
  return { ...daemonStub, router };
}

function findButton(): HTMLElement {
  return screen.getByRole("button", { name: "Find in task" });
}

function row(): HTMLElement | null {
  return screen.queryByRole("search", { name: "Find" });
}

function findField(): HTMLInputElement {
  return within(row()!).getByRole("searchbox");
}

function counter(): string | null {
  return document.getElementById(findField().getAttribute("aria-describedby")!)?.textContent ?? null;
}

function current(): string[] | undefined {
  return highlights.texts("task-find-current");
}

function others(): string[] | undefined {
  return highlights.texts("task-find");
}

function writes(requests: readonly { method: string }[]): number {
  return requests.filter(({ method }) => method !== "GET").length;
}

/** The scroll calls a move to a match made, without the row's own open and close scrolls. */
function matchScrolls(): unknown[] {
  return scrollTo.mock.calls.map(([options]) => options).filter((options) => options.behavior !== "instant");
}

async function openFind(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(findButton());
  await user.type(findField(), text);
}

/** Turns on fake timers for the test, and gives a user that advances them. */
function userWithFakeTimers() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) });
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Gives each element the box `box` names, and the empty box of jsdom to the others. */
function stubElementBoxes(box: (element: HTMLElement) => Partial<DOMRect>) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, ...box(this) } as DOMRect;
  });
}

/**
 * Types the text and presses the keys outside act. There React renders the text
 * at once and the deferred result of the text in a later task, so the keys come
 * before that result.
 */
async function keysBeforeResult(text: string, keys: readonly KeyboardEventInit[]) {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    const field = findField();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    const before = counter();
    for (const key of keys) {
      field.dispatchEvent(new KeyboardEvent("keydown", { ...key, bubbles: true }));
    }
    await Promise.resolve();
    expect(counter()).toBe(before);
    await waitFor(() => {
      expect(counter()).not.toBe(before);
    });
  } finally {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ boardReturn: null, boardRestorePending: false, modalDialogs: 0 });
  highlights = stubHighlights();
  stubRangeBoxes();
  stubSystemTheme("light");
  scrollTo = vi.fn<(options: ScrollToOptions) => void>();
  vi.stubGlobal("scrollTo", scrollTo);
  announce = vi.fn<(words: string) => void>();
  useNoticeStore.setState({ announce });
  vi.mocked(renderMermaid).mockClear();
});

afterEach(() => {
  cleanup();
  useNoticeStore.setState({ announce: ANNOUNCE });
  document.documentElement.style.removeProperty("--page-scroll-padding");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the find button", () => {
  it("sits before Edit, names its key, and controls the row only while the row is open", async () => {
    const user = userEvent.setup();
    await openPage();

    const button = findButton();
    expect(button.nextElementSibling?.textContent).toBe("Edit");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+F");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);
    expect(row()).toBeNull();

    await user.click(button);

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(row()!.id);
    expect(document.activeElement).toBe(findField());
  });

  it("shows the key in its tooltip", async () => {
    const user = userEvent.setup();
    await openPage();

    await user.hover(findButton());

    expect(await screen.findByText("Find in task ⌘F")).toBeTruthy();
  });

  it("closes the row on a second press and calls focus on itself, which a pointer press does not give", async () => {
    await openPage();
    const button = findButton();
    const focus = vi.spyOn(button, "focus");

    fireEvent.click(button);
    expect(row()).not.toBeNull();
    fireEvent.click(button);

    expect(row()).toBeNull();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(button);
  });

  it("puts focus in the field without a focus scroll, which the sticky bar would turn into a page scroll", async () => {
    await openPage();
    const focus = vi.spyOn(HTMLInputElement.prototype, "focus");

    fireEvent.click(findButton());

    expect(focus.mock.contexts).toContain(findField());
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("hides while the task editor is open, which closes the row; Cmd+F then does nothing", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    await openFind(user, "alpha");
    expect(current()).toEqual(["alpha"]);

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(row()).toBeNull();
    expect(current()).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Find in task" })).toBeNull();
    act(() => {
      useUiStore.getState().requestFind();
    });
    expect(row()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(findButton().getAttribute("aria-expanded")).toBe("false");
    expect(row()).toBeNull();
  });
});

describe("Cmd+F", () => {
  it("opens the row with focus in the field, and selects the text of an open row", async () => {
    const user = userEvent.setup();
    const { router } = await openPage({ body: "alpha" });
    render(<FindShortcut router={router} />);

    await user.keyboard("{Meta>}f{/Meta}");

    expect(document.activeElement).toBe(findField());
    await user.type(findField(), "alpha");
    findButton().focus();

    await user.keyboard("{Meta>}f{/Meta}");

    expect(document.activeElement).toBe(findField());
    expect([findField().selectionStart, findField().selectionEnd]).toEqual([0, 5]);
  });
});

describe("the row", () => {
  it("is the second line of the bar: the label, the field, the counter, Previous, Next and Close", async () => {
    const user = userEvent.setup();
    await openPage();

    await user.click(findButton());

    const search = row()!;
    expect(search.parentElement).toBe(topBar());
    expect(search.previousElementSibling?.classList.contains("h-top-bar")).toBe(true);
    expect(search.classList.contains("flex-wrap")).toBe(true);
    expect(search.classList.contains("border-t")).toBe(true);
    expect(search.hasAttribute("data-find-row")).toBe(true);
    const field = findField();
    expect(field.getAttribute("type")).toBe("text");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("spellcheck")).toBe("false");
    expect(field.parentElement?.classList.contains("min-w-32")).toBe(true);
    const description = document.getElementById(field.getAttribute("aria-describedby")!);
    expect(description?.getAttribute("aria-hidden")).toBe("true");
    expect(within(search).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Previous match",
      "Next match",
      "Close find",
    ]);
    expect(within(search).getByRole("button", { name: "Close find" }).className).toBe(ICON_BUTTON_CLASS);
  });

  it("gives the page its scroll padding, with the row's height, only while focus is outside the bar", async () => {
    await openPage();

    const classes = [...topBar().classList];
    expect(classes).toContain("[html:has(&)]:[--page-scroll-padding:calc(--spacing(16)+var(--find-row-height,0px))]");
    expect(classes).toContain("[html:has(&:not(:focus-within))]:scroll-pt-(--page-scroll-padding)");
    expect(classes.filter((name) => name.includes("scroll-pt"))).toHaveLength(1);
  });

  it("changes the root's min-height, which a block root does not use, each time the scroll padding changes", async () => {
    await openPage();

    const classes = [...topBar().classList];
    expect(classes).toContain("[html:has(&:focus-within)]:min-h-px");
    expect(classes.filter((name) => name.includes("min-h"))).toHaveLength(1);
  });

  it("sets its height on the page while it is open, reads the scroll padding again on a resize, and removes it on close", async () => {
    const user = userEvent.setup();
    const io = stubIntersectionObserver();
    const resize = stubResizeObservers();
    let rowHeight = 41;
    stubElementBoxes((element) => ({ height: element.hasAttribute("data-find-row") ? rowHeight : 0 }));
    document.documentElement.style.setProperty("--page-scroll-padding", "64px");
    await openPage({ body: "## Plan" });
    resize.report(topBar());
    const plan = screen.getByRole("heading", { level: 2, name: "Plan" });
    const margins = () => io.observers
      .filter((observer) => observer.targets.has(plan))
      .map(({ options }) => options.rootMargin);
    expect(margins()).toEqual(["-72px 0px 10000000px 0px"]);

    await user.click(findButton());
    expect(document.documentElement.style.getPropertyValue("--find-row-height")).toBe("41px");

    rowHeight = 82;
    document.documentElement.style.setProperty("--page-scroll-padding", "146px");
    resize.report(row()!);

    expect(document.documentElement.style.getPropertyValue("--find-row-height")).toBe("82px");
    expect(margins()).toEqual(["-154px 0px 10000000px 0px"]);

    await user.click(within(row()!).getByRole("button", { name: "Close find" }));

    expect(document.documentElement.style.getPropertyValue("--find-row-height")).toBe("");
  });

  it.each([
    [300, [{ top: 341, behavior: "instant" }], [{ top: 259, behavior: "instant" }]],
    [0, [], [{ top: 0, behavior: "instant" }]],
  ])("scrolls by its height on open and close at a scroll of %i, so the text stays", async (scrollY, opened, closed) => {
    const user = userEvent.setup();
    stubElementBoxes((element) => ({ height: element.hasAttribute("data-find-row") ? 41 : 0 }));
    await openPage();
    vi.stubGlobal("scrollY", scrollY);
    scrollTo.mockClear();

    await user.click(findButton());
    expect(scrollTo.mock.calls.map(([options]) => options)).toEqual(opened);
    scrollTo.mockClear();

    await user.click(within(row()!).getByRole("button", { name: "Close find" }));
    expect(scrollTo.mock.calls.map(([options]) => options)).toEqual(closed);
  });

  it("scrolls on open to the place before the open plus its height, also when the browser already moved the page", async () => {
    const user = userEvent.setup();
    // A browser that anchors the scroll moves the page by the row in the layout that measures the row.
    stubElementBoxes((element) => {
      if (!element.hasAttribute("data-find-row")) {
        return { height: 0 };
      }
      vi.stubGlobal("scrollY", 341);
      return { height: 41 };
    });
    await openPage();
    vi.stubGlobal("scrollY", 300);
    scrollTo.mockClear();

    await user.click(findButton());

    expect(scrollTo.mock.calls.map(([options]) => options)).toEqual([{ top: 341, behavior: "instant" }]);
  });
});

describe("the matches", () => {
  it("highlights each match, counts them in the field's description, and starts at the first one", async () => {
    const user = userEvent.setup();
    await openPage({ body: "Alpha and alpha.\n\nThe ALPHA." });

    await openFind(user, "alpha");

    expect(counter()).toBe("1 of 3");
    expect(current()).toEqual(["Alpha"]);
    expect(others()).toEqual(["alpha", "ALPHA"]);
  });

  it.each([
    ["a block under the top at its first match", 80, "1 of 3"],
    ["a block across the top at its first match under the top", 50, "2 of 3"],
    ["the next block after a block across the top with no match under the top", 30, "3 of 3"],
    ["the next block after a block over the top", 10, "3 of 3"],
  ])("starts at the first match at or under the top of the visible area: %s", async (_place, firstTop, start) => {
    const user = userEvent.setup();
    document.documentElement.style.setProperty("--page-scroll-padding", "64px");
    // The first paragraph has two lines of 20px, with one match on each.
    const first = (node: Node) => node.textContent?.startsWith("one") === true;
    stubRangeBoxes((range) => ({
      top: first(range.startContainer) ? firstTop + (range.startOffset === 4 ? 0 : 20) : 300,
    }));
    stubElementBoxes((element) => {
      if (element.tagName !== "P") {
        return {};
      }
      return first(element) ? { top: firstTop, bottom: firstTop + 40 } : { top: 300, bottom: 320 };
    });
    await openPage({ body: "one alpha alpha\n\ntwo alpha" });

    await openFind(user, "alpha");

    expect(counter()).toBe(start);
  });

  it("starts at the first match when every match is above the visible area", async () => {
    const user = userEvent.setup();
    document.documentElement.style.setProperty("--page-scroll-padding", "64px");
    stubRangeBoxes(() => ({ top: -200 }));
    stubElementBoxes((element) => (element.tagName === "P" ? { top: -200, bottom: -180 } : {}));
    await openPage({ body: "one alpha\n\ntwo alpha" });

    await openFind(user, "alpha");

    expect(counter()).toBe("1 of 2");
  });

  it("measures each block once, and only a few matches of the block that crosses the top of the visible area", async () => {
    const lines = 2_000;
    let measured = 0;
    document.documentElement.style.setProperty("--page-scroll-padding", "64px");
    // Each line of the code block has 11 units and is 20px tall. Line 1,504 is the first at or under 64px.
    stubRangeBoxes((range) => {
      measured += 1;
      const top = Math.floor(range.startOffset / 11) * 20 - 30_000;
      return { top, bottom: top + 20 };
    });
    stubElementBoxes((element) => (element.tagName === "PRE" ? { top: -30_000, bottom: 10_000 } : {}));
    await openPage({ body: `\`\`\`\n${"line alpha\n".repeat(lines)}\`\`\`` });
    fireEvent.click(findButton());

    measured = 0;
    fireEvent.change(findField(), { target: { value: "alpha" } });
    expect(counter()).toBe("1505 of 2000");
    expect(measured).toBeLessThan(2 * Math.log2(lines));

    fireEvent.click(within(row()!).getByRole("button", { name: "Close find" }));
    measured = 0;
    fireEvent.click(findButton());
    expect(counter()).toBe("1505 of 2000");
    expect(measured).toBeLessThan(2 * Math.log2(lines));
  });

  it.each([
    [0, 1, NEARBY_MATCHES],
    [300, 300 - NEARBY_MATCHES / 2, 300 + NEARBY_MATCHES / 2],
    [600, 600 - NEARBY_MATCHES, 599],
  ])("highlights only the matches nearest to the current one, with the current one on line %i", async (line, first, last) => {
    const user = userEvent.setup();
    // Each line of the code block has 6 units and is 20px tall, and the line of the current match is at the top.
    stubRangeBoxes((range) => ({ top: (Math.floor(range.startOffset / 6) - line) * 20 }));
    stubElementBoxes((element) => (element.tagName === "PRE" ? { top: -line * 20, bottom: (601 - line) * 20 } : {}));
    await openPage({ body: `\`\`\`\n${"alpha\n".repeat(601)}\`\`\`` });

    await openFind(user, "alpha");

    expect(counter()).toBe(`${String(line + 1)} of 601`);
    const lines = highlights.ranges("task-find").map((range) => range.startOffset / 6);
    expect(lines).toHaveLength(NEARBY_MATCHES);
    expect([lines[0], lines.at(-1), lines.includes(line)]).toEqual([first, last, false]);
  });

  it("highlights a match in a long text only while it is the current match", async () => {
    const user = userEvent.setup();
    const lines = Math.ceil(LONG_TEXT / 6) + 1;
    await openPage({ body: `alpha first\n\n\`\`\`\n${"alpha\n".repeat(lines)}\`\`\`` });

    await openFind(user, "alpha");
    expect(counter()).toBe(`1 of ${String(lines + 1)}`);
    expect(others()).toEqual([]);

    await user.keyboard("{Enter}");
    expect(highlights.ranges("task-find-current")[0]?.startContainer.textContent).toMatch(/^alpha\nalpha\n/);
    expect(highlights.ranges("task-find").map((range) => range.startContainer.textContent)).toEqual(["alpha first"]);
  });

  it("says No matches, and keeps Previous and Next focusable while they are disabled", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });

    await openFind(user, "omega");

    expect(counter()).toBe("No matches");
    expect(current()).toBeUndefined();
    for (const name of ["Previous match", "Next match"]) {
      const button = within(row()!).getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.hasAttribute("data-disabled")).toBe(true);
      expect(button.classList.contains("data-disabled:border-line")).toBe(true);
      expect(button.classList.contains("not-data-disabled:border-graphic")).toBe(true);
    }
    await user.click(within(row()!).getByRole("button", { name: "Next match" }));
    expect(counter()).toBe("No matches");
  });

  it("moves nowhere on Enter with no match", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    await openFind(user, "omega");
    scrollTo.mockClear();

    await user.keyboard("{Enter}");

    expect(counter()).toBe("No matches");
    expect(matchScrolls()).toEqual([]);
  });

  it("shows no count and no highlight for an empty text or one of spaces", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha beta" });

    await openFind(user, "alpha");
    await user.clear(findField());
    expect(counter()).toBe("");
    expect(current()).toBeUndefined();

    await user.type(findField(), "   ");
    expect(counter()).toBe("");
  });

  it("goes through the matches with Enter, Shift+Enter, Next and Previous, and wraps at both ends", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha one\n\nalpha two\n\nalpha three" });
    await openFind(user, "alpha");
    const currentBlock = () => highlights.ranges("task-find-current")[0]?.startContainer.textContent;
    expect(within(row()!).getByRole("button", { name: "Next match" }).hasAttribute("data-disabled")).toBe(false);

    await user.keyboard("{Enter}");
    expect([counter(), currentBlock()]).toEqual(["2 of 3", "alpha two"]);
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    expect([counter(), currentBlock()]).toEqual(["1 of 3", "alpha one"]);
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(counter()).toBe("3 of 3");
    await user.click(within(row()!).getByRole("button", { name: "Previous match" }));
    expect(counter()).toBe("2 of 3");
    await user.click(within(row()!).getByRole("button", { name: "Next match" }));
    expect(counter()).toBe("3 of 3");
  });

  it("keeps the current match while more letters still match where it starts", async () => {
    const user = userEvent.setup();
    await openPage({ body: "kite\n\nkin\n\nkite" });
    await openFind(user, "ki");
    await user.keyboard("{Enter}{Enter}");
    expect(counter()).toBe("3 of 3");

    await user.type(findField(), "t");

    expect(counter()).toBe("2 of 2");
  });

  it("does not search the source of a diagram", async () => {
    const user = userEvent.setup();
    await openPage({ body: "draw the flowchart\n\n```mermaid\nflowchart LR\n  a --> b\n```" });

    await openFind(user, "flowchart");

    expect(counter()).toBe("1 of 1");
  });

  it("finds the title, the id line, the meta line and the comment list heading", async () => {
    const user = userEvent.setup();
    await openPage({ title: "Progress report", comments: [comment(1)] });

    await openFind(user, "progress");
    expect(counter()).toBe("1 of 2");

    await user.clear(findField());
    await user.type(findField(), "saga-3");
    expect(counter()).toBe("1 of 1");

    await user.clear(findField());
    await user.type(findField(), "comments");
    expect(counter()).toBe("1 of 1");
  });
});

describe("the scroll", () => {
  it("puts the current match in the middle of the area under the bar", async () => {
    const user = userEvent.setup();
    document.documentElement.style.setProperty("--page-scroll-padding", "64px");
    stubRangeBoxes(() => ({ top: 1000, height: 20 }));
    await openPage({ body: "alpha" });

    await openFind(user, "alpha");

    // The middle of the area under the bar is 64 + (768 - 64) / 2 = 416.
    expect(matchScrolls().at(-1)).toEqual({ top: 1000 + 10 - 416, behavior: "smooth" });
  });

  it("scrolls a code block sideways to show a match outside its visible part, and not one inside it", async () => {
    const user = userEvent.setup();
    stubRangeBoxes((range) => (range.toString() === "far" ? { left: 400, right: 430, width: 30 } : {}));
    await openPage({ body: "```\nnear far\n```" });
    const block = document.querySelector("pre")!;
    block.style.overflowX = "auto";
    Object.defineProperty(block, "scrollWidth", { value: 600 });
    Object.defineProperty(block, "clientWidth", { value: 200 });
    const scrollBlock = vi.fn();
    block.scrollTo = scrollBlock;

    await openFind(user, "near");
    expect(scrollBlock).not.toHaveBeenCalled();

    await user.clear(findField());
    await user.type(findField(), "far");

    // The block's box starts at 0, so the middle of the match goes to the middle of its 200px.
    expect(scrollBlock).toHaveBeenLastCalledWith({ left: 415 - 100, behavior: "smooth" });
  });

  it("scrolls at once when the system asks for reduced motion", async () => {
    const user = userEvent.setup();
    stubReducedMotion(true);
    await openPage({ body: "alpha" });

    await openFind(user, "alpha");

    expect(matchScrolls().at(-1)).toMatchObject({ behavior: "auto" });
  });
});

describe("a collapsed comment", () => {
  const COMMENTS = [comment(1, { collapsed: true, body: "the hidden alpha\n\n```mermaid\nflowchart LR\n```" })];

  it("keeps its text in the page only while the row is open with a text", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha first", comments: COMMENTS });
    expect(screen.queryByText("the hidden alpha")).toBeNull();

    await openFind(user, "alpha");
    const panel = screen.getByText("the hidden alpha").closest("[data-find-hidden]");
    expect(panel?.hasAttribute("hidden")).toBe(true);

    await user.clear(findField());
    expect(screen.queryByText("the hidden alpha")).toBeNull();
  });

  it("counts its match, and opens when the match becomes current, drawing its diagram and writing nothing", async () => {
    const user = userEvent.setup();
    const { requests } = await openPage({ body: "alpha first", comments: COMMENTS });
    await openFind(user, "alpha");
    expect(counter()).toBe("1 of 2");
    expect(caret("Note 1").getAttribute("aria-expanded")).toBe("false");
    expect(renderMermaid).not.toHaveBeenCalled();
    scrollTo.mockClear();

    await user.keyboard("{Enter}");

    expect(counter()).toBe("2 of 2");
    expect(caret("Note 1").getAttribute("aria-expanded")).toBe("true");
    expect(commentCard("Note 1").querySelector("[data-find-hidden]")).toBeNull();
    expect(renderMermaid).toHaveBeenCalled();
    expect(current()).toEqual(["alpha"]);
    expect(highlights.ranges("task-find-current")[0]?.startContainer.textContent).toBe("the hidden alpha");
    expect(matchScrolls()).toHaveLength(1);
    expect(writes(requests)).toBe(0);
  });

  it("opens again on the next move into it after the reader closed it", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha first", comments: COMMENTS });
    await openFind(user, "alpha");
    await user.keyboard("{Enter}");

    await user.click(caret("Note 1"));
    expect(caret("Note 1").getAttribute("aria-expanded")).toBe("false");
    await user.click(findField());
    await user.keyboard("{Enter}{Enter}");

    expect(caret("Note 1").getAttribute("aria-expanded")).toBe("true");
  });

  it("is taken at the top of its card when the find starts at the first match on the screen", async () => {
    const user = userEvent.setup();
    document.documentElement.style.setProperty("--page-scroll-padding", "64px");
    stubRangeBoxes(() => ({ top: 20 }));
    stubElementBoxes((element) => (element.dataset.commentId === "1" ? { top: 300, bottom: 400 } : { top: 20, bottom: 40 }));
    await openPage({ body: "alpha first", comments: COMMENTS });

    await openFind(user, "alpha");

    expect(counter()).toBe("2 of 2");
    expect(caret("Note 1").getAttribute("aria-expanded")).toBe("true");
  });
});

describe("Escape and Close", () => {
  it("Escape puts focus on the link that holds the match, selects it, and deletes the highlights", async () => {
    const user = userEvent.setup();
    await openPage({ body: "See the [output](https://example.invalid/out) now" });
    await openFind(user, "output");

    await user.keyboard("{Escape}");

    expect(row()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: /output/ }));
    expect(window.getSelection()?.toString()).toBe("output");
    expect(current()).toBeUndefined();
    expect(others()).toBeUndefined();
  });

  it("Escape puts focus on the block of a match that no focusable element holds, and does not scroll to a match on the screen", async () => {
    const user = userEvent.setup();
    await openPage({ body: "plain words" });
    await openFind(user, "words");
    scrollTo.mockClear();

    await user.keyboard("{Escape}");

    const block = screen.getByText("plain words");
    expect(document.activeElement).toBe(block);
    expect(block.tabIndex).toBe(-1);
    expect(window.getSelection()?.toString()).toBe("words");
    expect(matchScrolls()).toEqual([]);
  });

  it.each([
    ["below the visible area", { top: 2000, bottom: 2020 }],
    ["under the bar", { top: 30, bottom: 50 }],
  ])("Escape scrolls to a match %s before it puts focus on it", async (_place, box) => {
    const user = userEvent.setup();
    document.documentElement.style.setProperty("--page-scroll-padding", "64px");
    await openPage({ body: "plain words" });
    await openFind(user, "words");
    stubRangeBoxes(() => box);
    scrollTo.mockClear();

    await user.keyboard("{Escape}");

    expect(matchScrolls()).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByText("plain words"));
  });

  it.each([
    ["the text of a comment, under its stuck header", "delta", 100, 1],
    ["the text of a comment, below its header", "delta", 130, 0],
    ["the header of a comment", "gamma", 70, 0],
  ])("Escape scrolls to a match in %s only when the header covers it", async (_place, text, top, scrolls) => {
    const user = userEvent.setup();
    document.documentElement.style.setProperty("--page-scroll-padding", "64px");
    await openPage({ comments: [comment(1, { title: "Gamma heading", body: "delta words" })] });
    await openFind(user, text);
    // The header sticks under the bar, from 64px to 124px.
    stubElementBoxes((element) => (element.hasAttribute("data-comment-header") ? { top: 64, bottom: 124 } : {}));
    stubRangeBoxes(() => ({ top, bottom: top + 20 }));
    scrollTo.mockClear();

    await user.keyboard("{Escape}");

    expect(matchScrolls()).toHaveLength(scrolls);
  });

  it("Escape puts focus on the block of a match that crosses bold text", async () => {
    const user = userEvent.setup();
    await openPage({ body: "run **the fast** parser" });
    await openFind(user, "run the fast");

    await user.keyboard("{Escape}");

    expect(document.activeElement?.tagName).toBe("P");
    expect(window.getSelection()?.toString()).toBe("run the fast");
  });

  it("Escape with no match puts focus back where it was before the row opened", async () => {
    const user = userEvent.setup();
    const { router } = await openPage({ body: "alpha" });
    render(<FindShortcut router={router} />);
    const add = screen.getByRole("button", { name: "Add comment" });
    add.focus();
    await user.keyboard("{Meta>}f{/Meta}");
    await user.type(findField(), "omega");

    await user.keyboard("{Escape}");

    expect(document.activeElement).toBe(add);
  });

  it("Escape with no match puts focus on the button when the page had no focus before", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    fireEvent.click(findButton());
    await user.type(findField(), "omega");

    await user.keyboard("{Escape}");

    expect(document.activeElement).toBe(findButton());
  });

  it("Escape on a match in a comment the reader closed puts focus back where it was", async () => {
    const user = userEvent.setup();
    await openPage({ comments: [comment(1, { body: "alpha" })] });
    fireEvent.click(findButton());
    await user.type(findField(), "alpha");
    await user.click(caret("Note 1"));

    await user.click(findField());
    await user.keyboard("{Escape}");

    expect(document.activeElement).toBe(findButton());
  });

  it("Escape on Previous, Next and Close closes the row too, and an Escape that ends a composition does not", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    await openFind(user, "alpha");

    fireEvent.keyDown(findField(), { key: "Escape", isComposing: true });
    expect(row()).not.toBeNull();

    for (const name of ["Previous match", "Next match", "Close find"]) {
      if (row() === null) {
        await user.click(findButton());
      }
      fireEvent.keyDown(within(row()!).getByRole("button", { name }), { key: "Escape" });
      expect(row(), name).toBeNull();
    }
  });

  it("Enter during a composition moves to no match", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha alpha" });
    await openFind(user, "alpha");

    fireEvent.keyDown(findField(), { key: "Enter", isComposing: true });

    expect(counter()).toBe("1 of 2");
  });

  it("Close puts focus on the button and deletes the highlights", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    await openFind(user, "alpha");

    await user.click(within(row()!).getByRole("button", { name: "Close find" }));

    expect(row()).toBeNull();
    expect(document.activeElement).toBe(findButton());
    expect(current()).toBeUndefined();
  });

  it("keeps the text while the page stays, selected and searched again when the row opens", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    await openFind(user, "alpha");
    await user.click(within(row()!).getByRole("button", { name: "Close find" }));
    announce.mockClear();
    scrollTo.mockClear();

    await user.click(findButton());

    expect([findField().value, findField().selectionStart, findField().selectionEnd]).toEqual(["alpha", 0, 5]);
    expect(counter()).toBe("1 of 1");
    expect(matchScrolls()).toHaveLength(1);
    expect(announce.mock.calls).toEqual([["Match 1 of 1, in the body"]]);
  });

  it("deletes the highlights when the page goes", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    await openFind(user, "alpha");

    cleanup();

    expect(current()).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--find-row-height")).toBe("");
  });
});

describe("live updates", () => {
  /** One poll interval, the notification of the cache, and the frame the find runs again in. */
  async function poll() {
    await wait(5_000);
    await wait(50);
  }

  it("keeps the current match through a poll that adds a block above it, and does not scroll", async () => {
    const user = userWithFakeTimers();
    const { replies } = await openPage({ body: "alpha one\n\nalpha two" });
    await openFind(user, "alpha");
    await user.keyboard("{Enter}");
    scrollTo.mockClear();
    announce.mockClear();

    replies[TASK_PATH] = task({ body: "alpha zero\n\nalpha one\n\nalpha two" });
    await poll();

    expect(counter()).toBe("3 of 3");
    expect(highlights.ranges("task-find-current")[0]?.startContainer.textContent).toBe("alpha two");
    expect(scrollTo).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it("keeps a current match in a comment through a poll that adds a paragraph to the body", async () => {
    const user = userWithFakeTimers();
    const { replies } = await openPage({ body: "alpha", comments: [comment(1, { body: "alpha note" })] });
    await openFind(user, "alpha");
    await user.keyboard("{Enter}");
    expect(counter()).toBe("2 of 2");

    replies[TASK_PATH] = task({ body: "alpha\n\nalpha more", comments: [comment(1, { body: "alpha note" })] });
    await poll();

    expect(counter()).toBe("3 of 3");
    expect(highlights.ranges("task-find-current")[0]?.startContainer.textContent).toBe("alpha note");
  });

  it("moves to the first match after the old place when a poll removes the block of the current match", async () => {
    const user = userWithFakeTimers();
    const { replies } = await openPage({ body: "alpha one\n\nalpha two\n\nalpha three" });
    await openFind(user, "alpha");
    await user.keyboard("{Enter}");

    replies[TASK_PATH] = task({ body: "alpha one\n\nalpha three" });
    await poll();

    expect(counter()).toBe("2 of 2");
  });

  it("moves to the first match when a poll removes every match after the old place", async () => {
    const user = userWithFakeTimers();
    const { replies } = await openPage({ body: "alpha one\n\nalpha two" });
    await openFind(user, "alpha");
    await user.keyboard("{Enter}");

    replies[TASK_PATH] = task({ body: "alpha one" });
    await poll();

    expect(counter()).toBe("1 of 1");
  });

  it("finds again in the next frame after several changes to the page", async () => {
    const user = userWithFakeTimers();
    await openPage({ body: "alpha" });
    await openFind(user, "alpha");
    const block = screen.getByText("alpha");

    await act(async () => {
      block.append(" alpha");
      await Promise.resolve();
      block.append(" alpha");
      await Promise.resolve();
    });
    expect(counter()).toBe("1 of 1");
    await wait(50);

    expect(counter()).toBe("1 of 3");
  });

  it("finds the first match on the page when a poll brings a match to a text that had none", async () => {
    const user = userWithFakeTimers();
    const { replies } = await openPage({ body: "beta" });
    await openFind(user, "alpha");
    expect(counter()).toBe("No matches");

    replies[TASK_PATH] = task({ body: "beta\n\nalpha" });
    await poll();

    expect(counter()).toBe("1 of 1");
  });
});

describe("the announcements", () => {
  const COMMENTS = [comment(1, { title: "Comment one" }), comment(2, { title: "", body: "comment body" })];

  it("says the result once the text has not changed for 500 ms", async () => {
    const user = userWithFakeTimers();
    await openPage({ title: "Comment parser" });
    await user.click(findButton());

    await user.type(findField(), "comment");
    await wait(FIND_ANNOUNCE_DELAY - 100);
    expect(announce).not.toHaveBeenCalled();
    await wait(100);

    expect(announce.mock.calls).toEqual([["Match 1 of 2, in the header"]]);
  });

  it("waits the whole delay again after each change of the text, and says the last result alone", async () => {
    const user = userWithFakeTimers();
    await openPage({ title: "Comment parser" });
    await user.click(findButton());
    await user.type(findField(), "comment");
    await wait(FIND_ANNOUNCE_DELAY - 200);

    act(() => {
      fireEvent.change(findField(), { target: { value: "comment parser" } });
    });
    await wait(FIND_ANNOUNCE_DELAY - 200);
    expect(announce).not.toHaveBeenCalled();
    await wait(200);

    expect(announce.mock.calls).toEqual([["Match 1 of 1, in the header"]]);
  });

  it("says each move at once, with the place of the match", async () => {
    const user = userWithFakeTimers();
    await openPage({ title: "Comment parser", body: "A comment here.", comments: COMMENTS });
    await openFind(user, "comment");
    announce.mockClear();

    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.click(within(row()!).getByRole("button", { name: "Next match" }));
    await user.click(within(row()!).getByRole("button", { name: "Previous match" }));

    expect(announce.mock.calls.flat()).toEqual([
      "Match 2 of 6, in the body",
      "Match 3 of 6, in the comment list",
      "Match 4 of 6, in comment Comment one",
      "Match 5 of 6, in comment #2",
      "Match 4 of 6, in comment Comment one",
      "Match 5 of 6, in comment #2",
      "Match 4 of 6, in comment Comment one",
    ]);
  });

  it("says No matches for a text with none", async () => {
    const user = userWithFakeTimers();
    await openPage();
    await user.click(findButton());

    await user.type(findField(), "omega");
    await wait(FIND_ANNOUNCE_DELAY);

    expect(announce.mock.calls).toEqual([["No matches"]]);
  });

  it("says No matches at once on Enter with no match, and not again when the wait ends", async () => {
    const user = userWithFakeTimers();
    await openPage({ body: "alpha" });
    await user.click(findButton());
    await user.type(findField(), "omega");

    await user.keyboard("{Enter}");
    expect(announce.mock.calls).toEqual([["No matches"]]);
    await wait(FIND_ANNOUNCE_DELAY);

    expect(announce.mock.calls).toEqual([["No matches"]]);
  });

  it.each([
    ["Enter after the first letters", "", "alpha", [{ key: "Enter" }], "Match 2 of 3, in the body"],
    ["Shift+Enter after the first letters", "", "alpha", [{ key: "Enter", shiftKey: true }], "Match 3 of 3, in the body"],
    ["two Enters after more letters", "alp", "alpha", [{ key: "Enter" }, { key: "Enter" }], "Match 3 of 3, in the body"],
    ["Enter after letters with no match", "", "omega", [{ key: "Enter" }], "No matches"],
  ])("moves on %s that come before the result of the text, and says the move at once when the result comes", async (_keys, start, text, keys, words) => {
    const user = userWithFakeTimers();
    await openPage({ body: "alpha one\n\nalps two\n\nalpha three\n\nalpha four" });
    await user.click(findButton());
    fireEvent.change(findField(), { target: { value: start } });

    await keysBeforeResult(text, keys);

    expect(announce.mock.calls).toEqual([[words]]);
    await wait(FIND_ANNOUNCE_DELAY);
    expect(announce.mock.calls).toEqual([[words]]);
  });

  it("says nothing for a text that becomes empty, for Enter in an empty field, or when the row opens with no text", async () => {
    const user = userWithFakeTimers();
    await openPage({ body: "alpha" });
    await user.click(findButton());
    await user.type(findField(), "a");
    await user.clear(findField());
    await user.keyboard("{Enter}");
    await wait(FIND_ANNOUNCE_DELAY);

    expect(announce).not.toHaveBeenCalled();
  });

  it.each([
    ["Escape", "{Escape}"],
    ["Enter", "{Enter}"],
  ])("drops the typing announcement on %s within the wait", async (_name, key) => {
    const user = userWithFakeTimers();
    await openPage({ body: "alpha alpha" });
    await user.click(findButton());
    await user.type(findField(), "alpha");

    await user.keyboard(key);
    announce.mockClear();
    await wait(FIND_ANNOUNCE_DELAY);

    expect(announce).not.toHaveBeenCalled();
  });
});
