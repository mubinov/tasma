import type { MermaidConfig, RenderResult } from "mermaid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMermaid, type MermaidMarkup } from "../../src/lib/mermaid";
import type { Theme } from "../../src/lib/theme";

const mermaid = vi.hoisted(() => {
  const initialize = vi.fn<(config: MermaidConfig) => void>();
  return {
    initialize,
    render: vi.fn<(id: string, text: string, container?: Element) => Promise<RenderResult>>(),
    mermaidAPI: {
      // As the base theme derives them: the given variables, with nested objects of its own.
      getSiteConfig: vi.fn<() => MermaidConfig>(() => ({
        themeVariables: {
          ...(initialize.mock.lastCall?.[0].themeVariables as object),
          cynefin: { domainFontSize: 16, complexBg: "#E8F5E9", boundaryColor: "derived" },
          xyChart: { backgroundColor: "derived", plotColorPalette: "#FFF4DD" },
        },
      })),
      updateSiteConfig: vi.fn<(config: MermaidConfig) => MermaidConfig>(),
      defaultConfig: {
        theme: "default",
        fontFamily: "serif",
        themeVariables: {},
        flowchart: { useMaxWidth: true, curve: "basis" },
        sequence: { useMaxWidth: true },
        elk: { mergeEdges: false },
        gantt: null,
      },
    },
  };
});

vi.mock(import("mermaid"), () => ({ default: mermaid }) as never);

const TOKEN_COLORS: Record<string, string> = {
  "var(--color-surface-2)": "rgb(1, 1, 1)",
  "var(--color-surface)": "rgb(2, 2, 2)",
  "var(--color-bg)": "rgb(3, 3, 3)",
  "var(--color-text)": "rgb(4, 4, 4)",
  "var(--color-graphic)": "rgb(5, 5, 5)",
  "var(--color-line)": "rgb(6, 6, 6)",
  ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`var(--color-chart-${String(index + 1)})`, `rgb(${String(index + 1)}0, 0, 255)`])),
};

function stubSvg(svg: (id: string) => string): void {
  mermaid.render.mockImplementation((id) => Promise.resolve({ svg: svg(id), diagramType: "flowchart-v2" }));
}

function stubDiagram(extra = ""): void {
  stubSvg((id) => diagramSvg(id, extra));
}

function stubLabel(label: string): void {
  stubSvg((id) => `<svg id="${id}"><foreignObject><div>${label}</div></foreignObject></svg>`);
}

function lastConfig(): MermaidConfig {
  return mermaid.initialize.mock.lastCall![0];
}

/** The theme variables of a diagram that names no theme of its own. */
function siteColors(): Record<string, unknown> {
  return mermaid.mermaidAPI.updateSiteConfig.mock.lastCall![0].themeVariables as Record<string, unknown>;
}

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function parse(svg: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = svg;
  return template.content;
}

function run(source: string, theme: Theme, signal = new AbortController().signal): Promise<MermaidMarkup> {
  return renderMermaid(source, theme, container, signal);
}

/** An SVG as Mermaid returns it in strict mode: serialized as HTML, so `<br>` has no slash. */
function diagramSvg(id: string, extra = ""): string {
  return [
    `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" aria-roledescription="flowchart-v2" aria-labelledby="chart-title" aria-describedby="chart-desc">`,
    extra,
    `<style>#${id}{fill:#333;}</style>`,
    "<g>",
    '<a href="https://example.com/a" xlink:href="https://example.com/a" target="_blank" transform="translate(5,6)" class="node-link">',
    '<g class="node" title="Tip"><foreignObject width="40" height="20"><div>One<br>Two</div></foreignObject></g>',
    "</a>",
    "</g>",
    `<style>#${id} .edge{stroke:#999;}</style>`,
    "</svg>",
  ].join("");
}

let container: HTMLDivElement;
let probes: { parent: ParentNode | null; hidden: HTMLElement["hidden"] }[];

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  probes = [];
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    if (element === container) {
      return { fontFamily: '"Inter", sans-serif', fontSize: "14px" } as CSSStyleDeclaration;
    }
    const probe = element as HTMLElement;
    probes.push({ parent: probe.parentNode, hidden: probe.hidden });
    return { color: TOKEN_COLORS[probe.style.color] ?? "unresolved" } as CSSStyleDeclaration;
  });
  Object.defineProperty(document, "fonts", { value: { ready: Promise.resolve() }, configurable: true });
  stubDiagram();
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
  mermaid.mermaidAPI.getSiteConfig.mockClear();
  mermaid.mermaidAPI.updateSiteConfig.mockReset();
});

describe("the SVG", () => {
  it("loses its style elements, which come back as the CSS", async () => {
    const { svg, css } = await run("flowchart LR", "light");
    const id = mermaid.render.mock.calls[0]?.[0] ?? "";

    expect(svg).not.toContain("<style");
    expect(css).toContain(`#${id} { fill: rgb(51, 51, 51); }`);
    expect(css).toContain(`#${id} .edge { stroke: rgb(153, 153, 153); }`);
    expect(css.trimEnd().endsWith(
      `#${id}, #${id} * { animation: none !important; transition: none !important; cursor: default !important; }`,
    )).toBe(true);
  });

  it("keeps HTML serialization, so a label line break stays a <br>", async () => {
    const { svg } = await run("flowchart LR", "light");

    expect(svg).toContain("<div>One<br>Two</div>");
  });

  it("has no links: an SVG link becomes a group that keeps its other attributes", async () => {
    const { svg } = await run("flowchart LR", "light");
    const parsed = parse(svg);

    expect(parsed.querySelector("a")).toBeNull();
    const group = parsed.querySelector("g.node-link");
    expect(group?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(group?.getAttribute("transform")).toBe("translate(5,6)");
    expect(group?.hasAttribute("href")).toBe(false);
    expect(group?.hasAttribute("xlink:href")).toBe(false);
    expect(group?.hasAttribute("target")).toBe(false);
    expect(group?.querySelector("g.node foreignObject div")?.textContent).toBe("OneTwo");
  });

  it("has no links in a label either: an HTML link becomes a span with the static attributes only", async () => {
    stubLabel('<a href="https://example.com/b" xlink:title="Bed" class="label-link" data-bed="1">B</a>');

    const parsed = parse((await run("flowchart LR", "light")).svg);

    expect(parsed.querySelector("a")).toBeNull();
    const span = parsed.querySelector("span.label-link");
    expect(span?.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(span?.textContent).toBe("B");
    expect(span?.getAttributeNames()).toEqual(["class", "data-bed"]);
  });

  it("has no control, no link and no top-layer element in a label, and keeps their text", async () => {
    stubLabel([
      '<map name="beds"><area href="https://example.com/c" shape="rect" coords="0,0,9,9"></map>',
      '<img usemap="#beds" src="data:,">',
      '<form action="https://example.com/d"><button>Water</button></form>',
      '<button commandfor="d" command="show-modal">Show details</button><dialog id="d" open>Details</dialog>',
      '<div popover id="tip">Tip</div><button popovertarget="tip">Open</button>',
      '<input id="seed" type="checkbox"><label for="seed">Seed</label>',
      "<details open><summary>More</summary>Rows</details>",
      "<select><option>Bed</option></select><textarea>Notes</textarea>",
      "<marquee>Moving</marquee><video autoplay src=\"data:,\"></video>",
      '<div contenteditable tabindex="0" accesskey="w" draggable="true" role="alert" aria-live="assertive" id="note">Edit</div>',
    ].join(""));

    const parsed = parse((await run("flowchart LR", "light")).svg);
    const label = parsed.querySelector("foreignObject > div")!;

    const names = [...label.querySelectorAll("*")].map((element) => element.localName);
    expect(new Set(names)).toEqual(new Set(["span", "img", "div"]));
    expect(label.querySelectorAll("[href], [usemap], [popover], [popovertarget], [command], [commandfor], [for], [id], [open]")).toHaveLength(0);
    expect(label.querySelectorAll("[contenteditable], [tabindex], [accesskey], [draggable], [role], [aria-live], [autoplay]")).toHaveLength(0);
    expect(label.querySelector("img")?.getAttributeNames()).toEqual(["src"]);
    expect(label.textContent).toBe("WaterShow detailsDetailsTipOpenSeedMoreRowsBedNotesMovingEdit");
  });

  it("has no MathML link, and keeps the MathML", async () => {
    stubLabel('<math><mi href="#/some/route" mathvariant="normal" tabindex="0">Open</mi></math>');

    const parsed = parse((await run("flowchart LR", "light")).svg);
    const identifier = parsed.querySelector("mi");

    expect(identifier?.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
    expect(identifier?.getAttributeNames()).toEqual(["mathvariant"]);
    expect(identifier?.textContent).toBe("Open");
  });

  it("keeps a reference and drops focus from an SVG element", async () => {
    stubLabel('<svg tabindex="0"><use href="#leaf" title="Leaf"></use></svg>');

    const parsed = parse((await run("flowchart LR", "light")).svg);

    expect(parsed.querySelector("foreignObject svg")?.hasAttribute("tabindex")).toBe(false);
    expect(parsed.querySelector("use")?.getAttributeNames()).toEqual(["href"]);
  });

  it("loses each title attribute and keeps the title element", async () => {
    stubDiagram('<title id="chart-title">Watering plan</title>');

    const parsed = parse((await run("flowchart LR", "light")).svg);

    expect(parsed.querySelector("[title]")).toBeNull();
    expect(parsed.querySelector("svg > title")?.textContent).toBe("Watering plan");
  });

  it("leaves the name to the figure: no role description and no label reference on the SVG", async () => {
    const parsed = parse((await run("flowchart LR", "light")).svg);
    const svg = parsed.querySelector("svg");

    expect(svg?.hasAttribute("aria-roledescription")).toBe(false);
    expect(svg?.hasAttribute("aria-labelledby")).toBe(false);
    expect(svg?.getAttribute("aria-describedby")).toBe("chart-desc");
  });
});

describe("the motion", () => {
  it("is removed from inline styles, which keep their other properties", async () => {
    stubSvg((id) => [
      `<svg id="${id}" style="max-width: 120px;">`,
      '<rect class="moving" style="fill: red; animation: enter 1s infinite !important; transition: fill 1s; cursor: pointer;"></rect>',
      '<foreignObject><div class="label" style="color: red; -webkit-animation: enter 1s;">L</div></foreignObject>',
      '<rect class="invalid" style="fill: red; animation: enter 1s !important !important;"></rect>',
      "</svg>",
    ].join(""));

    const parsed = parse((await run("flowchart LR", "light")).svg);

    expect(parsed.querySelector("svg")?.getAttribute("style")).toBe("max-width: 120px;");
    expect(parsed.querySelector(".moving")?.getAttribute("style")).toBe("fill: red;");
    expect(parsed.querySelector(".label")?.getAttribute("style")).toBe("color: red;");
    expect(parsed.querySelector(".invalid")?.getAttribute("style")).toBe("fill: red;");
  });

  it("is parsed by a scratch element of the same kind, because an SVG or MathML style keeps a unitless length", async () => {
    stubLabel('<svg><text class="big" style="font-size: 30px; animation: enter 1s;">B</text></svg><span style="color: red;">y</span>');
    const created = vi.spyOn(document, "createElementNS");

    const parsed = parse((await run("flowchart LR", "light")).svg);

    expect(created.mock.calls).toEqual(expect.arrayContaining([
      ["http://www.w3.org/2000/svg", "text"],
      ["http://www.w3.org/1999/xhtml", "span"],
    ]));
    expect(parsed.querySelector(".big")?.getAttribute("style")).toBe("font-size: 30px;");
  });

  it("has no SMIL animation", async () => {
    stubLabel([
      "<svg><circle r=\"4\">",
      '<animate attributeName="r" to="8" dur="1s"></animate>',
      '<animateMotion path="M0,0 L9,9" dur="1s"></animateMotion>',
      '<animateTransform attributeName="transform" type="rotate" dur="1s"></animateTransform>',
      '<set attributeName="r" to="9"></set>',
      "</circle></svg>",
    ].join(""));

    const parsed = parse((await run("flowchart LR", "light")).svg);

    expect(parsed.querySelector("circle")?.children).toHaveLength(0);
  });
});

describe("the CSS", () => {
  it("keeps only the rules that target the diagram or its content", async () => {
    stubSvg((id) => [
      `<svg id="${id}"><style>`,
      `#${id}{font-size:14px;}`,
      `#${id} .node{fill:red;}`,
      `#${id}>.edge{stroke:red;}`,
      `@media (min-width: 1px){#${id} .wide{fill:red;}}`,
      // The character references decode while the SVG is parsed and close the block.
      `#${id} .b{--x:&#125 body&#123display:none;}`,
      `#${id} ~ p{color:red;}`,
      `#${id} + p{color:red;}`,
      `#${id}.x ~ p{color:red;}`,
      `#${id}0 .other{color:red;}`,
      `#${id} .pair, main{color:red;}`,
      `#${id} .nest{main &{color:red;}}`,
      `@media (min-width: 2px){#${id} .ok{fill:red;} main{color:red;}}`,
      `@media (min-width: 3px){@media (min-width: 4px){#${id} .deep{fill:red;}}}`,
      `@supports (display: grid){#${id} .grid{fill:red;}}`,
      `@container (min-width: 5px){#${id} .box{fill:red;}}`,
      `@layer seed{#${id} .layer{fill:red;}}`,
      "@media (min-width: 6px){}",
      `#${id} .c{--x:&#125 @page&#123margin:0;}`,
      "@keyframes dash{to{stroke-dashoffset:0;}}",
      "@font-face{font-family:Seed;src:local(Seed);}",
      "</style></svg>",
    ].join(""));

    const { css } = await run("flowchart LR", "light");
    const id = mermaid.render.mock.calls[0]?.[0] ?? "";
    const heads = (css.match(/[^{}]+(?={)/g) ?? []).map((head) => head.trim());

    expect(heads).toEqual([
      `#${id}`,
      `#${id} .node`,
      `#${id}>.edge`,
      "@media (min-width: 1px)",
      `#${id} .wide`,
      `#${id} .b`,
      "@media (min-width: 3px)",
      "@media (min-width: 4px)",
      `#${id} .deep`,
      "@supports (display: grid)",
      `#${id} .grid`,
      "@container (min-width: 5px)",
      `#${id} .box`,
      "@layer seed",
      `#${id} .layer`,
      `#${id} .c`,
      `#${id}, #${id} *`,
    ]);
    expect(css).not.toMatch(/body|main|@page|@keyframes|@font-face|min-width: 2px|min-width: 6px/);
  });

  it("loses the motion of each kept rule, even an important one", async () => {
    stubSvg((id) => [
      `<svg id="${id}"><style>`,
      `#${id} .grow > *{fill:red !important;animation:enter 1s infinite !important;transition:fill 1s !important;cursor:pointer !important;}`,
      `@media (min-width: 1px){@media (min-width: 2px){#${id} .deep{fill:red;animation:enter 1s;}}}`,
      "</style></svg>",
    ].join(""));

    const { css } = await run("flowchart LR", "light");
    const id = mermaid.render.mock.calls[0]?.[0] ?? "";

    expect(css).toContain(`#${id} .grow > * { fill: red !important; }`);
    expect(css).toContain(`#${id} .deep { fill: red; }`);
    expect(css.replace(/\n.*$/, "")).not.toMatch(/animation|transition|cursor/);
  });

  it("comes from the SVG's own style elements only", async () => {
    stubSvg((id) =>
      `<svg id="${id}"><style>#${id} .own{fill:red;}</style><foreignObject><div><style>#${id} .label{fill:red;}</style>L</div></foreignObject></svg>`,
    );

    const { svg, css } = await run("flowchart LR", "light");

    expect(svg).not.toContain("<style");
    expect(css).toContain(".own");
    expect(css).not.toContain(".label");
  });
});

describe("the name and the description", () => {
  it("are the title and the presence of a description", async () => {
    stubDiagram('<title id="t">Watering plan</title><desc id="d">Two beds, one hose.</desc>');

    const { title, hasDescription } = await run("flowchart LR", "light");

    expect(title).toBe("Watering plan");
    expect(hasDescription).toBe(true);
  });

  it("are absent when the author wrote neither, or wrote them blank", async () => {
    expect(await run("flowchart LR", "light")).toMatchObject({
      title: undefined,
      hasDescription: false,
    });

    stubDiagram("<title> </title><desc>\n</desc>");

    expect(await run("flowchart LR", "light")).toMatchObject({
      title: undefined,
      hasDescription: false,
    });
  });

  it("are read from the SVG's own children only", async () => {
    stubDiagram("<g><title>Node tip</title><desc>Node text</desc></g>");

    expect(await run("flowchart LR", "light")).toMatchObject({
      title: undefined,
      hasDescription: false,
    });
  });
});

describe("the configuration", () => {
  it("is strict, base-themed, from the theme tokens and the container's font", async () => {
    await run("flowchart LR", "dark");

    for (const [config] of mermaid.initialize.mock.calls) {
      expect(config).toMatchObject({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "base",
        htmlLabels: true,
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
        fontFamily: '"Inter", sans-serif',
      });
      expect(Object.keys(config)).not.toContain("elk");
    }
    expect(siteColors()).toMatchObject({
      darkMode: true,
      fontFamily: '"Inter", sans-serif',
      fontSize: "14px",
    });
  });

  it("gives initialize the font only, so a theme that the diagram names derives its colours without the app's", async () => {
    await run("flowchart LR", "dark");

    expect(mermaid.initialize).toHaveBeenCalledTimes(2);
    expect(lastConfig().themeVariables).toEqual({ fontFamily: '"Inter", sans-serif', fontSize: "14px" });
    expect(mermaid.mermaidAPI.updateSiteConfig).toHaveBeenCalledTimes(1);
    expect(mermaid.mermaidAPI.updateSiteConfig.mock.lastCall![0]).toEqual({ themeVariables: siteColors() });
    expect(mermaid.mermaidAPI.updateSiteConfig.mock.invocationCallOrder[0]).toBeGreaterThan(
      mermaid.initialize.mock.invocationCallOrder[1]!,
    );
  });

  it("maps each colour that the base theme does not derive from the tokens", async () => {
    await run("flowchart LR", "light");

    const surface2 = "rgb(1, 1, 1)";
    const surface = "rgb(2, 2, 2)";
    const bg = "rgb(3, 3, 3)";
    const text = "rgb(4, 4, 4)";
    const graphic = "rgb(5, 5, 5)";
    const line = "rgb(6, 6, 6)";
    expect(siteColors()).toMatchObject({
      background: surface2,
      edgeLabelBackground: surface2,
      altSectionBkgColor: surface2,
      pieStrokeColor: surface2,
      primaryColor: surface,
      noteBkgColor: surface,
      sequenceNumberColor: surface,
      activationBkgColor: surface,
      emUiFill: surface,
      tertiaryColor: bg,
      excludeBkgColor: bg,
      emSwimlaneBackgroundOdd: bg,
      primaryTextColor: text,
      textColor: text,
      noteTextColor: text,
      branchLabelColor: text,
      todayLineColor: text,
      primaryBorderColor: graphic,
      secondaryBorderColor: graphic,
      tertiaryBorderColor: graphic,
      noteBorderColor: graphic,
      lineColor: graphic,
      activationBorderColor: graphic,
      doneTaskBorderColor: graphic,
      critBorderColor: graphic,
      vertLineColor: graphic,
      pieOuterStrokeColor: graphic,
      archEdgeColor: graphic,
      archEdgeArrowColor: graphic,
      archGroupBorderColor: graphic,
      emUiStroke: graphic,
      emProcessorStroke: graphic,
      emReadModelStroke: graphic,
      emCommandStroke: graphic,
      emEventStroke: graphic,
      doneTaskBkgColor: line,
      gridColor: line,
      emSwimlaneBackgroundStroke: line,
      emCommandFill: "rgb(10, 0, 255)",
      emEventFill: "rgb(20, 0, 255)",
      emReadModelFill: "rgb(30, 0, 255)",
      critBkgColor: "rgb(40, 0, 255)",
      wardleyEvolutionColor: "rgb(40, 0, 255)",
      emProcessorFill: "rgb(80, 0, 255)",
      pieOpacity: "1",
    });
  });

  it("fills each categorical palette from the chart tokens in order, from the start again after the eighth", async () => {
    await run("flowchart LR", "light");

    const chart = (index: number): string => `rgb(${String((index % 8) + 1)}0, 0, 255)`;
    const variables = siteColors();
    const palette = (prefix: string, first: number, length: number): unknown[] =>
      Array.from({ length }, (_, index) => variables[`${prefix}${String(first + index)}`]);
    const expected = (length: number): string[] => Array.from({ length }, (_, index) => chart(index));
    expect(palette("pie", 1, 12)).toEqual(expected(12));
    expect(palette("cScale", 0, 12)).toEqual(expected(12));
    expect(palette("git", 0, 8)).toEqual(expected(8));
    expect(palette("fillType", 0, 8)).toEqual(expected(8));
    expect(palette("venn", 1, 8)).toEqual(expected(8));
    expect(variables).not.toHaveProperty("pie13");
  });

  it("merges the nested colours into the objects that Mermaid derives", async () => {
    await run("flowchart LR", "light");

    const colors = mermaid.initialize.mock.calls[0]![0].themeVariables as Record<string, unknown>;
    expect(colors).not.toHaveProperty("cynefin");
    expect(colors).not.toHaveProperty("xyChart");
    expect(siteColors()).toMatchObject({ ...colors });
    expect(siteColors().cynefin).toEqual({
      domainFontSize: 16,
      boundaryColor: "derived",
      complicatedBg: "rgb(10, 0, 255)",
      complexBg: "rgb(30, 0, 255)",
      chaoticBg: "rgb(40, 0, 255)",
      confusionBg: "rgb(50, 0, 255)",
      clearBg: "rgb(60, 0, 255)",
      cliffColor: "rgb(4, 4, 4)",
    });
    expect(siteColors().xyChart).toEqual({
      backgroundColor: "derived",
      plotColorPalette: "#0a00ff,#1400ff,#1e00ff,#2800ff,#3200ff,#3c00ff,#4600ff,#5000ff",
    });
  });

  it("is not dark mode for the light theme", async () => {
    await run("flowchart LR", "light");

    expect(siteColors()).toMatchObject({ darkMode: false });
  });

  it("resolves the tokens on a hidden probe under <html> that is removed afterwards", async () => {
    await run("flowchart LR", "light");

    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every(({ parent, hidden }) => parent === document.documentElement && hidden === true)).toBe(true);
    expect(document.documentElement.querySelectorAll(":scope > span")).toHaveLength(0);
  });
});

describe("a render", () => {
  it("gets a unique id that is valid in a selector, the source and the container", async () => {
    await run("flowchart LR", "light");
    await run("sequenceDiagram", "light");

    const [first, second] = mermaid.render.mock.calls;
    expect(first?.[0]).toMatch(/^mermaid-\d+$/);
    expect(second?.[0]).toMatch(/^mermaid-\d+$/);
    expect(first?.[0]).not.toBe(second?.[0]);
    expect(first?.slice(1)).toEqual(["flowchart LR", container]);
    expect(second?.slice(1)).toEqual(["sequenceDiagram", container]);
  });

  it("waits for the fonts", async () => {
    const fonts = deferred();
    Object.defineProperty(document, "fonts", { value: { ready: fonts.promise }, configurable: true });

    const done = run("flowchart LR", "light");
    await Promise.resolve();
    await Promise.resolve();

    expect(mermaid.initialize).not.toHaveBeenCalled();
    fonts.resolve();
    await done;
    expect(mermaid.initialize).toHaveBeenCalled();
  });

  it("runs after the one before it, each configured just before it draws", async () => {
    const log: string[] = [];
    const first = deferred();
    mermaid.initialize.mockImplementation(() => {
      log.push("initialize");
    });
    mermaid.mermaidAPI.updateSiteConfig.mockImplementation((config) => {
      log.push(`colors ${String((config.themeVariables as { darkMode: boolean }).darkMode)}`);
      return config;
    });
    mermaid.render.mockImplementation(async (id, text) => {
      log.push(`render ${text}`);
      if (text === "first") {
        await first.promise;
      }
      return { svg: diagramSvg(id), diagramType: "flowchart-v2" };
    });

    const one = run("first", "dark");
    const two = run("second", "light");
    await vi.waitFor(() => {
      expect(log).toEqual(["initialize", "initialize", "colors true", "render first"]);
    });
    first.resolve();
    await Promise.all([one, two]);

    expect(log).toEqual([
      "initialize",
      "initialize",
      "colors true",
      "render first",
      "initialize",
      "initialize",
      "colors false",
      "render second",
    ]);
  });

  it("throws the Mermaid error and does not stop the next render", async () => {
    const failure = new Error("Parse error on line 1");
    mermaid.render.mockRejectedValueOnce(failure);

    const failed = run("flowchart ->", "light");
    const next = run("flowchart LR", "light");

    await expect(failed).rejects.toBe(failure);
    await expect(next).resolves.toMatchObject({ svg: expect.stringContaining("<svg") as unknown });
  });

  it("is skipped when it is aborted before it draws, and the next render still runs", async () => {
    const first = deferred();
    mermaid.render.mockImplementationOnce(async (id) => {
      await first.promise;
      return { svg: diagramSvg(id), diagramType: "flowchart-v2" };
    });
    const stale = new AbortController();

    const one = run("first", "light");
    const two = run("stale", "dark", stale.signal);
    const three = run("third", "light");
    stale.abort();
    first.resolve();

    await expect(one).resolves.toMatchObject({ title: undefined });
    await expect(two).rejects.toMatchObject({ name: "AbortError" });
    await expect(three).resolves.toMatchObject({ title: undefined });
    expect(mermaid.render.mock.calls.map(([, text]) => text)).toEqual(["first", "third"]);
    expect(mermaid.initialize).toHaveBeenCalledTimes(4);
  });
});
