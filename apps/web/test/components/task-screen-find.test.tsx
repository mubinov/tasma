import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Comment } from "@tasma/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ICON_BUTTON_CLASS } from "../../src/components/control-classes";
import { FIND_OPEN_FLOOR, FIND_OPEN_WIDTHS } from "../../src/components/find-open-classes";
import { FindShortcut } from "../../src/components/find-shortcut";
import { MagnifyingGlassIcon, XIcon } from "../../src/lib/icons";
import { renderMermaid } from "../../src/lib/mermaid";
import { FIND_ANNOUNCE_DELAY, LONG_TEXT, NEARBY_MATCHES } from "../../src/lib/use-task-find";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import {
  renderWithRouter,
  stubHighlights,
  stubRangeBoxes,
  stubReducedMotion,
  stubSystemTheme,
  stubResizeObservers,
} from "../helpers";
import { TASK_PATH, backLink, caret, comment, commentCard, daemon, task, topBar } from "../task-screen-fixtures";

vi.mock(import("../../src/lib/mermaid"), () => ({ renderMermaid: vi.fn(() => new Promise<never>(() => {})) }));

const PAGE = "/tasks/SAGA/SAGA-3";

const THEME_CSS = readFileSync(join(import.meta.dirname, "../../src/styles/theme.css"), "utf8");

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

function closeButton(): HTMLElement {
  return screen.getByRole("button", { name: "Close find" });
}

function group(): HTMLElement | null {
  return screen.queryByRole("search", { name: "Find" });
}

function findField(): HTMLInputElement {
  return within(group()!).getByRole("searchbox");
}

/** The line of the top bar, which holds the back link and the controls. */
function line(): HTMLElement {
  return backLink().parentElement!;
}

/** The markup of an icon, which tells the icons apart where nothing else does. */
function iconMarkup(Icon: ComponentType<{ size: number }>): string {
  const { container, unmount } = render(<Icon size={16} />);
  const markup = container.querySelector("svg")!.innerHTML;
  unmount();

  return markup;
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

function matchScrolls(): unknown[] {
  return scrollTo.mock.calls.map(([options]) => options);
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

describe("the toggle", () => {
  it("sits before Edit and shows the magnifier with its key while find is closed, and × as the same element while it is open", async () => {
    const user = userEvent.setup();
    await openPage();
    const [magnifier, cross] = [iconMarkup(MagnifyingGlassIcon), iconMarkup(XIcon)];

    const button = findButton();
    expect(button.nextElementSibling?.textContent).toBe("Edit");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+F");
    expect(button.querySelector("svg")?.innerHTML).toBe(magnifier);
    expect(group()).toBeNull();

    await user.click(button);

    expect(closeButton()).toBe(button);
    expect(button.nextElementSibling?.textContent).toBe("Edit");
    expect(button.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(button.querySelector("svg")?.innerHTML).toBe(cross);
    expect(document.activeElement).toBe(findField());

    await user.click(button);

    expect(findButton()).toBe(button);
    expect(button.querySelector("svg")?.innerHTML).toBe(magnifier);
    for (const name of ["aria-expanded", "aria-controls"]) {
      expect(button.hasAttribute(name), name).toBe(false);
    }
  });

  it("shows the key in its tooltip while find is closed, and Close find while it is open", async () => {
    const user = userEvent.setup();
    await openPage();

    await user.hover(findButton());
    expect(await screen.findByText("Find in task ⌘F")).toBeTruthy();

    await user.click(findButton());
    await user.unhover(closeButton());
    await user.hover(closeButton());

    expect(await screen.findByText("Close find")).toBeTruthy();
    expect(screen.queryByText("Find in task ⌘F")).toBeNull();
  });

  it("closes find on a second press, calls focus on itself, which a pointer press does not give, and says so", async () => {
    await openPage();
    const button = findButton();
    const focus = vi.spyOn(button, "focus");

    fireEvent.click(button);
    expect(group()).not.toBeNull();
    fireEvent.click(button);

    expect(group()).toBeNull();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(button);
    expect(announce.mock.calls).toEqual([["Find closed"]]);
  });

  it("closes only its tooltip on Escape, and keeps find open with focus on itself", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    await openFind(user, "alpha");
    await user.hover(closeButton());
    await screen.findByText("Close find");
    closeButton().focus();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByText("Close find")).toBeNull();
    });
    expect(group()).not.toBeNull();
    expect(document.activeElement).toBe(closeButton());
    expect(current()).toEqual(["alpha"]);
  });

  it("puts focus in the field without a focus scroll, which the sticky bar would turn into a page scroll", async () => {
    await openPage();
    const focus = vi.spyOn(HTMLInputElement.prototype, "focus");

    fireEvent.click(findButton());

    expect(focus.mock.contexts).toContain(findField());
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("hides while the task editor is open, which closes find; Cmd+F then does nothing", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    await openFind(user, "alpha");
    expect(current()).toEqual(["alpha"]);

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(group()).toBeNull();
    expect(current()).toBeUndefined();
    expect(screen.queryByRole("button", { name: /find/i })).toBeNull();
    act(() => {
      useUiStore.getState().requestFind();
    });
    expect(group()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(findButton().getAttribute("aria-keyshortcuts")).toBe("Meta+F");
    expect(group()).toBeNull();
  });
});

describe("Cmd+F", () => {
  it("opens find with focus in the field, and selects the text of an open find", async () => {
    const user = userEvent.setup();
    const { router } = await openPage({ body: "alpha" });
    render(<FindShortcut router={router} />);

    await user.keyboard("{Meta>}f{/Meta}");

    expect(document.activeElement).toBe(findField());
    await user.type(findField(), "alpha");
    closeButton().focus();

    await user.keyboard("{Meta>}f{/Meta}");

    expect(document.activeElement).toBe(findField());
    expect([findField().selectionStart, findField().selectionEnd]).toEqual([0, 5]);
  });
});

describe("the find group", () => {
  it("opens on the line of the bar before the toggle: the label, the field with the counter in it, Previous and Next", async () => {
    const user = userEvent.setup();
    await openPage();

    await user.click(findButton());

    const search = group()!;
    expect(topBar().childElementCount).toBe(1);
    expect(line().classList.contains("h-top-bar")).toBe(true);
    expect(search.parentElement?.parentElement).toBe(line());
    expect(search.nextElementSibling).toBe(closeButton());
    expect(search.firstElementChild?.textContent).toBe("Find");
    const field = findField();
    expect(field.getAttribute("type")).toBe("text");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("spellcheck")).toBe("false");
    expect(field.parentElement?.classList.contains("w-60")).toBe(true);
    const description = document.getElementById(field.getAttribute("aria-describedby")!);
    expect(description?.getAttribute("aria-hidden")).toBe("true");
    expect(description?.previousElementSibling).toBe(field);
    expect(within(search).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Previous match",
      "Next match",
    ]);
  });

  it("gives the page its scroll padding, the height of the bar and a gap, only while focus is outside the bar", async () => {
    await openPage();

    const classes = [...topBar().classList];
    expect(classes).toContain("[html:has(&)]:[--page-scroll-padding:--spacing(16)]");
    expect(classes).toContain("[html:has(&:not(:focus-within))]:scroll-pt-(--page-scroll-padding)");
    expect(classes.filter((name) => name.includes("scroll-pt"))).toHaveLength(1);
  });

  it("changes the root's min-height, which a block root does not use, each time the scroll padding changes", async () => {
    await openPage();

    const classes = [...topBar().classList];
    expect(classes).toContain("[html:has(&:focus-within)]:min-h-px");
    expect(classes.filter((name) => name.includes("min-h"))).toHaveLength(1);
  });

  it("opens and closes with no scroll of the page", async () => {
    const user = userEvent.setup();
    await openPage();
    vi.stubGlobal("scrollY", 300);
    scrollTo.mockClear();

    await user.click(findButton());
    await user.click(closeButton());

    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe("narrow widths", () => {
  function hasClasses(element: Element, classes: string): boolean {
    return classes.split(" ").every((name) => element.classList.contains(name));
  }

  it("marks the line only while find is open, and makes the bar, as wide as the line, a size container", async () => {
    const user = userEvent.setup();
    await openPage();
    expect(topBar().classList.contains("@container")).toBe(true);
    expect(line().classList.contains("group/top-bar")).toBe(true);
    expect(line().hasAttribute("data-find-open")).toBe(false);

    await user.click(findButton());
    expect(line().hasAttribute("data-find-open")).toBe(true);

    await user.click(closeButton());
    expect(line().hasAttribute("data-find-open")).toBe(false);
  });

  it("gives each item of the line and of the find group the classes of its steps", async () => {
    const user = userEvent.setup();
    await openPage();

    await user.click(findButton());

    expect(hasClasses(backLink(), FIND_OPEN_WIDTHS.back)).toBe(true);
    expect(hasClasses(line().children[1]!, FIND_OPEN_WIDTHS.title)).toBe(true);
    expect(hasClasses(screen.getByRole("button", { name: "Edit" }), FIND_OPEN_WIDTHS.actions)).toBe(true);
    expect(hasClasses(screen.getByRole("button", { name: "Task menu" }), FIND_OPEN_WIDTHS.actions)).toBe(true);
    expect(hasClasses(group()!.parentElement!, `${FIND_OPEN_WIDTHS.controls} ${FIND_OPEN_FLOOR.controls}`)).toBe(true);
    expect(hasClasses(group()!, `${FIND_OPEN_WIDTHS.group} ${FIND_OPEN_FLOOR.group}`)).toBe(true);
    expect(hasClasses(findField().parentElement!, `${FIND_OPEN_WIDTHS.field} ${FIND_OPEN_FLOOR.field}`)).toBe(true);
    expect(hasClasses(line(), FIND_OPEN_FLOOR.line)).toBe(true);
    for (const name of ["Previous match", "Next match"]) {
      expect(hasClasses(within(group()!).getByRole("button", { name }), `shrink-0 ${FIND_OPEN_FLOOR.stepButton}`)).toBe(true);
    }
    expect(closeButton().classList.contains("shrink-0")).toBe(true);
  });

  it("takes each width from the theme, steps in order, and gives the field 15rem again 5rem above each step", () => {
    const width = (token: string | undefined): number => {
      const value = new RegExp(`--container-${token}: ([\\d.]+)rem;`).exec(THEME_CSS)?.[1];
      expect(value, token).toBeDefined();
      return Number(value);
    };
    /** The `@min-` and `@max-` tokens of each class of `classes` under `prefix` that sets `utility`. */
    const queries = (classes: string, prefix: string, utility: string) => classes
      .split(" ")
      .filter((name) => name.startsWith(`${prefix}:`) && name.endsWith(`:${utility}`))
      .map((name) => ({ min: /:@min-([a-z-]+):/.exec(name)?.[1], max: /:@max-([a-z-]+):/.exec(name)?.[1] }));
    // The sm window width, 40rem, less the 4rem nav rail.
    const widestLineBelowSm = 36;
    const floors = Object.values(FIND_OPEN_FLOOR)
      .flatMap((classes) => classes.split(" "))
      .map((name) => /^@max-([a-z-]+):/.exec(name)?.[1]);
    expect(new Set(floors).size).toBe(1);
    const floor = width(floors[0]);

    for (const [prefix, widest] of [["max-sm", widestLineBelowSm], ["sm", Infinity]] as const) {
      const steps = [FIND_OPEN_WIDTHS.title, FIND_OPEN_WIDTHS.actions, FIND_OPEN_WIDTHS.back]
        .flatMap((classes) => queries(classes, prefix, "hidden"))
        .flatMap(({ max }) => (max === undefined ? [] : [max]));
      const stepWidths = steps.map(width);
      expect(stepWidths, prefix).toEqual(stepWidths.toSorted((a, b) => b - a));
      expect(stepWidths.at(-1)! > floor, prefix).toBe(true);

      const back = { min: undefined, max: steps.at(-1) };
      expect(queries(FIND_OPEN_WIDTHS.controls, prefix, "min-w-0"), prefix).toEqual([back]);
      expect(queries(FIND_OPEN_WIDTHS.controls, prefix, "flex-1"), prefix).toEqual([back]);
      expect(queries(FIND_OPEN_WIDTHS.group, prefix, "flex-1"), prefix).toEqual([back]);
      expect(queries(FIND_OPEN_WIDTHS.field, prefix, "flex-1"), prefix).toEqual([back]);

      const narrowFieldRanges = queries(FIND_OPEN_WIDTHS.field, prefix, "w-40");
      expect(narrowFieldRanges.map(({ min }) => min), prefix).toEqual(steps);
      for (const { min, max } of narrowFieldRanges) {
        // The field's 15rem less its 10rem. A step with no upper bound has a line that is never that much wider.
        const wideFieldFrom = width(min) + 5;
        expect(max === undefined ? wideFieldFrom > widest : width(max) === wideFieldFrom, `${prefix} ${min}`).toBe(true);
      }
    }
    expect(FIND_OPEN_WIDTHS.title).toContain("max-sm:group-data-find-open/top-bar:hidden");
  });

  it("leaves the input 8 px beside a counter of five-digit numbers at the floor, on a line of 256 px", () => {
    // Measured in Chromium with the bundled Inter at 0.75rem, in px: the label "Find" and the counter "99999 of 99999".
    const label = 24.4;
    const counter = 95.9;
    const border = 1;
    /** The px of the spacing utility `utility` among the floor classes `classes`. */
    const floorPx = (classes: string, utility: string): number => {
      const value = classes
        .split(" ")
        .map((name) => new RegExp(`^@max-find-floor:(?:.+:)?${utility}-([\\d.]+)$`).exec(name)?.[1])
        .find((step) => step !== undefined);
      expect(value, `${classes} ${utility}`).toBeDefined();
      return Number(value) * 4;
    };
    const toggle = Number(/(?:^| )w-(\d+)(?: |$)/.exec(ICON_BUTTON_CLASS)?.[1]) * 4;

    const input = 256
      - 2 * floorPx(FIND_OPEN_FLOOR.line, "px")
      - floorPx(FIND_OPEN_FLOOR.controls, "gap")
      - toggle
      - label
      - 3 * floorPx(FIND_OPEN_FLOOR.group, "gap")
      - 2 * floorPx(FIND_OPEN_FLOOR.stepButton, "size")
      - 2 * border
      - 2 * floorPx(FIND_OPEN_FLOOR.field, "px")
      - floorPx(FIND_OPEN_FLOOR.field, "gap")
      - counter;

    expect(input).toBeGreaterThanOrEqual(8);
  });
});

describe("an item of the line that hides", () => {
  /** Makes `checkVisibility()`, which jsdom does not have, false for the elements in the set. */
  function stubVisibility(): Set<Element> {
    const hidden = new Set<Element>();
    Object.defineProperty(Element.prototype, "checkVisibility", {
      configurable: true,
      value(this: Element) {
        return !hidden.has(this);
      },
    });
    onTestFinished(() => {
      Reflect.deleteProperty(Element.prototype, "checkVisibility");
    });
    return hidden;
  }

  function editButton(): HTMLElement {
    return screen.getByRole("button", { name: "Edit" });
  }

  function menuButton(): HTMLElement {
    return screen.getByRole("button", { name: "Task menu" });
  }

  async function openWithFocusOn(item: () => HTMLElement) {
    const user = userEvent.setup();
    const resize = stubResizeObservers();
    const hidden = stubVisibility();
    await openPage();
    await user.click(findButton());
    act(() => {
      item().focus();
    });
    return { user, resize, hidden };
  }

  it.each([
    ["Edit", editButton],
    ["the task menu button", menuButton],
    ["the back link", backLink],
  ])("moves focus from %s to the toggle when a size change of the line hides it", async (_name, item) => {
    const { resize, hidden } = await openWithFocusOn(item);
    const focus = vi.spyOn(closeButton(), "focus");

    hidden.add(item());
    resize.report(line());

    expect(document.activeElement).toBe(closeButton());
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("moves focus to the toggle when the engine moved it to the body as the item hid", async () => {
    const { resize, hidden } = await openWithFocusOn(editButton);

    hidden.add(editButton());
    act(() => {
      editButton().blur();
    });
    expect(document.activeElement).toBe(document.body);
    resize.report(line());

    expect(document.activeElement).toBe(closeButton());
  });

  it("leaves focus alone when the reader moved it away from the item before the item hid", async () => {
    const { resize, hidden } = await openWithFocusOn(editButton);

    act(() => {
      editButton().blur();
    });
    hidden.add(editButton());
    resize.report(line());

    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus outside the line alone", async () => {
    const addComment = () => screen.getByRole("button", { name: "Add comment" });
    const { resize, hidden } = await openWithFocusOn(addComment);

    hidden.add(editButton());
    resize.report(line());

    expect(document.activeElement).toBe(addComment());
  });

  it("leaves focus on an item that is still shown", async () => {
    const { resize } = await openWithFocusOn(editButton);

    resize.report(line());

    expect(document.activeElement).toBe(editButton());
  });

  it("closes the open task menu when its button hides and puts focus on the toggle; a menu closed by Escape returns focus to its button", async () => {
    const { user, resize, hidden } = await openWithFocusOn(menuButton);
    await user.click(menuButton());
    await screen.findByRole("menu");

    resize.report(menuButton());
    expect(screen.getByRole("menu")).toBeTruthy();
    hidden.add(menuButton());
    resize.report(menuButton());

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(closeButton());
    });

    hidden.clear();
    await user.click(menuButton());
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(document.activeElement).toBe(menuButton());
    });
  });

  it("watches the line only while find is open", async () => {
    const user = userEvent.setup();
    const resize = stubResizeObservers();
    await openPage();
    expect(resize.observed(line())).toBe(false);

    await user.click(findButton());
    expect(resize.observed(line())).toBe(true);

    await user.click(closeButton());
    expect(resize.observed(line())).toBe(false);
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

    fireEvent.click(closeButton());
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
      const button = within(group()!).getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.hasAttribute("data-disabled")).toBe(true);
      expect(button.classList.contains("data-disabled:border-line")).toBe(true);
      expect(button.classList.contains("not-data-disabled:border-graphic")).toBe(true);
    }
    await user.click(within(group()!).getByRole("button", { name: "Next match" }));
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
    expect(within(group()!).getByRole("button", { name: "Next match" }).hasAttribute("data-disabled")).toBe(false);

    await user.keyboard("{Enter}");
    expect([counter(), currentBlock()]).toEqual(["2 of 3", "alpha two"]);
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    expect([counter(), currentBlock()]).toEqual(["1 of 3", "alpha one"]);
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(counter()).toBe("3 of 3");
    await user.click(within(group()!).getByRole("button", { name: "Previous match" }));
    expect(counter()).toBe("2 of 3");
    await user.click(within(group()!).getByRole("button", { name: "Next match" }));
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

  it("keeps its text in the page only while find is open with a text", async () => {
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

describe("Escape and the close", () => {
  it("Escape puts focus on the link that holds the match, selects it, and deletes the highlights", async () => {
    const user = userEvent.setup();
    await openPage({ body: "See the [output](https://example.invalid/out) now" });
    await openFind(user, "output");

    await user.keyboard("{Escape}");

    expect(group()).toBeNull();
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

  it("Escape with no match puts focus back where it was before find opened", async () => {
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

  it("Escape on Previous and Next closes find too, and an Escape that ends a composition does not", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    await openFind(user, "alpha");

    fireEvent.keyDown(findField(), { key: "Escape", isComposing: true });
    expect(group()).not.toBeNull();

    for (const name of ["Previous match", "Next match"]) {
      if (group() === null) {
        await user.click(findButton());
      }
      fireEvent.keyDown(within(group()!).getByRole("button", { name }), { key: "Escape" });
      expect(group(), name).toBeNull();
    }
  });

  it("Enter during a composition moves to no match", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha alpha" });
    await openFind(user, "alpha");

    fireEvent.keyDown(findField(), { key: "Enter", isComposing: true });

    expect(counter()).toBe("1 of 2");
  });

  it("the toggle closes find, keeps focus on itself, says Find closed, and deletes the highlights", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    await openFind(user, "alpha");
    announce.mockClear();

    await user.click(closeButton());

    expect(group()).toBeNull();
    expect(document.activeElement).toBe(findButton());
    expect(announce.mock.calls).toEqual([["Find closed"]]);
    expect(current()).toBeUndefined();
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("the toggle closes find on %s and says so", async (_name, key) => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    await openFind(user, "alpha");
    closeButton().focus();
    announce.mockClear();

    await user.keyboard(key);

    expect(group()).toBeNull();
    expect(document.activeElement).toBe(findButton());
    expect(announce.mock.calls).toEqual([["Find closed"]]);
  });

  it("Escape in the group says nothing of the close", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    await openFind(user, "omega");
    announce.mockClear();

    await user.keyboard("{Escape}");

    expect(group()).toBeNull();
    expect(announce).not.toHaveBeenCalled();
  });

  it("keeps the text while the page stays, selected and searched again when find opens", async () => {
    const user = userEvent.setup();
    await openPage({ body: "alpha" });
    await openFind(user, "alpha");
    await user.click(closeButton());
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
  });
});

describe("the highlights in WebKit", () => {
  type Registered = { ranges: Range[] };

  it.each([
    ["a new result", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.type(findField(), "a");
    }],
    ["a close", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(closeButton());
    }],
    ["the editor opening", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole("button", { name: "Edit" }));
    }],
    ["the page going", () => {
      cleanup();
    }],
  ])("empty both highlights before they leave the registry on %s", async (_case, action) => {
    const user = userEvent.setup();
    await openPage({ body: "alpha and alpha" });
    await openFind(user, "alph");
    const old = ["task-find", "task-find-current"].map((name) => CSS.highlights.get(name) as unknown as Registered);
    expect(old.map(({ ranges }) => ranges.length)).toEqual([1, 1]);
    const clear = vi.spyOn(Highlight.prototype, "clear");
    const remove = vi.spyOn(CSS.highlights, "delete");

    await action(user);

    expect(clear.mock.contexts.slice(0, 2)).toEqual(old);
    expect(old.map(({ ranges }) => ranges.length)).toEqual([0, 0]);
    expect(remove.mock.calls.slice(0, 2)).toEqual([["task-find"], ["task-find-current"]]);
    expect(Math.max(...clear.mock.invocationCallOrder.slice(0, 2))).toBeLessThan(remove.mock.invocationCallOrder[0]!);
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
    await user.click(within(group()!).getByRole("button", { name: "Next match" }));
    await user.click(within(group()!).getByRole("button", { name: "Previous match" }));

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

  it("says nothing for a text that becomes empty, for Enter in an empty field, or when find opens with no text", async () => {
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
