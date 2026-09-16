import type { Heading, Nodes, Parents, PhrasingContent, Root, RootContent } from "mdast";

const FLOW_PARENTS = new Set<Parents["type"]>(["root", "blockquote", "listItem", "footnoteDefinition"]);

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

const IMAGE_SCHEMES = new Set(["http:", "https:"]);

const TITLE_NODES = new Set<Nodes["type"]>(["heading", "text", "inlineCode", "emphasis", "strong", "delete", "break"]);

/**
 * Turns raw HTML into code with the same text, so the reader sees the source
 * and no HTML element reaches the DOM.
 */
export function remarkRawAsSource(): (tree: Root) => void {
  return (tree) => {
    showHtmlAsSource(tree);
  };
}

function showHtmlAsSource(parent: Parents): void {
  const children = parent.children as RootContent[];
  children.forEach((node, index) => {
    if (node.type === "html") {
      children[index] = FLOW_PARENTS.has(parent.type)
        ? { type: "code", value: node.value, position: node.position }
        : { type: "inlineCode", value: node.value, position: node.position };
    } else if ("children" in node) {
      showHtmlAsSource(node);
    }
  });
}

/** The tag level of the top heading rank: 2 for a task body, 4 for a comment body. */
export type HeadingBase = 2 | 3 | 4 | 5 | 6;

export type TaskHeadingsOptions = {
  base: HeadingBase;
  /** A leading H1 equal to it is dropped. */
  title?: string | undefined;
};

/**
 * Gives each heading the tag one level under the nearest heading before it with
 * a smaller source depth, or `h{base}` when there is none, down to `h6`, and
 * keeps its source depth as `data-level`. Each footnote starts again at
 * `h{base}`, because the footnotes render after the text.
 */
export function remarkTaskHeadings({ base, title }: TaskHeadingsOptions): (tree: Root) => void {
  return (tree) => {
    const first = tree.children[0];
    if (title !== undefined && first?.type === "heading" && first.depth === 1 && sameText(textOf(first), title)) {
      tree.children.shift();
    }

    const textOutline: Heading[] = [];
    const outlines = [textOutline];
    collectHeadings(tree, textOutline, outlines);
    for (const outline of outlines) {
      const parents: { depth: number; level: number }[] = [];
      for (const heading of outline) {
        while ((parents.at(-1)?.depth ?? 0) >= heading.depth) {
          parents.pop();
        }
        const level = Math.min((parents.at(-1)?.level ?? base - 1) + 1, 6);
        heading.data = { hName: `h${String(level)}`, hProperties: { dataLevel: heading.depth } };
        parents.push({ depth: heading.depth, level });
      }
    }
  };
}

function collectHeadings(parent: Parents, outline: Heading[], outlines: Heading[][]): void {
  for (const node of parent.children) {
    if (node.type === "heading") {
      outline.push(node);
    } else if (node.type === "footnoteDefinition") {
      const footnote: Heading[] = [];
      outlines.push(footnote);
      collectHeadings(node, footnote, outlines);
    } else if ("children" in node) {
      collectHeadings(node, outline, outlines);
    }
  }
}

/**
 * The text of a node, or `undefined` when it holds anything but text and its
 * formatting, such as a link, an image or a footnote reference, whose content
 * the title does not hold.
 */
function textOf(node: Nodes): string | undefined {
  if (!TITLE_NODES.has(node.type)) {
    return undefined;
  }
  if ("children" in node) {
    const parts = node.children.map(textOf);
    return parts.includes(undefined) ? undefined : parts.join("");
  }
  return "value" in node ? node.value : "";
}

function sameText(a: string | undefined, b: string): boolean {
  return a?.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Turns each image into a link to its source, named by its alt text or else
 * its source, so no image loads. An image with a source other than `http:` or
 * `https:` becomes its alt text, and so does an image inside a link.
 */
export function remarkImagesAsLinks(): (tree: Root) => void {
  return (tree) => {
    const definitions = new Map<string, string>();
    collectDefinitions(tree, definitions);
    replaceImages(tree, false, definitions);
  };
}

function collectDefinitions(parent: Parents, definitions: Map<string, string>): void {
  for (const node of parent.children) {
    if (node.type === "definition") {
      // The first definition of an identifier wins, as it does for a link reference.
      const id = node.identifier.toUpperCase();
      if (!definitions.has(id)) {
        definitions.set(id, node.url);
      }
    } else if ("children" in node) {
      collectDefinitions(node, definitions);
    }
  }
}

function replaceImages(parent: Parents, inLink: boolean, definitions: Map<string, string>): void {
  const children = parent.children as RootContent[];
  children.forEach((node, index) => {
    if (node.type === "image" || node.type === "imageReference") {
      const url = node.type === "image" ? node.url : definitions.get(node.identifier.toUpperCase());
      // An image reference with no definition renders as its source text.
      if (url !== undefined) {
        children[index] = imageAsPhrase(node.alt ?? "", inLink ? undefined : allowedUrl(url, IMAGE_SCHEMES));
      }
    } else if ("children" in node) {
      replaceImages(node, inLink || node.type === "link" || node.type === "linkReference", definitions);
    }
  });
}

function imageAsPhrase(alt: string, source: string | undefined): PhrasingContent {
  if (source === undefined) {
    return { type: "text", value: alt };
  }
  return { type: "link", url: source, children: [{ type: "text", value: alt === "" ? source : alt }] };
}

/**
 * The absolute URL a link keeps, or `undefined` to drop it: only `http:`,
 * `https:` and `mailto:` are kept. A relative or `#…` URL is dropped too,
 * because the URL hash holds the route.
 */
export function markdownUrl(url: string): string | undefined {
  // The markdown parser percent-encodes the brackets of an IPv6 host.
  return allowedUrl(url.replace(/^([a-z][\d+.a-z-]*:\/\/(?:[^/?#@]*@)?)%5B([^/?#]*?)%5D/i, "$1[$2]"), LINK_SCHEMES);
}

function allowedUrl(url: string, schemes: ReadonlySet<string>): string | undefined {
  const parsed = URL.parse(url);
  if (parsed === null || !schemes.has(parsed.protocol)) {
    return undefined;
  }
  // A page with the same scheme resolves `http:/path` or `https:path` against its
  // own host, so such a URL resolves differently against two bases.
  const absolute = ["a.invalid", "b.invalid"].every(
    (host) => URL.parse(url, `${parsed.protocol}//${host}/`)?.href === parsed.href,
  );
  return absolute ? parsed.href : undefined;
}
