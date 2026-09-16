import type { Heading, PhrasingContent, Root, RootContent } from "mdast";
import { describe, expect, it } from "vitest";
import {
  markdownUrl,
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
