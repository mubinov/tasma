import type { Heading, Nodes, Parents, PhrasingContent, Root, RootContent } from "mdast";
import type { ExtraProps } from "react-markdown";

const FLOW_PARENTS = new Set<Parents["type"]>(["root", "blockquote", "listItem", "footnoteDefinition"]);

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

const IMAGE_SCHEMES = new Set(["http:", "https:"]);

const WEB_SCHEMES = new Set(["http:", "https:"]);

// The bidi embeddings, overrides and isolates: every bidi control except the LRM, RLM and ALM marks.
const BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/;

// Leading and trailing punctuation and symbols, except a slash, which can start a protocol-relative URL or end a path.
const EDGE_MARKS = /^(?:(?!\/)[\p{P}\p{S}])+|(?:(?!\/)[\p{P}\p{S}])+$/gu;

type HastContent = NonNullable<ExtraProps["node"]>["children"][number];

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
 * The source of a ```` ```mermaid ```` block, from its `pre` element, or `null`
 * for any other `pre`. The language is case-sensitive, and a block that holds
 * only whitespace is not a diagram.
 */
export function mermaidSource(node: ExtraProps["node"]): string | null {
  const [code, ...others] = node?.children ?? [];
  if (code?.type !== "element" || code.tagName !== "code" || others.length > 0) {
    return null;
  }
  const classes = code.properties.className;
  const [text, ...rest] = code.children;
  if (!Array.isArray(classes) || !classes.includes("language-mermaid") || text?.type !== "text" || rest.length > 0) {
    return null;
  }
  return text.value.trim() === "" ? null : text.value;
}

/**
 * Removes the bidi embeddings, overrides and isolates from the text of each
 * link, and keeps the text as it was in `dataText`. A PDI in the text of a link
 * closes the nearest open isolate, also one that the link renders around it.
 */
export function rehypeLinkText(): (tree: { children: HastContent[] }) => void {
  return (tree) => {
    withLinkTexts(tree.children);
  };
}

function withLinkTexts(nodes: HastContent[]): void {
  for (const node of nodes) {
    if (node.type !== "element") {
      continue;
    }
    if (node.tagName === "a") {
      node.properties.dataText = hastText(node);
      removeBidiOverrides(node);
    } else {
      withLinkTexts(node.children);
    }
  }
}

function hastText(node: HastContent): string {
  if (node.type === "text") {
    return node.value;
  }
  return node.type === "element" ? node.children.map(hastText).join("") : "";
}

function removeBidiOverrides(node: HastContent): void {
  if (node.type === "text") {
    node.value = node.value.replaceAll(new RegExp(BIDI_OVERRIDES, "g"), "");
  } else if (node.type === "element") {
    node.children.forEach(removeBidiOverrides);
  }
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

/**
 * The host a link goes to, when its text shows a URL or a domain with another
 * host, or `undefined`. A bare host with no path and no `www.` is not taken as
 * a domain, so a file name such as `notes.md` is not one.
 */
export function hiddenHost(text: string, href: string): string | undefined {
  const destination = URL.parse(href);
  if (destination === null || !WEB_SCHEMES.has(destination.protocol)) {
    return undefined;
  }
  const shown = shownHost(text);
  if (shown === undefined || (shown !== null && withoutWww(shown) === withoutWww(destination.hostname))) {
    return undefined;
  }
  return destination.hostname;
}

/**
 * The host that the text of a link shows, `null` when the text can show a URL
 * whose host cannot be read, or `undefined` when the text shows no URL and no
 * domain.
 */
function shownHost(text: string): string | null | undefined {
  const visible = text.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "").trim();
  // A bidi control can show the characters in an order other than the order the parser reads. Every bidi control is
  // default-ignorable, so the checks read `text`, not `visible`. Reordering adds no character, so a text with no dot
  // and no colon cannot show a URL or a domain.
  const reorderable = /[.。:]/.test(visible);
  if (reorderable && BIDI_OVERRIDES.test(text)) {
    return null;
  }
  if (/\s/.test(visible)) {
    return undefined;
  }
  if (reorderable && /\p{Bidi_Control}/u.test(text)) {
    return null;
  }
  const token = visible.replace(EDGE_MARKS, "");
  // The parser takes any number of slashes and backslashes after a web scheme.
  if (/^https?:/i.test(token)) {
    return URL.parse(token)?.hostname ?? null;
  }
  const relative = token.startsWith("//");
  const domain = relative ? token.slice(2) : token;
  const slash = domain.indexOf("/");
  const hostPart = slash === -1 ? domain : domain.slice(0, slash);
  const host = hostPart.replace(/:\d+$/, "");
  // The parser takes U+3002 as a dot. A number with no dot is an IPv4 address to it.
  if (!/[.。]/.test(host) || /[:@]/.test(host)) {
    return undefined;
  }
  const hasPath = slash !== -1;
  if (!relative && !hasPath && !/^www\./i.test(host)) {
    return undefined;
  }
  const hasPort = host !== hostPart;
  return URL.parse(`https://${domain}`)?.hostname ?? (relative || hasPort ? null : undefined);
}

function withoutWww(host: string): string {
  return host.replace(/^www\./, "");
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
