import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserError, listBrowsers, type Browser } from "../../src/api/browsers";
import { createAppQueryClient } from "../../src/api/client";
import { FileActionError, listEditors, type Editor } from "../../src/api/files";
import { browsersQuery } from "../../src/api/queries";
import { FileLinksGroup, WebLinksGroup } from "../../src/components/link-groups";
import { DEFAULT_LINK_SETTINGS, type LinkSettings } from "../../src/lib/link-settings";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { frame } from "../setup/notice-store";

vi.mock("../../src/api/browsers", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/api/browsers")>(),
  listBrowsers: vi.fn(),
}));

vi.mock("../../src/api/files", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/api/files")>(),
  listEditors: vi.fn(),
}));

const BROWSERS: Browser[] = [
  { id: "com.example.harbor", name: "Harbor", default: true },
  { id: "com.example.meadow", name: "Meadow", default: false },
];

const EDITORS: Editor[] = [
  { id: "com.example.quill", name: "Quill" },
  { id: "com.example.slate", name: "Slate" },
];

const DEV_HINT = "Opens development links: localhost, IP addresses and the development domains.";

/** A promise that the test settles. */
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });

  return { promise, resolve };
}

function setLinks(change: Partial<LinkSettings>): void {
  useUiStore.setState({ linkSettings: { ...DEFAULT_LINK_SETTINGS, ...change } });
}

function links(): LinkSettings {
  return useUiStore.getState().linkSettings;
}

function announced(): string[] {
  return useNoticeStore.getState().announced.map(({ words }) => words);
}

function renderGroups(queryClient = createAppQueryClient()) {
  render(
    <QueryClientProvider client={queryClient}>
      <WebLinksGroup />
      <FileLinksGroup />
    </QueryClientProvider>,
  );

  return queryClient;
}

function trigger(label: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${label} `) });
}

function description(element: HTMLElement): string {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, label: string): Promise<HTMLElement> {
  await user.click(trigger(label));

  return screen.findByRole("menu");
}

function input(): HTMLElement {
  return screen.getByRole("textbox", { name: "Development domains" });
}

beforeEach(() => {
  window.localStorage.clear();
  setLinks({});
  vi.clearAllMocks();
  vi.mocked(listBrowsers).mockResolvedValue(BROWSERS);
  vi.mocked(listEditors).mockResolvedValue(EDITORS);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the groups", () => {
  it("are groups named by their visible titles", async () => {
    renderGroups();

    expect(screen.getByRole("group", { name: "Web links" })).toBeDefined();
    expect(screen.getByRole("group", { name: "File links" })).toBeDefined();
    await screen.findByRole("button", { name: "Open files in macOS default app" });
  });

  it("show the saved values, with the macOS default browser named", async () => {
    setLinks({ devBrowser: "com.example.meadow", fileApp: "com.example.slate", devDomains: ["example.dev"] });
    renderGroups();

    expect(await screen.findByRole("button", { name: "Default browser macOS default (Harbor)" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Development browser Meadow" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Open files in Slate" })).toBeDefined();
    expect(within(screen.getByRole("list", { name: "Development domains" })).getByRole("listitem").textContent)
      .toContain("example.dev");
  });

  it("names the empty browser item without a name when no browser is the default", async () => {
    vi.mocked(listBrowsers).mockResolvedValue(BROWSERS.map((entry) => ({ ...entry, default: false })));
    renderGroups();

    expect(await screen.findByRole("button", { name: "Default browser macOS default" })).toBeDefined();
  });

  it("describes the development browser trigger by its hint", async () => {
    renderGroups();

    const devTrigger = await screen.findByRole("button", { name: "Development browser Same as default browser" });

    expect(description(devTrigger)).toBe(DEV_HINT);
    expect(trigger("Default browser").getAttribute("aria-describedby")).toBeNull();
  });
});

describe("a dropdown", () => {
  it("offers the empty item, a separator, then the list in its order", async () => {
    const user = userEvent.setup();
    renderGroups();
    await screen.findByRole("button", { name: "Default browser macOS default (Harbor)" });

    const menu = await openMenu(user, "Default browser");

    expect(menu.getAttribute("aria-labelledby")).not.toBeNull();
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent))
      .toEqual(["macOS default (Harbor)", "Harbor", "Meadow"]);
    expect(within(menu).getByRole("separator")).toBeDefined();
  });

  it("offers the empty item alone for an empty list", async () => {
    const user = userEvent.setup();
    vi.mocked(listEditors).mockResolvedValue([]);
    renderGroups();
    await screen.findByRole("button", { name: "Open files in macOS default app" });

    const menu = await openMenu(user, "Open files in");

    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["macOS default app"]);
    expect(within(menu).queryByRole("separator")).toBeNull();
  });

  it("writes a selection to the store, and the empty item as an empty string", async () => {
    const user = userEvent.setup();
    setLinks({ devDomains: ["example.dev"] });
    renderGroups();
    await screen.findByRole("button", { name: "Open files in macOS default app" });

    await user.click(within(await openMenu(user, "Default browser")).getByRole("menuitemradio", { name: "Meadow" }));
    await user.click(within(await openMenu(user, "Development browser")).getByRole("menuitemradio", { name: "Harbor" }));
    await user.click(within(await openMenu(user, "Open files in")).getByRole("menuitemradio", { name: "Quill" }));

    expect(links()).toEqual({
      browser: "com.example.meadow",
      devBrowser: "com.example.harbor",
      devDomains: ["example.dev"],
      fileApp: "com.example.quill",
    });
    expect(screen.getByRole("button", { name: "Default browser Meadow" })).toBeDefined();

    await user.click(within(await openMenu(user, "Default browser")).getByRole("menuitemradio", { name: "macOS default (Harbor)" }));

    expect(links().browser).toBe("");
  });

  it("does not write the item that is already shown", async () => {
    const user = userEvent.setup();
    setLinks({ browser: "com.example.meadow" });
    renderGroups();
    await screen.findByRole("button", { name: "Default browser Meadow" });
    const write = vi.spyOn(useUiStore.getState(), "setLinkSettings");

    await user.click(within(await openMenu(user, "Default browser")).getByRole("menuitemradio", { name: "Meadow" }));

    expect(write).not.toHaveBeenCalled();
  });

  it("shows a saved id that is not in the list as the empty item, and keeps the id", async () => {
    const user = userEvent.setup();
    setLinks({ browser: "com.example.gone", fileApp: "com.example.gone-editor" });
    renderGroups();

    expect(await screen.findByRole("button", { name: "Default browser macOS default (Harbor)" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Open files in macOS default app" })).toBeDefined();

    const menu = await openMenu(user, "Default browser");

    expect(within(menu).getByRole("menuitemradio", { checked: true }).textContent).toBe("macOS default (Harbor)");
    expect(links().browser).toBe("com.example.gone");
    expect(links().fileApp).toBe("com.example.gone-editor");
  });
});

describe("a list that loads", () => {
  it("shows Loading… on triggers that stay focusable and do not open, while the domain field works", async () => {
    const user = userEvent.setup();
    vi.mocked(listBrowsers).mockReturnValue(held<Browser[]>().promise);
    renderGroups();

    for (const label of ["Default browser", "Development browser"]) {
      const loading = screen.getByRole("button", { name: `${label} Loading…` });

      expect(loading.getAttribute("aria-disabled")).toBe("true");
      expect(loading.tabIndex).toBe(0);
      expect(loading.hasAttribute("disabled")).toBe(false);
    }

    await user.click(trigger("Default browser"));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger("Default browser"));

    await user.type(input(), "example.dev{Enter}");

    expect(links().devDomains).toEqual(["example.dev"]);
    expect(await screen.findByRole("button", { name: "Open files in macOS default app" })).toBeDefined();
  });
});

describe("a list that did not load", () => {
  const LINE = "The browser list did not load.";

  it("shows the line and Retry under the title, describes the triggers and Retry by the line, and speaks it", async () => {
    vi.mocked(listBrowsers).mockRejectedValue(new BrowserError("refused"));
    renderGroups();

    const line = await screen.findByText(LINE);
    const retry = screen.getByRole("button", { name: "Retry the browser list" });

    expect(line.closest("[role=group]")).toBe(screen.getByRole("group", { name: "Web links" }));
    expect(retry.textContent).toBe("Retry the browser list");
    expect(description(retry)).toBe(LINE);
    expect(description(screen.getByRole("button", { name: "Default browser Not loaded" }))).toBe(LINE);
    expect(description(screen.getByRole("button", { name: "Development browser Not loaded" }))).toBe(`${LINE} ${DEV_HINT}`);
    expect(trigger("Default browser").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Open files in macOS default app" })).toBeDefined();
    await frame();
    expect(announced()).toEqual([LINE]);
  });

  it("shows no line while a later visit loads the list again, and shows and speaks a new failure", async () => {
    const queryClient = createAppQueryClient();
    vi.mocked(listBrowsers).mockRejectedValue(new BrowserError("refused"));
    renderGroups(queryClient);
    await screen.findByText(LINE);
    await frame();
    cleanup();

    renderGroups(queryClient);

    expect(screen.getByRole("button", { name: "Default browser Loading…" }).getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByText(LINE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry the browser list" })).toBeNull();

    await screen.findByText(LINE);
    await frame();
    expect(announced()).toEqual([LINE, LINE]);
    expect(vi.mocked(listBrowsers)).toHaveBeenCalledTimes(2);
  });

  it("keeps the line while a Retry runs, then shows the values and moves focus to the first dropdown", async () => {
    const user = userEvent.setup();
    vi.mocked(listBrowsers).mockRejectedValue(new BrowserError("refused"));
    renderGroups();
    await screen.findByText(LINE);
    const second = held<Browser[]>();
    vi.mocked(listBrowsers).mockReturnValue(second.promise);

    await user.click(screen.getByRole("button", { name: "Retry the browser list" }));

    expect(screen.getByText(LINE)).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry the browser list" })).toBe(document.activeElement);
    expect(description(screen.getByRole("button", { name: "Default browser Loading…" }))).toBe(LINE);

    await act(async () => {
      second.resolve(BROWSERS);
      await second.promise;
    });

    await waitFor(() => {
      expect(screen.queryByText(LINE)).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Default browser macOS default (Harbor)" }));
    await frame();
    expect(announced()).toEqual([LINE]);
  });

  it("speaks the line again when a Retry fails again", async () => {
    const user = userEvent.setup();
    const EDITOR_LINE = "The editor list did not load.";
    vi.mocked(listEditors).mockRejectedValue(new FileActionError("refused", 500));
    renderGroups();
    await screen.findByText(EDITOR_LINE);
    await frame();

    await user.click(screen.getByRole("button", { name: "Retry the editor list" }));

    await waitFor(() => {
      expect(announced()).toEqual([EDITOR_LINE, EDITOR_LINE]);
    });
    expect(screen.getByRole("button", { name: "Open files in Not loaded" })).toBeDefined();
    expect(vi.mocked(listEditors)).toHaveBeenCalledTimes(2);
  });

  it("keeps the line silent when a background refetch fails again", async () => {
    vi.mocked(listBrowsers).mockRejectedValue(new BrowserError("refused"));
    const queryClient = renderGroups();
    await screen.findByText(LINE);
    await frame();

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: browsersQuery().queryKey });
    });
    await frame();

    expect(vi.mocked(listBrowsers)).toHaveBeenCalledTimes(2);
    expect(screen.getByText(LINE)).toBeDefined();
    expect(announced()).toEqual([LINE]);
  });

  it("keeps the data, and shows and speaks no line, when a background refetch fails", async () => {
    const queryClient = renderGroups();
    await screen.findByRole("button", { name: "Default browser macOS default (Harbor)" });
    vi.mocked(listBrowsers).mockRejectedValue(new BrowserError("refused"));

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: browsersQuery().queryKey });
    });
    await frame();

    expect(screen.queryByText(LINE)).toBeNull();
    expect(screen.getByRole("button", { name: "Default browser macOS default (Harbor)" })).toBeDefined();
    expect(announced()).toEqual([]);
  });
});

describe("the domain field", () => {
  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  async function renderReady() {
    renderGroups();
    await screen.findByRole("button", { name: "Open files in macOS default app" });
  }

  it("saves the host of a typed address on Enter, clears the text and speaks it", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.type(input(), "https://Example.dev/path{Enter}");

    expect(links().devDomains).toEqual(["example.dev"]);
    expect(input()).toHaveProperty("value", "");
    await frame();
    expect(announced()).toEqual(["example.dev added."]);
    expect(within(screen.getByRole("list", { name: "Development domains" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("keeps the other settings when it saves a domain", async () => {
    const user = userEvent.setup();
    setLinks({ browser: "com.example.meadow", fileApp: "com.example.quill", devDomains: ["example.dev"] });
    renderGroups();
    await screen.findByRole("button", { name: "Open files in Quill" });

    await user.type(input(), "localhost{Enter}");

    expect(links()).toEqual({
      browser: "com.example.meadow",
      devBrowser: "",
      devDomains: ["example.dev", "localhost"],
      fileApp: "com.example.quill",
    });
  });

  it("shows the error on text that is not a domain, speaks it, keeps the text and saves nothing", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.type(input(), "my site{Enter}");

    expect(screen.getByText("Not a domain name.")).toBeDefined();
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(description(input())).toContain("Not a domain name.");
    expect(input()).toHaveProperty("value", "my site");
    expect(links().devDomains).toEqual([]);
    await frame();
    expect(announced()).toEqual(["Not a domain name."]);
  });

  it("clears the error when the text changes", async () => {
    const user = userEvent.setup();
    await renderReady();
    await user.type(input(), "my site{Enter}");

    await user.type(input(), "x");

    expect(screen.queryByText("Not a domain name.")).toBeNull();
    expect(input().getAttribute("aria-invalid")).toBeNull();
  });

  it("clears a duplicate, speaks it and saves nothing", async () => {
    const user = userEvent.setup();
    setLinks({ devDomains: ["example.dev"] });
    await renderReady();
    const write = vi.spyOn(useUiStore.getState(), "setLinkSettings");

    await user.type(input(), "EXAMPLE.dev{Enter}");

    expect(input()).toHaveProperty("value", "");
    expect(write).not.toHaveBeenCalled();
    expect(screen.queryByText("Not a domain name.")).toBeNull();
    await frame();
    expect(announced()).toEqual(["example.dev is already in the list."]);
  });

  it("does nothing on Enter in an empty input", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.type(input(), "   {Enter}");

    expect(links().devDomains).toEqual([]);
    expect(screen.queryByText("Not a domain name.")).toBeNull();
  });

  it("does nothing on Enter during a composition", async () => {
    await renderReady();
    fireEvent.change(input(), { target: { value: "example.dev" } });

    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });

    expect(links().devDomains).toEqual([]);
    expect(input()).toHaveProperty("value", "example.dev");
  });

  it("adds the text on a blur, also with no element that takes focus", async () => {
    await renderReady();
    fireEvent.change(input(), { target: { value: "192.168.0.10" } });

    fireEvent.blur(input(), { relatedTarget: null });

    expect(links().devDomains).toEqual(["192.168.0.10"]);
    expect(input()).toHaveProperty("value", "");
  });

  it("adds nothing on a blur while the window has no focus", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await renderReady();
    fireEvent.change(input(), { target: { value: "example.dev" } });

    fireEvent.blur(input());

    expect(links().devDomains).toEqual([]);
    expect(input()).toHaveProperty("value", "example.dev");
  });

  it("names the field when a blur leaves text that is not a domain", async () => {
    const user = userEvent.setup();
    await renderReady();
    await user.type(input(), "my site");

    await user.tab();

    expect(screen.getByText("Not a domain name.")).toBeDefined();
    await frame();
    expect(announced()).toEqual(["Development domains: not a domain name."]);
  });

  it("removes a domain with its button, speaks it and moves focus to the input", async () => {
    const user = userEvent.setup();
    setLinks({ devDomains: ["example.dev", "example.test"] });
    await renderReady();

    await user.click(screen.getByRole("button", { name: "Remove example.dev" }));

    expect(links().devDomains).toEqual(["example.test"]);
    expect(document.activeElement).toBe(input());
    await frame();
    expect(announced()).toEqual(["example.dev removed."]);
  });

  it("puts the remove buttons before the input in the tab order", async () => {
    const user = userEvent.setup();
    setLinks({ devDomains: ["example.dev", "example.test"] });
    await renderReady();
    screen.getByRole("button", { name: "Development browser Same as default browser" }).focus();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove example.dev" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove example.test" }));
    await user.tab();
    expect(document.activeElement).toBe(input());
  });

  it("removes no chip on Backspace in an empty input", async () => {
    const user = userEvent.setup();
    setLinks({ devDomains: ["example.dev"] });
    await renderReady();

    await user.type(input(), "{Backspace}");

    expect(links().devDomains).toEqual(["example.dev"]);
  });

  it("renders no list with no domain", async () => {
    await renderReady();

    expect(screen.queryByRole("list")).toBeNull();
  });
});
