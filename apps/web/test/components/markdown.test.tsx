import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appAvailable } from "../../src/api/app";
import { Markdown } from "../../src/components/markdown";
import { MermaidDiagram } from "../../src/components/mermaid-diagram";
import { remarkTaskHeadings, type HeadingBase } from "../../src/lib/markdown";

vi.mock(import("../../src/api/app"), () => ({ appAvailable: vi.fn(() => false) }));

vi.mock(import("../../src/components/mermaid-diagram"), () => ({
  MermaidDiagram: vi.fn(({ source }: { source: string }) => <div data-diagram>{source}</div>),
}));

vi.mock(import("../../src/lib/markdown"), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, remarkTaskHeadings: vi.fn(original.remarkTaskHeadings) };
});

function renderMarkdown(text: string, base: HeadingBase = 2, title?: string): HTMLElement {
  return render(<Markdown text={text} base={base} title={title} />).container.firstElementChild as HTMLElement;
}

function classOf(element: Element | null | undefined): string | null | undefined {
  return element?.getAttribute("class");
}

/** Renders the text on `/` and on the task page, as the chats, task bodies and comments do. */
async function renderInRouter(text: string, path = "/") {
  const view = () => <Markdown text={text} base={2} />;
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: view }),
      createRoute({ getParentRoute: () => rootRoute, path: "/tasks/$project/$task", component: view }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });

  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}

function descriptionOf(link: HTMLElement): string | undefined {
  return document.getElementById(link.getAttribute("aria-describedby") ?? "")?.textContent;
}

beforeEach(() => {
  vi.mocked(appAvailable).mockReturnValue(false);
});

afterEach(() => {
  cleanup();
});

describe("GitHub-flavoured markdown", () => {
  it("renders a table, a task list and strikethrough", () => {
    const wrapper = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] open\n\n~~gone~~");

    expect([...wrapper.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["a", "b"]);
    expect([...wrapper.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["1", "2"]);
    const boxes = [...wrapper.querySelectorAll("input")];
    expect(boxes.map((box) => [box.type, box.checked, box.disabled])).toEqual([
      ["checkbox", true, true],
      ["checkbox", false, true],
    ]);
    expect(wrapper.querySelector("del")?.textContent).toBe("gone");
  });

  it("renders a task list whose state the screen reader reads as text", () => {
    const wrapper = renderMarkdown("- [x] done\n- [ ] open");

    expect(screen.queryByRole("checkbox")).toBeNull();
    const items = [...wrapper.querySelectorAll("li")];
    expect(items.map((item) => item.textContent)).toEqual(["Done: done", "Not done: open"]);
    expect(items.map((item) => classOf(item.querySelector("span")))).toEqual(["sr-only", "sr-only"]);
  });

  it("keeps the alignment of a table column", () => {
    const wrapper = renderMarkdown("| a | b | c | d |\n|:-:|--:|:--|---|\n| 1 | 2 | 3 | 4 |");

    const cells = [...wrapper.querySelectorAll("th, td")];
    const alignment = ["text-center", "text-right", "text-left"];
    const columns = ["text-center", "text-right", "text-left", "text-left"];
    expect(cells.map((cell) => alignment.filter((name) => cell.classList.contains(name)).join(" "))).toEqual([
      ...columns,
      ...columns,
    ]);
    expect(cells.some((cell) => cell.hasAttribute("style"))).toBe(false);
  });

  it("renders a footnote with no heading element for its label and no back-reference", () => {
    const wrapper = renderMarkdown("Text[^1].\n\n[^1]: The note.");

    expect(wrapper.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
    expect(screen.getByText("Footnotes").tagName).toBe("P");
    expect(classOf(screen.getByText("Footnotes"))).toBe("sr-only");
    expect(wrapper.querySelector("a")).toBeNull();
    expect(wrapper.querySelector("section li")?.textContent.trim()).toBe("The note.");
  });
});

describe("the headings", () => {
  it("take the tag of their rank and the size of their source level", () => {
    const wrapper = renderMarkdown("# One\n\n## Two\n\n### Three\n\n#### Four\n\n###### Six", 2);

    const found = [...wrapper.querySelectorAll("h1, h2, h3, h4, h5, h6")];
    expect(found.map((heading) => [heading.tagName, heading.getAttribute("data-level")])).toEqual([
      ["H2", "1"],
      ["H3", "2"],
      ["H4", "3"],
      ["H5", "4"],
      ["H6", "6"],
    ]);
    const large = "mt-7 font-chrome text-lg font-semibold";
    const medium = "mt-6 font-chrome text-base font-semibold";
    const small = "mt-5 font-chrome text-base font-medium text-subtle";
    expect(found.map((heading) => classOf(heading))).toEqual([large, large, medium, small, small]);
  });

  it("start under a comment title with base 4", () => {
    const wrapper = renderMarkdown("## Two\n\n### Three", 4);

    expect([...wrapper.querySelectorAll("h4, h5")].map((heading) => heading.tagName)).toEqual(["H4", "H5"]);
  });

  it("drop a leading H1 equal to the title", () => {
    const wrapper = renderMarkdown("# Garden: Watering\n\nBody", 2, "garden: watering");

    expect(wrapper.querySelector("h2")).toBeNull();
    expect(wrapper.textContent).toBe("Body");
  });

  it("keep a leading H1 with a footnote reference, and its footnote", () => {
    const wrapper = renderMarkdown(
      "# Garden: watering schedule[^t]\n\nBody\n\n[^t]: The only copy of a note.",
      2,
      "Garden: watering schedule",
    );

    expect(wrapper.querySelector("h2")?.textContent).toBe("Garden: watering schedule1");
    expect(wrapper.querySelector("section li")?.textContent.trim()).toBe("The only copy of a note.");
  });

  it.each([
    { text: "# [Garden spec](https://example.com/doc)\n\nBody", title: "Garden spec" },
    { text: "# [Garden spec][d]\n\nBody\n\n[d]: https://example.com/doc", title: "Garden spec" },
    { text: "# https://example.com/doc\n\nBody", title: "https://example.com/doc" },
  ])("keep a leading H1 that is a link, and its link: $text", ({ text, title }) => {
    const wrapper = renderMarkdown(text, 2, title);

    expect(wrapper.querySelector("h2 a")?.getAttribute("href")).toBe("https://example.com/doc");
  });
});

describe("a link", () => {
  it.each([
    { url: "https://example.com", href: "https://example.com/" },
    { url: "mailto:someone@example.com", href: "mailto:someone@example.com" },
  ])("to $url opens its absolute form", ({ url, href }) => {
    renderMarkdown(`[site](${url})`);

    const link = screen.getByRole("link");
    expect(link.textContent).toBe("site");
    expect(link.getAttribute("href")).toBe(href);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(classOf(link)).toBe("underline underline-offset-2");
    expect(link.querySelector(".sr-only")).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "relative/path",
    "#x",
    "http:/api/items",
    "http:page.invalid/../daemon/items",
    "http:/page.invalid/../items",
    "foo://x",
    "vscode://vscode.git/clone?url=https://example.com/r.git",
    "cursor://anysphere.cursor-deeplink/mcp/install?name=x",
    "vscode://file/Users/x/proj/",
    "vscode://file/Users/x/w.code-workspace",
    "tasma://project/AB",
  ])(
    "to %s renders its text with no element",
    (url) => {
      const wrapper = renderMarkdown(`[the text](${url})`);

      expect(wrapper.querySelector("a")).toBeNull();
      expect(wrapper.querySelector("p")?.innerHTML).toBe("the text");
    },
  );

  it.each(["[](https://example.com/report)", "[ ](https://example.com/report)", "[**`` ``**](https://example.com/report)"])(
    "with no text is named by its URL: %j",
    (text) => {
      renderMarkdown(text);

      expect(screen.getByRole("link").textContent).toBe("https://example.com/report");
    },
  );

  it.each(["[the host](http://[::1]:8080/a)", "<http://[::1]:8080/a>"])("to an IPv6 host opens that host: %j", (text) => {
    renderMarkdown(text);

    expect(screen.getByRole("link").getAttribute("href")).toBe("http://[::1]:8080/a");
  });

  it("to a same-origin path through an autolink or a reference renders no element", () => {
    const wrapper = renderMarkdown("<http:page.invalid/../daemon/items> and [ref]\n\n[ref]: http:/page.invalid/../items");

    expect(wrapper.querySelector("a")).toBeNull();
  });

  it("shows its full URL in a tooltip on keyboard focus", async () => {
    const user = userEvent.setup();
    const { container } = render(<Markdown text="[site](https://example.com/a?b)" base={2} />);

    await user.tab();

    expect(document.activeElement).toBe(screen.getByRole("link"));
    const popup = await screen.findByRole("presentation");
    expect(container.contains(popup)).toBe(false);
    expect(popup.textContent).toBe("https://example.com/a?b");
    expect(classOf(popup.querySelector("span"))).toBe("font-mono");
  });

  it("whose text shows another host names the real host in the link name and in a mark after it", () => {
    const wrapper = renderMarkdown("[https://github.com/acme/repo](https://evil.example/login)");

    const link = screen.getByRole("link");
    expect(link.textContent).toBe("https://github.com/acme/repo (warning: goes to evil.example)");
    expect([...link.querySelectorAll("span")].map((span) => classOf(span))).toEqual(["sr-only"]);
    const mark = wrapper.querySelector("[aria-hidden='true']:has(svg)");
    expect(link.contains(mark)).toBe(false);
    expect(mark?.textContent).toBe("(evil.example)");
    expect(classOf(mark)).toBe("ml-1.5 text-signal wrap-anywhere");
    expect(mark?.querySelector("svg")?.getAttribute("width")).toBe("1em");
  });

  it("sits in a left-to-right bidi isolate, so a bidi control before it cannot reorder its text", () => {
    renderMarkdown("See \u202E[/moc.buhtig//:sptth](https://evil.example/login)");

    const isolate = screen.getByRole("link").parentElement;
    expect(isolate?.tagName).toBe("BDI");
    expect(isolate?.getAttribute("dir")).toBe("ltr");
  });

  it("whose text shows another host has its mark in the bidi isolate of the link", () => {
    renderMarkdown("See \u202E[https://github.com/acme/repo](https://evil.example/login)");

    const isolate = screen.getByRole("link").parentElement;
    expect(isolate?.querySelector("[aria-hidden='true']:has(svg)")?.textContent).toBe("(evil.example)");
  });

  it("isolates its own text, so a bidi control in it cannot reorder the mark after it", () => {
    const wrapper = renderMarkdown("[‮oper/emca/moc.buhtig//:sptth](https://moc.buhtig.ac/login)");

    const link = screen.getByRole("link");
    expect(link.getAttribute("dir")).toBe("ltr");
    const mark = wrapper.querySelector("[aria-hidden='true']:has(svg)");
    expect(mark?.textContent).toBe("(moc.buhtig.ac)");
    expect(link.contains(mark)).toBe(false);
  });

  it.each([
    "Docs: [⁩⁩‮oper/emca/moc.buhtig//:sptth](https://moc.buhtig.ac/login)",
    "Docs: ‮[⁩oper/emca/moc.buhtig//:sptth](https://moc.buhtig.ac/login)",
  ])("in %j has no isolate or override control in its text, so its text cannot close the isolates", (text) => {
    const wrapper = renderMarkdown(text);

    const link = screen.getByRole("link");
    expect(link.textContent).toBe("oper/emca/moc.buhtig//:sptth (warning: goes to moc.buhtig.ac)");
    expect(wrapper.querySelector("[aria-hidden='true']:has(svg)")?.textContent).toBe("(moc.buhtig.ac)");
  });

  it("removes the isolate and override controls from the text of its inner elements", () => {
    renderMarkdown("[**⁩bold** `⁦code⁩` ‮plain](https://example.com)");

    const link = screen.getByRole("link");
    expect(link.querySelector("strong")?.textContent).toBe("bold");
    expect(link.querySelector("code")?.textContent).toBe("code");
    expect(link.textContent).toBe("bold code plain");
  });

  it("keeps the bidi controls of the text around it", () => {
    const wrapper = renderMarkdown("⁧See⁩ ‮[site](https://example.com)");

    expect(wrapper.querySelector("p")?.firstChild?.textContent).toBe("⁧See⁩ ‮");
  });

  it("whose text is only bidi controls is named by its URL", () => {
    renderMarkdown("[⁩‮](https://example.com/a)");

    expect(screen.getByRole("link").textContent).toBe("https://example.com/a");
  });

  it("whose text is not a URL has no mark", () => {
    const wrapper = renderMarkdown("[site](https://example.com)");

    expect(screen.getByRole("link").textContent).toBe("site");
    expect(wrapper.querySelector("svg")).toBeNull();
  });

  it("has its full URL as its description, from a hidden element", () => {
    renderMarkdown("[site](https://example.com)");

    const link = screen.getByRole("link");
    const description = document.getElementById(link.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("https://example.com/");
    expect(description?.hidden).toBe(true);
  });

  it.each([
    "<https://example.com/a>",
    "[https://example.com/a](https://example.com/a)",
    "[](https://example.com/a)",
    "<https://example.com/?filter[status]=open&q=a|b^c{d}>",
    "www.example.com",
    "<someone@example.com>",
    "someone@example.com",
  ])(
    "named by its own URL has no description: %j",
    (text) => {
      const wrapper = renderMarkdown(text);

      expect(screen.getByRole("link").hasAttribute("aria-describedby")).toBe(false);
      expect(wrapper.querySelector("[hidden]")).toBeNull();
    },
  );
});

describe("a task link", () => {
  it.each([
    "http://127.0.0.1:8278/task/AB-1",
    "http://localhost:8278/task/ab-1",
    "http://[::1]:8278/task/AB-1",
    "tasma://task/AB-1",
  ])("to %s opens the task in the same window", async (url) => {
    const user = userEvent.setup();
    const router = await renderInRouter(`See [the task](${url}).`);

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/tasks/AB/AB-1");
    expect(link.hasAttribute("target")).toBe(false);
    expect(link.hasAttribute("rel")).toBe(false);
    expect(link.getAttribute("dir")).toBe("ltr");
    expect(classOf(link)).toBe("underline underline-offset-2");
    await user.click(link);

    await waitFor(() => {
      expect(router.state.location.href).toBe("/tasks/AB/AB-1");
    });
  });

  it("shows its original href in a tooltip on keyboard focus", async () => {
    const user = userEvent.setup();
    await renderInRouter("[the task](http://127.0.0.1:8278/task/AB-1)");

    await user.tab();

    expect(document.activeElement).toBe(screen.getByRole("link"));
    const popup = await screen.findByRole("presentation");
    expect(popup.textContent).toBe("http://127.0.0.1:8278/task/AB-1");
  });

  it("keeps the id its tooltip gives the trigger", async () => {
    await renderInRouter("[the task](tasma://task/AB-1)");

    expect(screen.getByRole("link").id).not.toBe("");
  });

  it("has its original href as its description", async () => {
    await renderInRouter("[the task](tasma://task/AB-1)");

    expect(descriptionOf(screen.getByRole("link"))).toBe("tasma://task/AB-1");
  });

  it("named by its own URL has no description", async () => {
    await renderInRouter("<http://127.0.0.1:8278/task/AB-1>");

    const link = screen.getByRole("link");
    expect(link.textContent).toBe("http://127.0.0.1:8278/task/AB-1");
    expect(link.hasAttribute("aria-describedby")).toBe(false);
  });

  it("whose text shows another host has no host warning", async () => {
    await renderInRouter("[https://github.com/acme/repo](http://127.0.0.1:8278/task/AB-1)");

    expect(screen.getByRole("link").textContent).toBe("https://github.com/acme/repo");
    expect(document.querySelector("svg")).toBeNull();
  });

  it("to the task on show keeps the search, so its chat stays open", async () => {
    const user = userEvent.setup();
    const router = await renderInRouter("[this task](tasma://task/AB-1)", "/tasks/AB/AB-1?chat=2");

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/tasks/AB/AB-1?chat=2");
    await user.click(link);

    expect(router.state.location.href).toBe("/tasks/AB/AB-1?chat=2");
  });

  it("to another task drops the search", async () => {
    const user = userEvent.setup();
    const router = await renderInRouter("[the next task](tasma://task/AB-2)", "/tasks/AB/AB-1?chat=2");

    await user.click(screen.getByRole("link"));

    await waitFor(() => {
      expect(router.state.location.href).toBe("/tasks/AB/AB-2");
    });
  });
});

describe("an editor link", () => {
  it("opens outside the window, with its URL as its description", () => {
    renderMarkdown("[open](vscode://file/Users/x/proj/a.ts:3)");

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("vscode://file/Users/x/proj/a.ts:3");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(descriptionOf(link)).toBe("vscode://file/Users/x/proj/a.ts:3");
  });
});

describe("a file link", () => {
  const FOLDER = "/work/saga";

  function renderInFolder(text: string, folder: string | undefined): HTMLElement {
    return render(<Markdown text={text} base={2} folder={folder} />).container.firstElementChild as HTMLElement;
  }

  function opening() {
    const fetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      () => Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("in the app", () => {
    beforeEach(() => {
      vi.mocked(appAvailable).mockReturnValue(true);
    });

    it("links to the absolute path of a relative link in the folder", () => {
      renderInFolder("[spec](.specs/AB-1.md)", FOLDER);

      const link = screen.getByRole("link");
      expect(link.textContent).toBe("spec");
      expect(link.getAttribute("href")).toBe("file:///work/saga/.specs/AB-1.md");
      expect(link.hasAttribute("target")).toBe(false);
      expect(link.hasAttribute("rel")).toBe(false);
      expect(link.getAttribute("dir")).toBe("ltr");
      expect(classOf(link)).toBe("underline underline-offset-2");
    });

    it("opens the file through the app on a click, with no navigation", () => {
      const fetch = opening();
      renderInFolder("[spec](.specs/AB-1.md)", FOLDER);

      const navigates = fireEvent.click(screen.getByRole("link"));

      expect(navigates).toBe(false);
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        "/app/files/open",
        { method: "POST", body: JSON.stringify({ path: "/work/saga/.specs/AB-1.md" }) },
      );
    });

    it("opens the file at the line of its #L<n> fragment", async () => {
      const user = userEvent.setup();
      const fetch = opening();
      renderInFolder("[a.ts:42](src/a.ts#L42)", FOLDER);

      await user.click(screen.getByRole("link"));

      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        "/app/files/open",
        { method: "POST", body: JSON.stringify({ path: "/work/saga/src/a.ts", line: 42 }) },
      );
    });

    it("opens the file with Enter", async () => {
      const user = userEvent.setup();
      const fetch = opening();
      renderInFolder("[spec](<docs/a b.md>)", FOLDER);

      await user.tab();
      await user.keyboard("{Enter}");

      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        "/app/files/open",
        { method: "POST", body: JSON.stringify({ path: "/work/saga/docs/a b.md" }) },
      );
    });

    it.each([
      { text: "[spec](.specs/AB-1.md)", shown: "/work/saga/.specs/AB-1.md", described: "/work/saga/.specs/AB-1.md" },
      { text: "[a.ts](src/a.ts#L42-L50)", shown: "/work/saga/src/a.ts#L42", described: "/work/saga/src/a.ts, line 42" },
    ])("shows its absolute target in the tooltip and the description: $text", async ({ text, shown, described }) => {
      const user = userEvent.setup();
      renderInFolder(text, FOLDER);

      await user.tab();

      const link = screen.getByRole("link");
      expect(document.activeElement).toBe(link);
      expect((await screen.findByRole("presentation")).textContent).toBe(shown);
      expect(descriptionOf(link)).toBe(described);
    });

    it.each([
      { text: "[src/a.ts](src/a.ts)", described: "/work/saga/src/a.ts" },
      { text: "[](src/a.ts)", described: "/work/saga/src/a.ts" },
      { text: "[/work/saga/a.ts#L4](/work/saga/a.ts#L4)", described: "/work/saga/a.ts, line 4" },
      { text: "[](github.com/acme/app)", described: "/work/saga/github.com/acme/app" },
    ])("named by its relative path or its href is described by its absolute target: $text", ({ text, described }) => {
      renderInFolder(text, FOLDER);

      expect(descriptionOf(screen.getByRole("link"))).toBe(described);
    });

    it("named by its absolute path has no description", () => {
      renderInFolder("[/work/saga/a.ts](/work/saga/a.ts)", FOLDER);

      expect(screen.getByRole("link").hasAttribute("aria-describedby")).toBe(false);
    });

    it("with no text shows its href", () => {
      renderInFolder("[](src/a.ts)", FOLDER);

      expect(screen.getByRole("link").textContent).toBe("src/a.ts");
    });

    it.each([
      {
        text: "[https://github.com/acme/app/pull/7](docs/pr.html)",
        name: "https://github.com/acme/app/pull/7",
        path: "/work/saga/docs/pr.html",
      },
      { text: "[github.com/acme/app](docs/pr.html)", name: "github.com/acme/app", path: "/work/saga/docs/pr.html" },
      { text: "[](www.example.com/a)", name: "www.example.com/a", path: "/work/saga/www.example.com/a" },
      { text: "[](evil.example/%2E%2E/x)", name: "evil.example/%2E%2E/x", path: "/work/saga/evil.example/../x" },
    ])("whose text shows a URL names its absolute path in the link name and in a mark after it: $text", ({ text, name, path }) => {
      const wrapper = renderInFolder(text, FOLDER);

      const link = screen.getByRole("link");
      expect(link.textContent).toBe(`${name} (warning: goes to ${path})`);
      const mark = wrapper.querySelector("[aria-hidden='true']:has(svg)");
      expect(link.contains(mark)).toBe(false);
      expect(link.parentElement?.contains(mark)).toBe(true);
      expect(mark?.textContent).toBe(`(${path})`);
      expect(classOf(mark)).toBe("ml-1.5 text-signal wrap-anywhere");
    });

    it.each([
      "[docs/a.md](docs/a.md)",
      "[README.md](README.md)",
      "[spec](.specs/AB-1.md)",
      "[a.ts:42](src/a.ts#L42)",
      "[](docs/a.md)",
      "[en.lproj/Localizable.strings](en.lproj/Localizable.strings)",
      "[MyApp.xcodeproj/project.pbxproj](MyApp.xcodeproj/project.pbxproj)",
      "[](Assets.xcassets/AppIcon.appiconset/Contents.json)",
      "[conf.d/site.conf](conf.d/site.conf)",
      "[en.lproj/Localizable.strings:42](en.lproj/Localizable.strings#L42)",
      "[](en.lproj/Localizable.strings#L42)",
      "[en.lproj/Localizable.strings](App/en.lproj/Localizable.strings)",
      "[conf.d/site.conf](/work/saga/conf.d/site.conf)",
      "[](github.com/acme/app)",
    ])(
      "whose text shows a path has no mark: %s",
      (text) => {
        const wrapper = renderInFolder(text, FOLDER);

        expect(screen.getByRole("link").textContent).not.toContain("warning");
        expect(wrapper.querySelector("svg")).toBeNull();
      },
    );

    it("of an absolute path links to it with no folder", () => {
      renderInFolder("[a](/work/other/a.md)", undefined);

      expect(screen.getByRole("link").getAttribute("href")).toBe("file:///work/other/a.md");
    });

    it.each([
      { text: "[a](docs/a.md)", folder: undefined },
      { text: "[top](#top)", folder: FOLDER },
      { text: "[home](~/a.md)", folder: FOLDER },
      { text: "[file](file:///work/saga/a.md)", folder: FOLDER },
    ])("renders its text with no element when it does not resolve: $text in $folder", ({ text, folder }) => {
      const wrapper = renderInFolder(text, folder);

      expect(wrapper.querySelector("a")).toBeNull();
    });
  });

  it("renders its text with no element in the browser", () => {
    const wrapper = renderInFolder("[spec](.specs/AB-1.md)", FOLDER);

    expect(wrapper.querySelector("a")).toBeNull();
    expect(wrapper.querySelector("p")?.innerHTML).toBe("spec");
  });
});

describe("an image", () => {
  it("renders as a link with its alt text, and loads nothing", () => {
    const wrapper = renderMarkdown("![a chart](https://example.com/chart.png)");

    const link = screen.getByRole("link");
    expect(link.textContent).toBe("a chart");
    expect(link.getAttribute("href")).toBe("https://example.com/chart.png");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(wrapper.querySelector("img")).toBeNull();
  });

  it("with no alt text renders as a link named by its URL", () => {
    renderMarkdown("![](https://example.com/chart.png)");

    expect(screen.getByRole("link").textContent).toBe("https://example.com/chart.png");
  });

  it("from a reference renders as a link to the source of its definition", () => {
    const wrapper = renderMarkdown("![a chart][Chart]\n\n[chart]: https://example.com/chart.png");

    expect(screen.getByRole("link").getAttribute("href")).toBe("https://example.com/chart.png");
    expect(wrapper.querySelector("img")).toBeNull();
  });

  it.each(["[![a chart](https://example.com/chart.png)](https://example.com/report)", "[![a chart][chart]][report]\n\n[chart]: https://example.com/chart.png\n[report]: https://example.com/report"])(
    "inside a link renders as the text of that one link: %j",
    (text) => {
      const wrapper = renderMarkdown(text);

      const links = screen.getAllByRole("link");
      expect(links.map((link) => [link.getAttribute("href"), link.textContent])).toEqual([
        ["https://example.com/report", "a chart"],
      ]);
      expect(wrapper.querySelector("img")).toBeNull();
    },
  );

  it.each([
    "[![](chart.png)](https://example.com/report)",
    "[![](https://example.com/badge.svg)](https://example.com/report)",
    "[![][chart]][report]\n\n[chart]: chart.png\n[report]: https://example.com/report",
  ])("with no alt text inside a link leaves the link named by its own URL: %j", (text) => {
    renderMarkdown(text);

    const links = screen.getAllByRole("link");
    expect(links.map((link) => [link.getAttribute("href"), link.textContent])).toEqual([
      ["https://example.com/report", "https://example.com/report"],
    ]);
  });

  it("from an IPv6 host renders as a link to that host", () => {
    renderMarkdown("![a chart](http://[::1]/chart.png)");

    expect(screen.getByRole("link").getAttribute("href")).toBe("http://[::1]/chart.png");
  });

  it("from a same-origin path renders its alt text alone", () => {
    const wrapper = renderMarkdown("![a chart](http:page.invalid/../daemon/chart.png)");

    expect(wrapper.querySelector("a, img")).toBeNull();
  });

  it.each(["chart.png", "data:image/png;base64,AAAA", "mailto:someone@example.com"])(
    "from %s renders its alt text alone",
    (url) => {
      const wrapper = renderMarkdown(`![a chart](${url})`);

      expect(wrapper.querySelector("a, img")).toBeNull();
      expect(wrapper.querySelector("p")?.innerHTML).toBe("a chart");
    },
  );
});

describe("raw HTML", () => {
  it("shows as code, and no element of it exists", () => {
    const wrapper = renderMarkdown("<img src=x onerror=alert(1)>\n\nText with <b>bold</b> tags.");

    expect(wrapper.querySelector("img, b")).toBeNull();
    expect(wrapper.querySelector("pre > code")?.textContent).toBe("<img src=x onerror=alert(1)>\n");
    expect([...wrapper.querySelectorAll("p > code")].map((code) => code.textContent)).toEqual(["<b>", "</b>"]);
  });
});

describe("a single newline", () => {
  function cuesOf(link: HTMLElement): unknown {
    return {
      cues: [...link.querySelectorAll(".sr-only")].map((span) => span.textContent),
      description: document.getElementById(link.getAttribute("aria-describedby") ?? "")?.textContent,
      mark: link.closest("bdi")?.querySelector("[aria-hidden='true']")?.textContent,
    };
  }

  it("renders as a line break, and a list after the lines stays a list", () => {
    const wrapper = renderMarkdown("**Problem**: one\n**Outcome**: two\n**Scope**:\n- first");

    expect(wrapper.querySelectorAll("p")).toHaveLength(1);
    expect(wrapper.querySelector("p")?.innerHTML).toBe(
      '<strong class="font-medium">Problem</strong>: one<br>\n<strong class="font-medium">Outcome</strong>: two<br>\n'
      + '<strong class="font-medium">Scope</strong>:',
    );
    expect(wrapper.querySelector("p + ul li")?.textContent).toBe("first");
  });

  it.each(["hard  \nbreak", "hard\\\nbreak"])("after a hard break renders one line break: %j", (text) => {
    const wrapper = renderMarkdown(text);

    expect(wrapper.querySelector("p")?.innerHTML).toBe("hard<br>\nbreak");
  });

  it("stays a newline in a code block and a space in inline code", () => {
    const wrapper = renderMarkdown("```\none\ntwo\n```\n\n`three\nfour`");

    expect(wrapper.querySelector("pre > code")?.textContent).toBe("one\ntwo\n");
    expect(wrapper.querySelector("p > code")?.textContent).toBe("three four");
    expect(wrapper.querySelector("br")).toBeNull();
  });

  it.each([
    { lines: "https://other.example\nlogin", spaced: "https://other.example login" },
    { lines: "read\nmore", spaced: "read more" },
  ])("in the text of a link renders as a line break, and the link keeps the cues of $spaced", ({ lines, spaced }) => {
    renderMarkdown(`[${lines}](https://site.example)\n\n[${spaced}](https://site.example)`);

    const [broken, plain] = screen.getAllByRole("link");
    expect(broken?.querySelectorAll("br")).toHaveLength(1);
    expect(plain?.querySelector("br")).toBeNull();
    expect(cuesOf(plain!)).toEqual({ cues: [], description: "https://site.example/", mark: undefined });
    expect(cuesOf(broken!)).toEqual(cuesOf(plain!));
  });
});

describe("a re-render", () => {
  it("parses the text again only when a prop changes", () => {
    vi.mocked(remarkTaskHeadings).mockClear();
    const props = { text: "## Goal\n\n[site](https://example.com)\n\nOne", base: 2 } as const;
    const { rerender } = render(<Markdown {...props} />);

    rerender(<Markdown {...props} />);
    expect(remarkTaskHeadings).toHaveBeenCalledTimes(1);

    rerender(<Markdown {...props} text={"## Goal\n\n[site](https://example.com)\n\nTwo"} />);
    expect(remarkTaskHeadings).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Two")).toBeTruthy();
  });
});

describe("the styles", () => {
  it("give each element its classes", () => {
    const wrapper = renderMarkdown(
      [
        "Para with **strong** and `code`.",
        "- item",
        "1. first",
        "> quote",
        "***",
        "```\nblock\n```",
        "| h |\n|---|\n| d |",
      ].join("\n\n"),
    );

    const classOfFirst = (selector: string) => classOf(wrapper.querySelector(selector));
    expect(classOfFirst("p")).toBe("mt-2.5");
    expect(classOfFirst("strong")).toBe("font-medium");
    expect(classOfFirst("p > code")).toBe("rounded-[4px] bg-surface-2 px-[5px] py-px font-mono text-xs-plus");
    expect(classOfFirst("ul")).toBe("mt-2.5 list-disc pl-5");
    expect(classOfFirst("ol")).toBe("mt-2.5 list-decimal pl-5");
    expect(classOfFirst("li")).toBe("mt-1");
    expect(classOfFirst("blockquote")).toBe("mt-2.5 border-l-2 border-line pl-3 text-subtle");
    expect(classOfFirst("hr")).toBe("mt-5 border-line");
    expect(classOfFirst("pre")).toBe(
      "mt-3 overflow-x-auto rounded-card bg-surface-2 px-3.5 py-3 font-mono text-xs-plus [&>code]:bg-transparent [&>code]:p-0",
    );
    expect(classOfFirst("table")).toBe("w-full border-collapse text-sm");
    expect(classOfFirst("th")).toBe(
      "border-b border-line py-2 pr-3 text-left align-top text-xs-plus font-medium text-subtle wrap-normal",
    );
    expect(classOfFirst("td")).toBe("border-b border-line py-2 pr-3 text-left align-top wrap-normal");
  });

  it("put a table in a box that scrolls and is a tab stop, and add no break to its text", () => {
    const wrapper = renderMarkdown(
      [
        "| # | Branch | Hash |",
        "|---|---|---|",
        "| 12 | garden-watering-schedule-tests | ab**cdef0123456789abcdef0123** |",
      ].join("\n"),
    );

    const box = wrapper.querySelector("table")?.parentElement;
    expect(box?.parentElement).toBe(wrapper);
    expect(classOf(box)).toBe("mt-3 overflow-x-auto");
    expect(box?.tabIndex).toBe(0);
    expect([...wrapper.querySelectorAll("td")].map((cell) => cell.innerHTML)).toEqual([
      "12",
      "garden-watering-schedule-tests",
      'ab<strong class="font-medium">cdef0123456789abcdef0123</strong>',
    ]);
  });

  it("make a code block a tab stop, so a keyboard can scroll it", () => {
    const wrapper = renderMarkdown("```\nblock\n```");

    expect(wrapper.querySelector("pre")?.tabIndex).toBe(0);
  });

  it("give the box of a task item its margin and the item no bullet", () => {
    const wrapper = renderMarkdown("- [ ] open");

    expect(classOf(wrapper.querySelector("input"))).toBe("mr-1.5");
    expect(classOf(wrapper.querySelector("li"))).toBe("mt-1 list-none");
  });

  it("wrap long tokens and remove the top margin of the first element", () => {
    const wrapper = renderMarkdown("Body");

    expect(classOf(wrapper)).toBe("wrap-anywhere [&>:first-child]:mt-0");
  });
});

describe("a Mermaid block", () => {
  it("renders as a diagram, and the code blocks beside it stay code", () => {
    const wrapper = renderMarkdown("```mermaid\nflowchart LR\n  seed --> sprout\n```\n\n```js\nwater()\n```");

    expect(MermaidDiagram).toHaveBeenCalledWith({ source: "flowchart LR\n  seed --> sprout\n", draw: true }, undefined);
    expect(wrapper.querySelector("[data-diagram]")?.textContent).toBe("flowchart LR\n  seed --> sprout\n");
    expect([...wrapper.querySelectorAll("pre > code")].map((code) => code.textContent)).toEqual(["water()\n"]);
  });

  it("is not drawn in a text without diagrams, and the code blocks beside it stay code", () => {
    const { container } = render(<Markdown text={"```mermaid\nflowchart LR\n```\n\n```js\nwater()\n```"} base={2} diagrams={false} />);

    expect(MermaidDiagram).toHaveBeenLastCalledWith({ source: "flowchart LR\n", draw: false }, undefined);
    expect([...container.querySelectorAll("pre > code")].map((code) => code.textContent)).toEqual(["water()\n"]);
  });
});
