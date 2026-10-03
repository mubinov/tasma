import type { Mermaid, MermaidConfig } from "mermaid";
import type { Theme } from "./theme";

export type MermaidMarkup = {
  /** HTML-serialized, with no style element, no link, no control, no motion and no `title` attribute. */
  svg: string;
  /** Every rule is scoped by the diagram's `#<id>`. */
  css: string;
  /** The author's `accTitle`. */
  title: string | undefined;
  /** Whether the author wrote an `accDescr`. */
  hasDescription: boolean;
};

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** The HTML that shows text only: Mermaid's labels, its Markdown and KaTeX. Any other element becomes a `span`. */
const STATIC_HTML = new Set([
  "div", "span", "p", "br", "hr", "b", "strong", "i", "em", "u", "s", "del", "ins", "mark", "small", "sub", "sup",
  "code", "kbd", "samp", "var", "abbr", "cite", "q", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd", "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td",
  "img",
]);

const HTML_ATTRIBUTES = new Set(["class", "style", "aria-hidden", "dir", "lang"]);

const ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
  img: new Set(["src", "alt", "width", "height"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  th: new Set(["colspan", "rowspan"]),
  td: new Set(["colspan", "rowspan"]),
  ol: new Set(["start"]),
};

/** SMIL animation, which `animation: none` does not stop. */
const SVG_ANIMATION = new Set(["animate", "animateMotion", "animateTransform", "animateColor", "set"]);

/**
 * Removed from an SVG or MathML element. A MathML `href` is a link in WebKit,
 * so it goes too; an SVG `href` other than a link's is a reference.
 */
const FOREIGN_ATTRIBUTES = new Set(["title", "tabindex", "autofocus"]);

const MOTION_PROPERTY = /^(?:-webkit-)?(?:animation|transition)(?:-|$)|^cursor$/;

/** The grouping rules that only choose when their rules apply; `@page` and other kinds style the document itself. */
const GROUPING_RULES = [CSSMediaRule, CSSSupportsRule, CSSContainerRule, CSSLayerBlockRule];

/** The token each Mermaid theme variable takes; the `base` theme derives every other variable from these. */
const THEME_TOKENS = {
  background: "--color-surface-2",
  edgeLabelBackground: "--color-surface-2",
  altSectionBkgColor: "--color-surface-2",
  pieStrokeColor: "--color-surface-2",
  primaryColor: "--color-surface",
  noteBkgColor: "--color-surface",
  sequenceNumberColor: "--color-surface",
  activationBkgColor: "--color-surface",
  emUiFill: "--color-surface",
  tertiaryColor: "--color-bg",
  excludeBkgColor: "--color-bg",
  emSwimlaneBackgroundOdd: "--color-bg",
  primaryTextColor: "--color-text",
  textColor: "--color-text",
  noteTextColor: "--color-text",
  branchLabelColor: "--color-text",
  todayLineColor: "--color-text",
  primaryBorderColor: "--color-graphic",
  secondaryBorderColor: "--color-graphic",
  tertiaryBorderColor: "--color-graphic",
  noteBorderColor: "--color-graphic",
  lineColor: "--color-graphic",
  activationBorderColor: "--color-graphic",
  doneTaskBorderColor: "--color-graphic",
  critBorderColor: "--color-graphic",
  vertLineColor: "--color-graphic",
  pieOuterStrokeColor: "--color-graphic",
  archEdgeColor: "--color-graphic",
  archEdgeArrowColor: "--color-graphic",
  archGroupBorderColor: "--color-graphic",
  emUiStroke: "--color-graphic",
  emProcessorStroke: "--color-graphic",
  emReadModelStroke: "--color-graphic",
  emCommandStroke: "--color-graphic",
  emEventStroke: "--color-graphic",
  doneTaskBkgColor: "--color-line",
  gridColor: "--color-line",
  emSwimlaneBackgroundStroke: "--color-line",
  emCommandFill: "--color-chart-1",
  emEventFill: "--color-chart-2",
  emReadModelFill: "--color-chart-3",
  critBkgColor: "--color-chart-4",
  wardleyEvolutionColor: "--color-chart-4",
  emProcessorFill: "--color-chart-8",
};

/**
 * A nested variable replaces Mermaid's whole object, so these are merged into
 * the object that Mermaid derives.
 */
const NESTED_THEME_TOKENS = {
  cynefin: {
    complicatedBg: "--color-chart-1",
    complexBg: "--color-chart-3",
    chaoticBg: "--color-chart-4",
    confusionBg: "--color-chart-5",
    clearBg: "--color-chart-6",
    cliffColor: "--color-text",
  },
};

const CHART_TOKENS = Array.from({ length: 8 }, (_, index) => `--color-chart-${String(index + 1)}`);

/** The `base` theme makes these palettes by turning the hue of `primaryColor`, which is a grey here. */
const PALETTES = [
  series("pie", 1, 12),
  series("cScale", 0, 12),
  series("git", 0, 8),
  series("fillType", 0, 8),
  series("venn", 1, 8),
];

const TOKENS = new Set([
  ...Object.values(THEME_TOKENS),
  ...Object.values(NESTED_THEME_TOKENS).flatMap((tokens) => Object.values(tokens)),
  ...CHART_TOKENS,
]);

function series(prefix: string, first: number, length: number): string[] {
  return Array.from({ length }, (_, index) => `${prefix}${String(first + index)}`);
}

let loaded: Promise<Mermaid> | undefined;

// `initialize` sets global state, so a render runs only after the one before it.
let queue: Promise<unknown> = Promise.resolve();

let renders = 0;

/**
 * Renders a diagram into `container`, which Mermaid empties and uses to measure
 * the labels, so it must be laid out and must hold nothing else. It throws the
 * Mermaid error for a source it rejects, and the reason of `signal` for a
 * render aborted before it draws.
 */
export function renderMermaid(
  source: string,
  theme: Theme,
  container: HTMLElement,
  signal: AbortSignal,
): Promise<MermaidMarkup> {
  const job = queue.then(() => render(source, theme, container, signal));
  queue = job.catch(() => undefined);
  return job;
}

async function render(
  source: string,
  theme: Theme,
  container: HTMLElement,
  signal: AbortSignal,
): Promise<MermaidMarkup> {
  loaded ??= import("mermaid").then((module) => module.default);
  const mermaid = await loaded;
  await document.fonts.ready;
  signal.throwIfAborted();
  initialize(mermaid, theme, container);
  renders += 1;
  const id = `mermaid-${String(renders)}`;
  const { svg } = await mermaid.render(id, source, container);
  return toMarkup(svg, id);
}

function initialize(mermaid: Mermaid, theme: Theme, container: HTMLElement): void {
  const { fontFamily, fontSize } = getComputedStyle(container);
  const fonts = { fontFamily, fontSize };
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Mermaid exports these configurations nowhere else
  const api = mermaid.mermaidAPI;
  const diagrams = Object.entries(api.defaultConfig)
    .filter(([, value]) => typeof value === "object" && value !== null && "useMaxWidth" in value)
    .map(([key]) => [key, { useMaxWidth: false }]);
  const config: MermaidConfig = {
    ...(Object.fromEntries(diagrams) as MermaidConfig),
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    htmlLabels: true,
    fontFamily,
    themeVariables: fonts,
  };
  const color = tokenColors();
  const chart = CHART_TOKENS.map(color);
  const themeVariables = {
    ...colorsOf(THEME_TOKENS, color),
    ...Object.fromEntries(PALETTES.flatMap((names) => names.map((name, index) => [name, chart[index % chart.length]]))),
    pieOpacity: "1",
    darkMode: theme === "dark",
    ...fonts,
  };
  mermaid.initialize({ ...config, themeVariables });
  const derived = api.getSiteConfig().themeVariables as Record<string, object>;
  const nested = {
    ...Object.fromEntries(Object.entries(NESTED_THEME_TOKENS).map(([key, tokens]) => [
      key,
      { ...derived[key], ...colorsOf(tokens, color) },
    ])),
    // Mermaid splits the palette at each comma, so the colours are hex.
    xyChart: { ...derived.xyChart, plotColorPalette: chart.map(hex).join(",") },
  };
  // A theme that a diagram names derives its colours from the theme variables of `initialize`, so they hold
  // the font only. The app colours go into the site configuration, which a diagram with no theme of its own uses.
  mermaid.initialize(config);
  api.updateSiteConfig({ themeVariables: { ...derived, ...nested } });
}

/**
 * A computed custom property keeps its `light-dark()` text, which Mermaid
 * cannot parse; a computed `color` is `rgb(…)`.
 */
function tokenColors(): (token: string) => string {
  const probe = document.createElement("span");
  probe.hidden = true;
  document.documentElement.append(probe);
  const colors = new Map<string, string>();
  try {
    for (const token of TOKENS) {
      probe.style.color = `var(${token})`;
      colors.set(token, getComputedStyle(probe).color);
    }
  } finally {
    probe.remove();
  }
  return (token) => colors.get(token)!;
}

function colorsOf(tokens: Record<string, string>, color: (token: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(tokens).map(([variable, token]) => [variable, color(token)]));
}

function hex(color: string): string {
  const channels = color.match(/\d+/g)!.slice(0, 3);
  return `#${channels.map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** Strict mode returns the SVG through DOMPurify, serialized as HTML, so it is parsed as HTML. */
function toMarkup(markup: string, id: string): MermaidMarkup {
  const template = document.createElement("template");
  template.innerHTML = markup;
  const content = template.content;
  const svg = content.querySelector("svg")!;

  const styleTexts = [...svg.querySelectorAll(":scope > style")].map((style) => style.textContent);
  for (const element of content.querySelectorAll("*")) {
    toStatic(element);
  }
  // The figure around the SVG carries the name.
  svg.removeAttribute("aria-roledescription");
  svg.removeAttribute("aria-labelledby");

  const title = svg.querySelector(":scope > title")?.textContent.trim();
  return {
    svg: template.innerHTML,
    css: [
      scopedCss(styleTexts.join("\n"), id),
      `#${id}, #${id} * { animation: none !important; transition: none !important; cursor: default !important; }`,
    ].join("\n"),
    title: title === "" ? undefined : title,
    hasDescription: (svg.querySelector(":scope > desc")?.textContent.trim() ?? "") !== "",
  };
}

/** Leaves only what shows: no style element, no link, no control, no top-layer element, no motion. */
function toStatic(element: Element): void {
  const name = element.localName;
  if (name === "style" || (element.namespaceURI === SVG_NAMESPACE && SVG_ANIMATION.has(name))) {
    element.remove();
    return;
  }
  withoutMotion(element);
  if (element.namespaceURI === HTML_NAMESPACE) {
    const keeps = (attribute: Attr): boolean =>
      HTML_ATTRIBUTES.has(attribute.name)
      || attribute.name.startsWith("data-")
      || (ELEMENT_ATTRIBUTES[name]?.has(attribute.name) ?? false);
    if (STATIC_HTML.has(name)) {
      removeAttributes(element, (attribute) => !keeps(attribute));
    } else {
      element.replaceWith(copyOf(element, "span", keeps));
    }
  } else if (element.namespaceURI === SVG_NAMESPACE && name === "a") {
    // Mermaid places a linked node through the `transform` on its link, so every other attribute stays.
    element.replaceWith(copyOf(element, "g", (attribute) =>
      attribute.localName !== "href" && attribute.name !== "target" && !FOREIGN_ATTRIBUTES.has(attribute.name)));
  } else {
    const svg = element.namespaceURI === SVG_NAMESPACE;
    removeAttributes(element, (attribute) => FOREIGN_ATTRIBUTES.has(attribute.name) || (!svg && attribute.localName === "href"));
  }
}

/**
 * The style is written back as parsed, so it holds only declarations the
 * browser applies. The scratch element is of the same kind, because an SVG or
 * MathML style accepts a unitless length that an HTML style drops.
 */
function withoutMotion(element: Element): void {
  const text = element.getAttribute("style");
  if (text === null) {
    return;
  }
  const scratch = document.createElementNS(element.namespaceURI, element.localName) as Element & ElementCSSInlineStyle;
  scratch.setAttribute("style", text);
  removeMotion(scratch.style);
  element.setAttribute("style", scratch.style.cssText);
}

function removeMotion(style: CSSStyleDeclaration): void {
  for (const property of [...style].filter((name) => MOTION_PROPERTY.test(name))) {
    style.removeProperty(property);
  }
}

function removeAttributes(element: Element, removes: (attribute: Attr) => boolean): void {
  for (const attribute of [...element.attributes].filter(removes)) {
    element.removeAttributeNode(attribute);
  }
}

function copyOf(element: Element, localName: string, keeps: (attribute: Attr) => boolean): Element {
  const copy = document.createElementNS(element.namespaceURI, localName);
  for (const attribute of element.attributes) {
    if (keeps(attribute)) {
      copy.setAttributeNode(attribute.cloneNode() as Attr);
    }
  }
  copy.append(...element.childNodes);
  return copy;
}

/**
 * Mermaid's CSS holds author text that can close the `#<id>` block, so only
 * the rules whose every selector targets the diagram or its content stay, and
 * they lose their motion. Keyframes go too: their names are global, and the
 * diagram does not animate.
 */
function scopedCss(text: string, id: string): string {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(text);
  const inDiagram = new RegExp(String.raw`^#${id}(?:$|\s*>|\s+[^\s+~>|])`);
  const inScope = (rule: CSSRule): boolean => {
    if (rule instanceof CSSStyleRule) {
      // A comma inside `:is()` or a string splits too early, which only drops a rule.
      return rule.cssRules.length === 0 && rule.selectorText.split(",").every((selector) => inDiagram.test(selector.trim()));
    }
    return GROUPING_RULES.some((kind) => rule instanceof kind)
      && (rule as CSSGroupingRule).cssRules.length > 0
      && [...(rule as CSSGroupingRule).cssRules].every(inScope);
  };
  const kept = [...sheet.cssRules].filter(inScope);
  kept.forEach(withoutRuleMotion);
  return kept.map((rule) => rule.cssText).join("\n");
}

function withoutRuleMotion(rule: CSSRule): void {
  if (rule instanceof CSSStyleRule) {
    removeMotion(rule.style);
  } else {
    [...(rule as CSSGroupingRule).cssRules].forEach(withoutRuleMotion);
  }
}
