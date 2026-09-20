import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../../src/components/markdown";
import { remarkTaskHeadings, type HeadingBase } from "../../src/lib/markdown";

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
    const small = "mt-5 font-chrome text-base font-medium text-muted";
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
  ])("to $url opens its absolute form in a new tab", ({ url, href }) => {
    renderMarkdown(`[site](${url})`);

    const link = screen.getByRole("link");
    expect(link.textContent).toBe("site (opens in a new tab)");
    expect(link.getAttribute("href")).toBe(href);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(classOf(link)).toBe("underline underline-offset-2");
    expect(classOf(link.lastElementChild)).toBe("sr-only");
  });

  it.each(["javascript:alert(1)", "relative/path", "#x", "http:/api/items", "http:page.invalid/../daemon/items", "http:/page.invalid/../items"])(
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

      expect(screen.getByRole("link").textContent).toBe("https://example.com/report (opens in a new tab)");
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
});

describe("an image", () => {
  it("renders as a link with its alt text, and loads nothing", () => {
    const wrapper = renderMarkdown("![a chart](https://example.com/chart.png)");

    const link = screen.getByRole("link");
    expect(link.textContent).toBe("a chart (opens in a new tab)");
    expect(link.getAttribute("href")).toBe("https://example.com/chart.png");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(wrapper.querySelector("img")).toBeNull();
  });

  it("with no alt text renders as a link named by its URL", () => {
    renderMarkdown("![](https://example.com/chart.png)");

    expect(screen.getByRole("link").textContent).toBe("https://example.com/chart.png (opens in a new tab)");
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
        ["https://example.com/report", "a chart (opens in a new tab)"],
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
      ["https://example.com/report", "https://example.com/report (opens in a new tab)"],
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
    expect(classOfFirst("blockquote")).toBe("mt-2.5 border-l-2 border-line pl-3 text-muted");
    expect(classOfFirst("hr")).toBe("mt-5 border-line");
    expect(classOfFirst("pre")).toBe(
      "mt-3 overflow-x-auto rounded-card bg-surface-2 px-3.5 py-3 font-mono text-xs-plus [&>code]:bg-transparent [&>code]:p-0",
    );
    expect(classOfFirst("table")).toBe("w-full border-collapse text-sm");
    expect(classOfFirst("th")).toBe(
      "border-b border-line py-2 pr-3 text-left align-top text-xs-plus font-medium text-muted wrap-normal",
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
