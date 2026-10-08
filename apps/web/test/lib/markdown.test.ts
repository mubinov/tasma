import type { Heading, PhrasingContent, Root, RootContent } from "mdast";
import type { ExtraProps } from "react-markdown";
import { describe, expect, it } from "vitest";
import {
  hiddenHost,
  markdownUrl,
  mermaidSource,
  rehypeLinkText,
  remarkImagesAsLinks,
  remarkRawAsSource,
  remarkTaskHeadings,
  type HeadingBase,
} from "../../src/lib/markdown";

function heading(depth: Heading["depth"], ...children: (PhrasingContent | string)[]): Heading {
  return {
    type: "heading",
    depth,
    children: children.map((child) => (typeof child === "string" ? { type: "text", value: child } : child)),
  };
}

function root(...children: RootContent[]): Root {
  return { type: "root", children };
}

function rankHeadings(options: Parameters<typeof remarkTaskHeadings>[0], ...children: RootContent[]): Root {
  const tree = root(...children);
  remarkTaskHeadings(options)(tree);
  return tree;
}

function tagsOf(tree: Root): unknown[] {
  return tree.children.map((node) => node.data?.hName);
}

type HastElement = NonNullable<ExtraProps["node"]>;

function element(tagName: string, className: string[] | undefined, ...children: HastElement["children"]): HastElement {
  return { type: "element", tagName, properties: className === undefined ? {} : { className }, children };
}

function codeBlock(className: string[] | undefined, value: string): HastElement {
  return element("pre", undefined, element("code", className, { type: "text", value }));
}

describe("the leading heading equal to the title", () => {
  it("is dropped, ignoring case and the spaces at both ends", () => {
    const tree = rankHeadings({ base: 2, title: "Garden: Watering" }, heading(1, "  garden: WATERING "), heading(2, "Goal"));

    expect(tree.children).toEqual([expect.objectContaining({ depth: 2 })]);
  });

  it("is compared by the text of all its children", () => {
    const tree = rankHeadings(
      { base: 2, title: "Garden: watering schedule" },
      heading(1, "Garden: ", { type: "inlineCode", value: "watering" }, { type: "break" }, { type: "emphasis", children: [{ type: "text", value: " schedule" }] }),
    );

    expect(tree.children).toEqual([]);
  });

  it.each([
    { name: "an H1 that is not the first node", children: [heading(2, "Goal"), heading(1, "Title")] },
    { name: "a first H2 equal to the title", children: [heading(2, "Title")] },
    { name: "a first H1 with other text", children: [heading(1, "Other")] },
    {
      name: "a first H1 whose other content is a footnote reference",
      children: [heading(1, "Title", { type: "footnoteReference", identifier: "t" })],
    },
    {
      name: "a first H1 whose other content is an image",
      children: [heading(1, "Title", { type: "image", url: "https://example.com/a.png", alt: "" })],
    },
    {
      name: "a first H1 whose other content is an image reference",
      children: [heading(1, "Title", { type: "imageReference", identifier: "a", referenceType: "full", alt: "" })],
    },
    {
      name: "a first H1 that is a link with the title as its text",
      children: [heading(1, { type: "link", url: "https://example.com/doc", children: [{ type: "text", value: "Title" }] })],
    },
    {
      name: "a first H1 that is a link reference with the title as its text",
      children: [
        heading(1, { type: "linkReference", identifier: "d", referenceType: "full", children: [{ type: "text", value: "Title" }] }),
      ],
    },
    {
      name: "a first H1 whose text is raw HTML",
      children: [heading(1, { type: "html", value: "Title" })],
    },
  ])("keeps $name", ({ children }) => {
    const tree = rankHeadings({ base: 2, title: "Title" }, ...children);

    expect(tree.children).toHaveLength(children.length);
  });

  it("is kept when no title is given", () => {
    const tree = rankHeadings({ base: 2 }, heading(1, "Title"));

    expect(tree.children).toHaveLength(1);
  });
});

describe("the heading tags", () => {
  it.each<{ name: string; base: HeadingBase; depths: Heading["depth"][]; tags: string[] }>([
    { name: "H2 and H3 with base 2", base: 2, depths: [2, 3], tags: ["h2", "h3"] },
    { name: "H1 and H3 with base 2, with no skipped level", base: 2, depths: [1, 3], tags: ["h2", "h3"] },
    { name: "H2 and H3 with base 4", base: 4, depths: [2, 3], tags: ["h4", "h5"] },
    { name: "a repeated depth", base: 2, depths: [2, 3, 2, 3], tags: ["h2", "h3", "h2", "h3"] },
    {
      name: "six distinct depths with base 2, stopping at h6",
      base: 2,
      depths: [1, 2, 3, 4, 5, 6],
      tags: ["h2", "h3", "h4", "h5", "h6", "h6"],
    },
  ])("follow the nesting of the source depths: $name", ({ base, depths, tags }) => {
    const tree = rankHeadings({ base }, ...depths.map((depth) => heading(depth, "Heading")));

    expect(tagsOf(tree)).toEqual(tags);
  });

  it.each<{ name: string; base: HeadingBase; depths: Heading["depth"][]; tags: string[] }>([
    { name: "a first heading deeper than a later one starts at the base", base: 2, depths: [3, 2, 3], tags: ["h2", "h2", "h3"] },
    { name: "a heading two ranks under the one before it", base: 2, depths: [1, 3, 2], tags: ["h2", "h3", "h3"] },
    { name: "a first heading deeper than a later one with base 4", base: 4, depths: [4, 2], tags: ["h4", "h4"] },
    { name: "a later sibling of a heading at the base", base: 2, depths: [3, 4, 3, 2], tags: ["h2", "h3", "h2", "h2"] },
  ])("skip no level: $name", ({ base, depths, tags }) => {
    const tree = rankHeadings({ base }, ...depths.map((depth) => heading(depth, "Heading")));

    expect(tagsOf(tree)).toEqual(tags);
  });

  it("carry the source depth as data-level", () => {
    const tree = rankHeadings({ base: 4 }, heading(1, "One"), heading(3, "Three"));

    expect(tree.children.map((node) => node.data?.hProperties)).toEqual([{ dataLevel: 1 }, { dataLevel: 3 }]);
  });

  it("rank a heading inside a block with the others", () => {
    const quoted = heading(4, "Quoted");
    rankHeadings({ base: 2 }, heading(2, "Goal"), { type: "blockquote", children: [quoted] });

    expect(quoted.data).toEqual({ hName: "h3", hProperties: { dataLevel: 4 } });
  });

  it("start again at the base in each footnote, and continue the text after it", () => {
    const noteHeading = heading(4, "Note");
    const noteSubheading = heading(5, "Detail");
    const secondNoteHeading = heading(3, "Other note");
    const tree = rankHeadings(
      { base: 2 },
      heading(2, "Goal"),
      heading(3, "Part"),
      { type: "footnoteDefinition", identifier: "1", children: [noteHeading, noteSubheading] },
      heading(4, "Detail of the part"),
      { type: "blockquote", children: [{ type: "footnoteDefinition", identifier: "2", children: [secondNoteHeading] }] },
    );

    expect(tagsOf(tree)).toEqual(["h2", "h3", undefined, "h4", undefined]);
    expect([noteHeading, noteSubheading, secondNoteHeading].map((node) => node.data?.hName)).toEqual(["h2", "h3", "h2"]);
  });

  it("of the text do not change for the depths in a footnote", () => {
    const tree = rankHeadings(
      { base: 2 },
      heading(1, "A"),
      heading(3, "B"),
      heading(4, "C"),
      { type: "footnoteDefinition", identifier: "x", children: [heading(2, "X")] },
      heading(3, "D"),
    );

    expect(tagsOf(tree)).toEqual(["h2", "h3", "h4", undefined, "h3"]);
  });
});

describe("raw HTML", () => {
  function showRawAsSource(...children: RootContent[]): Root {
    const tree = root(...children);
    remarkRawAsSource()(tree);
    return tree;
  }

  it("in flow becomes a code block with the same text", () => {
    const tree = showRawAsSource({ type: "html", value: "<div>hi</div>" });

    expect(tree.children).toEqual([{ type: "code", value: "<div>hi</div>" }]);
  });

  it("in a phrase becomes inline code with the same text", () => {
    const tree = showRawAsSource({ type: "paragraph", children: [{ type: "text", value: "a " }, { type: "html", value: "<b>" }] });

    expect(tree.children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "a " }, { type: "inlineCode", value: "<b>" }] },
    ]);
  });

  it("is found inside nested blocks, in flow and in a phrase", () => {
    const tree = showRawAsSource({
      type: "blockquote",
      children: [
        { type: "html", value: "<img src=x onerror=alert(1)>" },
        { type: "paragraph", children: [{ type: "emphasis", children: [{ type: "html", value: "<i>" }] }] },
      ],
    });

    expect(tree.children).toEqual([
      {
        type: "blockquote",
        children: [
          { type: "code", value: "<img src=x onerror=alert(1)>" },
          { type: "paragraph", children: [{ type: "emphasis", children: [{ type: "inlineCode", value: "<i>" }] }] },
        ],
      },
    ]);
  });

  it("keeps the source position of the node it replaces", () => {
    const position = { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } };
    const tree = showRawAsSource({ type: "html", value: "<hr/>", position });

    expect(tree.children[0]?.position).toEqual(position);
  });
});

describe("an image", () => {
  function replaceImages(...children: PhrasingContent[]): Root {
    const tree = root({ type: "paragraph", children });
    remarkImagesAsLinks()(tree);
    return tree;
  }

  function paragraphChildren(tree: Root): unknown {
    return tree.children[0]?.type === "paragraph" ? tree.children[0].children : undefined;
  }

  it("with an http or https source becomes a link named by its alt text", () => {
    const tree = replaceImages(
      { type: "image", url: "https://example.com/a.png", alt: "a chart" },
      { type: "image", url: "http://example.com/b.png", alt: "" },
      { type: "image", url: "http://example.com/c.png" },
    );

    expect(paragraphChildren(tree)).toEqual([
      { type: "link", url: "https://example.com/a.png", children: [{ type: "text", value: "a chart" }] },
      { type: "link", url: "http://example.com/b.png", children: [{ type: "text", value: "http://example.com/b.png" }] },
      { type: "link", url: "http://example.com/c.png", children: [{ type: "text", value: "http://example.com/c.png" }] },
    ]);
  });

  it.each(["chart.png", "http:/chart.png", "data:image/png;base64,AAAA", "mailto:someone@example.com"])(
    "from %s becomes its alt text",
    (url) => {
      const tree = replaceImages({ type: "image", url, alt: "a chart" }, { type: "image", url });

      expect(paragraphChildren(tree)).toEqual([
        { type: "text", value: "a chart" },
        { type: "text", value: "" },
      ]);
    },
  );

  it("inside a link or a link reference becomes its alt text, at any depth", () => {
    const tree = replaceImages(
      {
        type: "link",
        url: "https://example.com/report",
        children: [
          { type: "strong", children: [{ type: "image", url: "https://example.com/a.png", alt: "a chart" }] },
          { type: "image", url: "https://example.com/b.png", alt: "" },
          { type: "image", url: "chart.png", alt: "local" },
          { type: "image", url: "chart.png" },
        ],
      },
      {
        type: "linkReference",
        identifier: "report",
        referenceType: "full",
        children: [{ type: "image", url: "https://example.com/c.png", alt: "another" }],
      },
    );

    expect(paragraphChildren(tree)).toEqual([
      {
        type: "link",
        url: "https://example.com/report",
        children: [
          { type: "strong", children: [{ type: "text", value: "a chart" }] },
          { type: "text", value: "" },
          { type: "text", value: "local" },
          { type: "text", value: "" },
        ],
      },
      { type: "linkReference", identifier: "report", referenceType: "full", children: [{ type: "text", value: "another" }] },
    ]);
  });

  it("reference takes the source of its first definition, found anywhere in the text", () => {
    const tree = root(
      {
        type: "paragraph",
        children: [
          { type: "imageReference", identifier: "chart", referenceType: "full", alt: "a chart" },
          { type: "imageReference", identifier: "missing", referenceType: "full", alt: "lost" },
        ],
      },
      { type: "blockquote", children: [{ type: "definition", identifier: "chart", url: "https://example.com/a.png" }] },
      { type: "definition", identifier: "chart", url: "https://example.com/b.png" },
    );
    remarkImagesAsLinks()(tree);

    expect(paragraphChildren(tree)).toEqual([
      { type: "link", url: "https://example.com/a.png", children: [{ type: "text", value: "a chart" }] },
      { type: "imageReference", identifier: "missing", referenceType: "full", alt: "lost" },
    ]);
  });
});

describe("a URL", () => {
  it.each([
    { url: "https://example.com/a?b#c", href: "https://example.com/a?b#c" },
    { url: "http://%5B::1%5D:8080/a", href: "http://[::1]:8080/a" },
    { url: "https://someone@%5b2001:db8::1%5d/a", href: "https://someone@[2001:db8::1]/a" },
    { url: "https://example.com/%5Bx%5D", href: "https://example.com/%5Bx%5D" },
    { url: "http://example.com", href: "http://example.com/" },
    { url: "HTTPS://EXAMPLE.COM", href: "https://example.com/" },
    { url: "https:\\\\example.com/a", href: "https://example.com/a" },
    { url: "http:\\/example.com/a", href: "http://example.com/a" },
    { url: "mailto:someone@example.com", href: "mailto:someone@example.com" },
  ])("of a link is kept as its absolute form when its scheme is allowed: $url", ({ url, href }) => {
    expect(markdownUrl(url)).toBe(href);
  });

  it.each([
    "javascript:alert(1)",
    " javascript:alert(1)",
    "data:text/html,hi",
    "tracker:ABC-1",
    "relative/path",
    "/absolute/path",
    "#anchor",
    "",
    "http:/api/items",
    "https:path",
    "HTTP:path",
    "http:page.invalid/../daemon/items",
    "http:/page.invalid/../items",
    "http:a.invalid/../items",
    "HTTPS:B.Invalid:443/%2e%2e/items",
    "http:%5B::1%5D/../items",
    "http://%5B::1/items",
  ])("of a link is removed for any other scheme, none, or a path the page resolves: %j", (url) => {
    expect(markdownUrl(url)).toBeUndefined();
  });
});

describe("the source of a Mermaid block", () => {
  it("is the text of a mermaid fence", () => {
    expect(mermaidSource(codeBlock(["language-mermaid"], "flowchart LR\n  a --> b\n"))).toBe("flowchart LR\n  a --> b\n");
  });

  it.each([
    { name: "another language", block: codeBlock(["language-js"], "a()") },
    { name: "no language", block: codeBlock(undefined, "flowchart LR") },
    { name: "a language in another case", block: codeBlock(["language-Mermaid"], "flowchart LR") },
    { name: "only whitespace", block: codeBlock(["language-mermaid"], " \n\t\n") },
    { name: "a child that is not code", block: element("pre", undefined, { type: "text", value: "flowchart LR" }) },
    {
      name: "a second child",
      block: element("pre", undefined, element("code", ["language-mermaid"], { type: "text", value: "flowchart LR" }), {
        type: "text",
        value: "\n",
      }),
    },
    {
      name: "a code element that holds more than its text",
      block: element(
        "pre",
        undefined,
        element("code", ["language-mermaid"], { type: "text", value: "flowchart LR" }, element("span", undefined)),
      ),
    },
    { name: "a code element with no text", block: element("pre", undefined, element("code", ["language-mermaid"])) },
    { name: "no node", block: undefined },
  ])("is null for $name", ({ block }) => {
    expect(mermaidSource(block)).toBeNull();
  });
});

describe("the hidden host of a link", () => {
  it.each([
    { text: "https://github.com/acme/repo", href: "https://evil.example/login", host: "evil.example" },
    { text: "github.com/acme/repo", href: "https://evil.example/", host: "evil.example" },
    { text: "www.github.com", href: "https://evil.example/", host: "evil.example" },
    { text: "https://github.com", href: "https://github.com@evil.example/", host: "evil.example" },
    { text: "github.com/acme", href: "https://gist.github.com/x", host: "gist.github.com" },
    { text: " github.com/acme ", href: "https://evil.example/", host: "evil.example" },
    { text: "https://github.com", href: "https://g\u0456thub.com/", host: "xn--gthub-n2e.com" },
    { text: "https://github.com", href: "https://www.github.com:8443/", host: undefined },
    { text: "www.github.com", href: "https://github.com/", host: undefined },
    { text: "https://github.com", href: "mailto:a@evil.example", host: undefined },
    { text: "see github.com/acme", href: "https://evil.example/", host: undefined },
    { text: "see\u200F github.com/acme", href: "https://evil.example/", host: undefined },
    { text: "Shortcut story", href: "https://app.shortcut.com/x", host: undefined },
    { text: "github.com", href: "https://evil.example/", host: undefined },
    { text: "markdown.ts", href: "https://github.com/acme/repo", host: undefined },
    { text: "v1.2/notes", href: "https://evil.example/", host: undefined },
    { text: "WWW.GitHub.com", href: "https://github.com/", host: undefined },
    { text: "github.com:8080/acme", href: "https://evil.example/", host: "evil.example" },
    { text: "www.github.com:8080", href: "https://evil.example/", host: "evil.example" },
    { text: "github.com:443/acme", href: "https://github.com/", host: undefined },
    { text: "markdown.ts:42", href: "https://evil.example/", host: undefined },
    { text: "github.com:x/acme", href: "https://evil.example/", host: undefined },
    { text: "//github.com/acme/repo", href: "https://evil.example/", host: "evil.example" },
    { text: "//github.com", href: "https://evil.example/", host: "evil.example" },
    { text: "//notes", href: "https://evil.example/", host: undefined },
    { text: "/github.com/acme", href: "https://evil.example/", host: undefined },
    { text: "someone@github.com/acme", href: "https://evil.example/", host: undefined },
    { text: "ftp://github.com/acme", href: "https://evil.example/", host: undefined },
    { text: "https://github.com", href: "not a URL", host: undefined },
    { text: "https:/github.com/acme", href: "https://evil.example/", host: "evil.example" },
    { text: "https:github.com/acme", href: "https://evil.example/", host: "evil.example" },
    { text: "https:\\\\github.com/acme", href: "https://evil.example/", host: "evil.example" },
    { text: "github\uFF0Ecom/acme", href: "https://evil.example/", host: "evil.example" },
    { text: "github\u3002com/acme", href: "https://evil.example/", host: "evil.example" },
    { text: "\uFF48\uFF54\uFF54\uFF50\uFF53\uFF1A\uFF0F\uFF0Fgithub.com", href: "https://evil.example/", host: "evil.example" },
    { text: "123/456", href: "https://evil.example/", host: undefined },
    { text: "github.com?tab=1", href: "https://evil.example/", host: undefined },
    { text: "https:", href: "https://evil.example/", host: undefined },
  ])("of $text to $href is $host", ({ text, href, host }) => {
    expect(hiddenHost(text, href)).toBe(host);
  });

  it.each([
    { text: "(https://github.com/acme/repo)", href: "https://evil.example/", host: "evil.example" },
    { text: "\"https://github.com/acme/repo\"", href: "https://evil.example/", host: "evil.example" },
    { text: "\u2192https://github.com/acme/repo", href: "https://evil.example/", host: "evil.example" },
    { text: "\u2800https://github.com/acme/repo", href: "https://evil.example/", host: "evil.example" },
    { text: "\u201Cgithub.com/acme\u201D", href: "https://evil.example/", host: "evil.example" },
    { text: "(//github.com/acme)", href: "https://evil.example/", host: "evil.example" },
    { text: "(github.com/)", href: "https://evil.example/", host: "evil.example" },
    { text: "(https://github.com)", href: "https://github.com/", host: undefined },
    { text: "(www.github.com).", href: "https://github.com/", host: undefined },
    { text: "(markdown.ts)", href: "https://evil.example/", host: undefined },
  ])("of $text to $href, with punctuation or a symbol around it, is $host", ({ text, href, host }) => {
    expect(hiddenHost(text, href)).toBe(host);
  });

  it.each([
    "ht\u200Btps://github.com/acme/repo",
    "ht\u00ADtps://github.com/acme/repo",
    "ht\u2060tps://github.com/acme/repo",
    "https://github.com/acme/\uFEFFrepo",
    "https://git\u200Chub.com/acme/repo",
    "git\u200Bhub.com/acme",
    "\u202Eoper/emca/moc.buhtig//:sptth",
    "\u202Eoper/emca/moc.buhtig//:sp\u200Atth",
    "\u2067oper/emca/moc.buhtig//:sptth\u2069 see",
    "https://github.com\u200E/acme/repo",
    "github.com\u200F",
    "https://github.com:99999/acme",
    "github.com:99999/acme",
    "//github.com:99999/acme",
    "https://[github.com",
    "https://",
  ])("of %j, which hides or garbles its host, is the destination host", (text) => {
    expect(hiddenHost(text, "https://evil.example/login")).toBe("evil.example");
  });

  it.each(["\u05D3\u05D5\u05D7\u200F", "\u062A\u0642\u0631\u064A\u0631\u061C", "report\u200E", "\u202Ereport"])(
    "of %j, with a bidi control and no dot or colon, is undefined",
    (text) => {
      expect(hiddenHost(text, "https://evil.example/login")).toBeUndefined();
    },
  );

  it.each([
    { text: "https://github.com/acme\u200B", href: "https://github.com/acme" },
    { text: "\u200Bgithub.com/acme", href: "https://github.com/x" },
  ])("of $text to $href, with an invisible character and the same host, is undefined", ({ text, href }) => {
    expect(hiddenHost(text, href)).toBeUndefined();
  });
});

describe("the text of a link", () => {
  function text(value: string): HastElement["children"][number] {
    return { type: "text", value };
  }

  function linkIn(...children: HastElement["children"]): { tree: { children: HastElement[] }; link: HastElement } {
    const link = element("a", undefined, ...children);
    const tree = { children: [element("p", undefined, text("‮See "), element("em", undefined, link))] };
    rehypeLinkText()(tree);
    return { tree, link };
  }

  it("has no embedding, override or isolate control, also in its inner elements", () => {
    const { link } = linkIn(
      text("⁩⁩‪a‫b‬c‭d‮e"),
      element("strong", undefined, text("⁦f⁧g⁨h⁩")),
    );

    expect(link.children).toEqual([text("abcde"), element("strong", undefined, text("fgh"))]);
  });

  it("keeps its text with the controls in `dataText`", () => {
    const { link } = linkIn(text("⁩a"), element("code", undefined, text("‮b")), { type: "comment", value: "c" });

    expect(link.properties.dataText).toBe("⁩a‮b");
  });

  it("keeps the bidi marks, which reorder no text outside an isolate", () => {
    const { link } = linkIn(text("a‎b‏c؜d"));

    expect(link.children).toEqual([text("a‎b‏c؜d")]);
  });

  it("is the only text that loses its controls", () => {
    const { tree } = linkIn(text("a"));

    expect(tree.children[0]?.children[0]).toEqual(text("‮See "));
  });
});
