import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { appAvailable } from "../../src/api/app";
import { BrowserError, listBrowsers, openInBrowser, type Browser } from "../../src/api/browsers";
import { createAppQueryClient } from "../../src/api/client";
import { FileActionError, openFile, revealFile } from "../../src/api/files";
import { LinkMenuKeys } from "../../src/components/link-menu";
import { Markdown } from "../../src/components/markdown";
import { DEFAULT_LINK_SETTINGS } from "../../src/lib/link-settings";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { stubAnimations } from "../helpers";
import { frame } from "../setup/notice-store";

vi.mock(import("../../src/api/app"), () => ({ appAvailable: vi.fn(() => true) }));

vi.mock(import("../../src/api/browsers"), async (importOriginal) => ({
  ...await importOriginal(),
  listBrowsers: vi.fn(),
  openInBrowser: vi.fn(),
}));

vi.mock(import("../../src/api/files"), async (importOriginal) => ({
  ...await importOriginal(),
  openFile: vi.fn(),
  revealFile: vi.fn(),
}));

const FOLDER = "/work/saga";
const WEB = "https://example.com/docs";

const SAFARI: Browser = { id: "com.apple.Safari", name: "Safari", default: true };
const CHROME: Browser = { id: "com.google.Chrome", name: "Google Chrome", default: false };
const FIREFOX: Browser = { id: "org.mozilla.firefox", name: "Firefox", default: false };

/** Renders the text on `path` of a router that also knows the task page, as a chat, a task body or a comment does. */
async function renderLinks(text: string, { path = "/", keys = false } = {}) {
  const view = () => <Markdown text={text} base={2} folder={FOLDER} />;
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: view }),
      createRoute({ getParentRoute: () => rootRoute, path: "/tasks/$project/$task", component: view }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });

  await router.load();
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      {keys && <LinkMenuKeys />}
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

async function openMenu(link: HTMLElement = screen.getByRole("link")): Promise<HTMLElement> {
  fireEvent.contextMenu(link, { clientX: 10, clientY: 10 });
  return screen.findByRole("menu");
}

function itemNames(menu: HTMLElement): (string | null)[] {
  return within(menu).getAllByRole("menuitem").map((item) => item.textContent);
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  const write = vi.fn(writeText);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: write } });
  return write;
}

/** Lets a settled write run its continuation. No frame runs between microtasks, so a menu close cannot end here. */
async function microtasks(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await Promise.resolve();
  }
}

function notices() {
  return useNoticeStore.getState().notices.map(({ title, line, words }) => ({ title, line, words }));
}

/** Records the words of each call of `announce`. */
function recordAnnouncements() {
  const original = useNoticeStore.getState().announce;
  const calls: string[] = [];
  useNoticeStore.setState({
    announce: (words) => {
      calls.push(words);
    },
  });
  onTestFinished(() => {
    useNoticeStore.setState({ announce: original });
  });
  return calls;
}

/** The points of the `contextmenu` events that reach the link. */
function contextPoints(link: HTMLElement): [number, number][] {
  const points: [number, number][] = [];
  link.addEventListener("contextmenu", (event) => {
    points.push([event.clientX, event.clientY]);
  });
  return points;
}

/** A first line box at x 60, bottom 28, and a box from (10, 10) to (110, 50) for a link that wraps onto two lines. */
function stubBoxes(link: HTMLElement): void {
  vi.spyOn(link, "getClientRects").mockReturnValue(
    [DOMRect.fromRect({ x: 60, y: 10, width: 50, height: 18 })] as unknown as DOMRectList,
  );
  vi.spyOn(link, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 10, y: 10, width: 100, height: 40 }));
}

function selectAll(element: Element): Range {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return range;
}

beforeEach(() => {
  vi.mocked(appAvailable).mockReturnValue(true);
  vi.mocked(listBrowsers).mockResolvedValue([CHROME, FIREFOX, SAFARI]);
  vi.mocked(openInBrowser).mockResolvedValue();
  vi.mocked(openFile).mockResolvedValue();
  vi.mocked(revealFile).mockResolvedValue();
  useUiStore.setState({ linkSettings: { ...DEFAULT_LINK_SETTINGS, devBrowser: CHROME.id } });
});

afterEach(() => {
  cleanup();
  getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("the link menu", () => {
  it("of a web link lists Copy link, then the default, the development and the other known browsers", async () => {
    await renderLinks(`Read [the docs](${WEB}).`);

    const menu = await openMenu();

    expect(menu.getAttribute("aria-label")).toBe("Web link");
    await waitFor(() => {
      expect(itemNames(menu)).toEqual(["Copy link", "Open in Safari", "Open in Google Chrome", "Open in Firefox"]);
    });
    expect(menu.querySelectorAll("[role='separator']")).toHaveLength(1);
  });

  it.each([
    { text: "[the task](tasma://task/AB-1)", name: "Task link", items: ["Open task", "Copy link"] },
    { text: "[spec](.specs/AB-1.md)", name: "File link", items: ["Open", "Show in Finder", "Copy path"] },
    { text: "[open](vscode://file/Users/x/proj/a.ts:3)", name: "Editor link", items: ["Open", "Copy link"] },
    { text: "[write](mailto:someone@example.com)", name: "Mail link", items: ["Open", "Copy link"] },
  ])("of a $name lists its items, and has the name of its kind", async ({ text, name, items }) => {
    await renderLinks(text);

    const menu = await openMenu();

    expect(menu.getAttribute("aria-label")).toBe(name);
    expect(itemNames(menu)).toEqual(items);
    expect(menu.className).toContain("select-none");
  });

  it("is on a link that carries the marks of the guard and of the menu keys", async () => {
    await renderLinks(`[the docs](${WEB})`);

    const link = screen.getByRole("link");
    expect(link.getAttribute("data-no-context-select")).toBe("");
    expect(link.getAttribute("data-link-menu")).toBe("");
  });
});

describe("the browser items", () => {
  it("open the link in their browser", async () => {
    const user = userEvent.setup();
    await renderLinks(`[the docs](${WEB})`);
    const menu = await openMenu();

    await user.click(await within(menu).findByRole("menuitem", { name: "Open in Firefox" }));

    expect(openInBrowser).toHaveBeenCalledExactlyOnceWith(WEB, FIREFOX.id);
    expect(notices()).toEqual([]);
  });

  it("are not shown while the list loads", async () => {
    vi.mocked(listBrowsers).mockReturnValue(new Promise(() => {}));
    await renderLinks(`[the docs](${WEB})`);

    const menu = await openMenu();

    expect(itemNames(menu)).toEqual(["Copy link"]);
    expect(menu.querySelector("[role='separator']")).toBeNull();
  });

  it("are not shown when the list did not load, and the list loads again at the next open", async () => {
    const user = userEvent.setup();
    vi.mocked(listBrowsers).mockRejectedValue(new BrowserError("The app did not answer the browser list request."));
    await renderLinks(`[the docs](${WEB})`);
    let menu = await openMenu();
    await waitFor(() => {
      expect(listBrowsers).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(itemNames(menu)).toEqual(["Copy link"]);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    vi.mocked(listBrowsers).mockResolvedValue([SAFARI]);

    menu = await openMenu();

    await waitFor(() => {
      expect(itemNames(menu)).toEqual(["Copy link", "Open in Safari"]);
    });
    expect(listBrowsers).toHaveBeenCalledTimes(2);
  });

  it("are not shown outside the app, where the list is not read", async () => {
    vi.mocked(appAvailable).mockReturnValue(false);
    await renderLinks(`[the docs](${WEB})`);

    const menu = await openMenu();

    expect(itemNames(menu)).toEqual(["Copy link"]);
    expect(listBrowsers).not.toHaveBeenCalled();
  });
});

describe("the items of a task link", () => {
  it("open the task in the app", async () => {
    const user = userEvent.setup();
    const router = await renderLinks("[the next task](tasma://task/AB-2)", { path: "/tasks/AB/AB-1?chat=2" });
    const menu = await openMenu();

    await user.click(within(menu).getByRole("menuitem", { name: "Open task" }));

    await waitFor(() => {
      expect(router.state.location.href).toBe("/tasks/AB/AB-2");
    });
  });

  it("keep the search of the task on show, and focus returns to the link", async () => {
    const user = userEvent.setup();
    const router = await renderLinks("[this task](tasma://task/AB-1)", { path: "/tasks/AB/AB-1?chat=2" });
    const link = screen.getByRole("link");
    stubBoxes(link);
    link.focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    const menu = await screen.findByRole("menu");

    await user.click(within(menu).getByRole("menuitem", { name: "Open task" }));

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(router.state.location.href).toBe("/tasks/AB/AB-1?chat=2");
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("link"));
    });
  });

  it("show Open task and Copy link outside the app", async () => {
    vi.mocked(appAvailable).mockReturnValue(false);
    await renderLinks("[the task](tasma://task/AB-1)");

    expect(itemNames(await openMenu())).toEqual(["Open task", "Copy link"]);
  });
});

describe("Open on an editor or a mail link", () => {
  it.each([
    "vscode://file/Users/x/proj/a.ts:3",
    "mailto:someone@example.com",
  ])("is a link to %s that opens outside the window", async (href) => {
    await renderLinks(`[the link](${href})`);
    const menu = await openMenu();

    const open = within(menu).getByRole("menuitem", { name: "Open" });

    expect(open.tagName).toBe("A");
    expect(open.getAttribute("href")).toBe(href);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noreferrer");
  });
});

describe("the items of a file link", () => {
  it("open the file at its line and show it in Finder, by its absolute path", async () => {
    const user = userEvent.setup();
    await renderLinks("[a.ts](src/a.ts#L42)");

    await user.click(within(await openMenu()).getByRole("menuitem", { name: "Open" }));
    await user.click(within(await openMenu()).getByRole("menuitem", { name: "Show in Finder" }));

    expect(openFile).toHaveBeenCalledExactlyOnceWith("/work/saga/src/a.ts", 42);
    expect(revealFile).toHaveBeenCalledExactlyOnceWith("/work/saga/src/a.ts");
  });
});

describe("a plain click on a file link", () => {
  it("opens the file", async () => {
    await renderLinks("[spec](.specs/AB-1.md)");

    fireEvent.click(screen.getByRole("link"));

    expect(openFile).toHaveBeenCalledExactlyOnceWith("/work/saga/.specs/AB-1.md", undefined);
  });

  it("shows the notice at once when the file does not open", async () => {
    vi.mocked(openFile).mockRejectedValue(new FileActionError("The app refused.", 500));
    await renderLinks("[spec](.specs/AB-1.md)");

    fireEvent.click(screen.getByRole("link"));
    await microtasks();

    expect(notices()).toEqual([{
      title: "Tasma cannot open the file.",
      line: "Try again. If the file does not open, restart Tasma.",
      words: ["/work/saga/.specs/AB-1.md"],
    }]);
  });
});

describe("an item that fails", () => {
  it.each([
    {
      text: `[the docs](${WEB})`,
      item: "Open in Google Chrome",
      fails: () => vi.mocked(openInBrowser).mockRejectedValue(new BrowserError("The app refused to open the link with status 500.")),
      notice: { title: "Tasma cannot open the link in Google Chrome.", line: "Try again. If the link does not open, restart Tasma.", words: [WEB] },
    },
    {
      text: "[a.ts](src/a.ts#L42)",
      item: "Open",
      fails: () => vi.mocked(openFile).mockRejectedValue(new FileActionError("The app refused.", 404)),
      notice: { title: "Tasma cannot open the file.", line: "The file does not exist.", words: ["/work/saga/src/a.ts"] },
    },
    {
      text: "[spec](.specs/AB-1.md)",
      item: "Show in Finder",
      fails: () => vi.mocked(revealFile).mockRejectedValue(new FileActionError("The app refused.", 404)),
      notice: { title: "Tasma cannot show the file in Finder.", line: "The file does not exist.", words: ["/work/saga/.specs/AB-1.md"] },
    },
  ])("by $item shows its notice after the menu has closed", async ({ text, item, fails, notice }) => {
    stubAnimations();
    fails();
    await renderLinks(text);
    const menu = await openMenu();

    fireEvent.click(await within(menu).findByRole("menuitem", { name: item }));
    await microtasks();

    expect(notices()).toEqual([]);
    expect(screen.getByRole("menu")).not.toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(notices()).toEqual([notice]);
  });

  /** An Open in Google Chrome whose request fails only at the call of the returned function. */
  function stubSlowBrowserFailure(): () => void {
    let reject: (error: Error) => void = () => {};
    vi.mocked(openInBrowser).mockReturnValue(new Promise((_resolve, rejectOpen) => {
      reject = rejectOpen;
    }));
    return () => {
      reject(new BrowserError("The app refused to open the link with status 500."));
    };
  }

  const CHROME_NOTICE = {
    title: "Tasma cannot open the link in Google Chrome.",
    line: "Try again. If the link does not open, restart Tasma.",
    words: [WEB],
  };

  it("and settles while a second menu is open shows its notice after that menu has closed, with the result of a copy in it", async () => {
    stubAnimations();
    const failOpen = stubSlowBrowserFailure();
    stubClipboard(() => Promise.resolve());
    const announced = recordAnnouncements();
    await renderLinks(`[the docs](${WEB})`);
    fireEvent.click(await within(await openMenu()).findByRole("menuitem", { name: "Open in Google Chrome" }));
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    const menu = await openMenu();
    await act(async () => {
      failOpen();
      await microtasks();
    });

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy link" }));
    await microtasks();

    expect(notices()).toEqual([]);
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(notices()).toEqual([CHROME_NOTICE]);
    expect(announced).toEqual([expect.stringContaining(CHROME_NOTICE.title), "Link copied"]);
  });

  it("shows its notice when the link unmounts before the menu has closed", async () => {
    stubAnimations();
    vi.mocked(openInBrowser).mockRejectedValue(new BrowserError("The app refused to open the link with status 500."));
    await renderLinks(`[the docs](${WEB})`);
    fireEvent.click(await within(await openMenu()).findByRole("menuitem", { name: "Open in Google Chrome" }));
    await microtasks();
    expect(notices()).toEqual([]);

    cleanup();

    expect(notices()).toEqual([CHROME_NOTICE]);
  });

  it("and settles after the link has unmounted with its menu open shows its notice then", async () => {
    stubAnimations();
    const failOpen = stubSlowBrowserFailure();
    await renderLinks(`[the docs](${WEB})`);
    fireEvent.click(await within(await openMenu()).findByRole("menuitem", { name: "Open in Google Chrome" }));
    cleanup();

    failOpen();
    await microtasks();

    expect(notices()).toEqual([CHROME_NOTICE]);
  });
});

describe("a copy", () => {
  it.each([
    { text: `[the docs](${WEB})`, item: "Copy link", value: WEB, words: "Link copied" },
    { text: "[the task](tasma://task/AB-1)", item: "Copy link", value: "tasma://task/AB-1", words: "Link copied" },
    { text: "[a.ts](src/a.ts#L42)", item: "Copy path", value: "/work/saga/src/a.ts", words: "Path copied" },
  ])("by $item writes $value, and announces it after the menu has closed", async ({ text, item, value, words }) => {
    // The close of the menu then ends one frame after the click, as in the app.
    stubAnimations();
    const writeText = stubClipboard(() => Promise.resolve());
    const announced = recordAnnouncements();
    await renderLinks(text);

    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: item }));
    await microtasks();

    expect(writeText).toHaveBeenCalledExactlyOnceWith(value);
    expect(announced).toEqual([]);
    expect(screen.getByRole("menu")).not.toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(announced).toEqual([words]);
    expect(notices()).toEqual([]);
  });

  it("that settles after the menu has closed announces then", async () => {
    const user = userEvent.setup();
    let settle = () => {};
    stubClipboard(() => new Promise((resolve) => {
      settle = resolve;
    }));
    const announced = recordAnnouncements();
    await renderLinks(`[the docs](${WEB})`);
    await user.click(within(await openMenu()).getByRole("menuitem", { name: "Copy link" }));
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    await frame();
    expect(announced).toEqual([]);

    await act(async () => {
      settle();
      await Promise.resolve();
    });

    expect(announced).toEqual(["Link copied"]);
  });

  it.each([
    { text: `[the docs](${WEB})`, item: "Copy link", title: "Tasma cannot copy the link.", value: WEB },
    { text: "[a.ts](src/a.ts#L42)", item: "Copy path", title: "Tasma cannot copy the path.", value: "/work/saga/src/a.ts" },
  ])("that fails by $item shows the notice with the value after the menu has closed", async ({ text, item, title, value }) => {
    stubAnimations();
    stubClipboard(() => Promise.reject(new Error("not allowed")));
    const announced = recordAnnouncements();
    await renderLinks(text);

    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: item }));
    await microtasks();

    expect(notices()).toEqual([]);
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(notices()).toEqual([{ title, line: "Try again.", words: [value] }]);
    // The notice speaks its own text.
    expect(announced).toEqual([expect.stringContaining(title)]);
  });

  it("with no clipboard shows the notice", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    await renderLinks(`[the docs](${WEB})`);

    await user.click(within(await openMenu()).getByRole("menuitem", { name: "Copy link" }));

    await waitFor(() => {
      expect(notices()).toEqual([{ title: "Tasma cannot copy the link.", line: "Try again.", words: [WEB] }]);
    });
  });
});

describe("a right click inside a selection that holds the link", () => {
  it("shows Copy first, which writes the selected text", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard(() => Promise.resolve());
    const announced = recordAnnouncements();
    await renderLinks(`Read <${WEB}> today.`);
    selectAll(screen.getByText(/Read/));

    const menu = await openMenu();

    await waitFor(() => {
      expect(itemNames(menu)).toEqual(["Copy", "Copy link", "Open in Safari", "Open in Google Chrome", "Open in Firefox"]);
    });
    expect(menu.querySelectorAll("[role='separator']")).toHaveLength(2);
    await user.click(within(menu).getByRole("menuitem", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(`Read ${WEB} today.`);
    await waitFor(() => {
      expect(announced).toEqual(["Copied"]);
    });
  });

  it("shows the notice of selected text when the copy fails", async () => {
    const user = userEvent.setup();
    stubClipboard(() => Promise.reject(new Error("not allowed")));
    await renderLinks(`Read [the docs](${WEB}) today.`);
    selectAll(screen.getByText(/Read/));

    await user.click(within(await openMenu()).getByRole("menuitem", { name: "Copy" }));

    await waitFor(() => {
      expect(notices()).toEqual([{
        title: "Tasma cannot copy the text.",
        line: "Press Command-C to copy the selected text.",
        words: [],
      }]);
    });
  });

  it("puts the selection back one frame after the menu has closed and focus has returned", async () => {
    const user = userEvent.setup();
    await renderLinks(`Read [the docs](${WEB}) today.`);
    const link = screen.getByRole("link");
    link.focus();
    const kept = selectAll(screen.getByText(/Read/));
    await openMenu(link);
    getSelection()!.collapseToStart();
    // A focus move can clear the selection in WebKit.
    const clear = () => {
      getSelection()!.collapseToStart();
    };
    document.addEventListener("focusin", clear);
    onTestFinished(() => {
      document.removeEventListener("focusin", clear);
    });

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(document.activeElement).toBe(link);
    });
    await frame();

    const range = getSelection()!.getRangeAt(0);
    expect(range.compareBoundaryPoints(Range.START_TO_START, kept)).toBe(0);
    expect(range.compareBoundaryPoints(Range.END_TO_END, kept)).toBe(0);
  });

  it("leaves a selection that did not change as it is", async () => {
    await renderLinks(`Read [the docs](${WEB}) today.`);
    const kept = selectAll(screen.getByText(/Read/));
    await openMenu();

    // Not user-event: its keyboard replaces the selection.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    await frame();

    expect(getSelection()!.getRangeAt(0)).toBe(kept);
  });

  it("does not show Copy for a selection that does not hold the link", async () => {
    await renderLinks(`Read today.\n\nSee [the docs](${WEB}).`);
    selectAll(screen.getByText("Read today."));

    expect(itemNames(await openMenu())).not.toContain("Copy");
  });
});

describe("a Control-click", () => {
  it("on a file link opens the menu and not the file", async () => {
    await renderLinks("[spec](.specs/AB-1.md)");
    const link = screen.getByRole("link");

    fireEvent.contextMenu(link, { clientX: 10, clientY: 10, ctrlKey: true });
    const opens = fireEvent.click(link, { ctrlKey: true });

    expect(await screen.findByRole("menu")).not.toBeNull();
    expect(opens).toBe(false);
    expect(openFile).not.toHaveBeenCalled();
  });

  it("on a web link does not open the link", async () => {
    await renderLinks(`[the docs](${WEB})`);
    const link = screen.getByRole("link");

    fireEvent.contextMenu(link, { clientX: 10, clientY: 10, ctrlKey: true });

    expect(fireEvent.click(link, { ctrlKey: true })).toBe(false);
    expect(await screen.findByRole("menu")).not.toBeNull();
  });

  it("on a task link does not change the route", async () => {
    const router = await renderLinks("[the next task](tasma://task/AB-2)", { path: "/tasks/AB/AB-1" });
    const link = screen.getByRole("link");

    fireEvent.contextMenu(link, { clientX: 10, clientY: 10, ctrlKey: true });
    fireEvent.click(link, { ctrlKey: true });

    expect(await screen.findByRole("menu")).not.toBeNull();
    expect(router.state.location.href).toBe("/tasks/AB/AB-1");
  });
});

describe("Control-Return on a focused link", () => {
  it("opens the menu below the first line box, and does not open the file", async () => {
    const user = userEvent.setup();
    await renderLinks("[spec](.specs/AB-1.md)");
    const link = screen.getByRole("link");
    stubBoxes(link);
    const points = contextPoints(link);
    link.focus();

    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(await screen.findByRole("menu", { name: "File link" })).not.toBeNull();
    expect(points).toEqual([[60, 33]]);
    expect(openFile).not.toHaveBeenCalled();
  });

  it.each([
    { name: "Shift", keys: "{Control>}{Shift>}{Enter}{/Shift}{/Control}" },
    { name: "Option", keys: "{Control>}{Alt>}{Enter}{/Alt}{/Control}" },
    { name: "Command", keys: "{Control>}{Meta>}{Enter}{/Meta}{/Control}" },
  ])("with $name too opens no menu", async ({ keys }) => {
    const user = userEvent.setup();
    await renderLinks(`[the docs](${WEB})`);
    screen.getByRole("link").focus();

    await user.keyboard(keys);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Enter alone opens the link", async () => {
    const user = userEvent.setup();
    await renderLinks("[spec](.specs/AB-1.md)");
    screen.getByRole("link").focus();

    await user.keyboard("{Enter}");

    expect(openFile).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("the menu keys of VoiceOver", () => {
  async function renderFocused() {
    await renderLinks(`Read [the docs](${WEB}) today.`, { keys: true });
    const link = screen.getByRole("link");
    stubBoxes(link);
    link.focus();
    return { link, paragraph: link.closest("p")!, points: contextPoints(link) };
  }

  it("open the menu of the focused link below the link, for a contextmenu on the link", async () => {
    const { link, points } = await renderFocused();

    const shows = fireEvent.contextMenu(link, { clientX: 70, clientY: 20 });

    expect(await screen.findByRole("menu", { name: "Web link" })).not.toBeNull();
    expect(shows).toBe(false);
    expect(points).toEqual([[60, 33]]);
  });

  it("open the menu of the focused link for a contextmenu at a point inside its box", async () => {
    const { paragraph, points } = await renderFocused();

    const shows = fireEvent.contextMenu(paragraph, { clientX: 20, clientY: 40 });

    expect(await screen.findByRole("menu", { name: "Web link" })).not.toBeNull();
    expect(shows).toBe(false);
    expect(points).toEqual([[60, 33]]);
  });

  it("open no menu for a contextmenu at a point outside the box of the link", async () => {
    const { paragraph, points } = await renderFocused();

    const shows = fireEvent.contextMenu(paragraph, { clientX: 200, clientY: 40 });

    expect(shows).toBe(true);
    expect(points).toEqual([]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("leave a contextmenu that a pointer press started to the link, at the pointer", async () => {
    const { link, paragraph, points } = await renderFocused();

    fireEvent.pointerDown(paragraph);
    fireEvent.contextMenu(paragraph, { clientX: 20, clientY: 40 });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.pointerDown(link);
    fireEvent.contextMenu(link, { clientX: 70, clientY: 20 });

    expect(await screen.findByRole("menu", { name: "Web link" })).not.toBeNull();
    expect(points).toEqual([[70, 20]]);
  });

  it.each(["pointerUp", "pointerCancel", "keyDown"] as const)("take a contextmenu after a %s that ended the press", async (end) => {
    const { paragraph } = await renderFocused();

    fireEvent.pointerDown(paragraph);
    fireEvent[end](paragraph);
    fireEvent.contextMenu(paragraph, { clientX: 20, clientY: 40 });

    expect(await screen.findByRole("menu", { name: "Web link" })).not.toBeNull();
  });

  it("open no menu while no link has focus", async () => {
    await renderLinks(`Read [the docs](${WEB}) today.`, { keys: true });
    const link = screen.getByRole("link");
    stubBoxes(link);

    fireEvent.contextMenu(link.closest("p")!, { clientX: 20, clientY: 40 });

    expect(screen.queryByRole("menu")).toBeNull();
  });
});
