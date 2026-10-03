import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MermaidDiagram } from "../../src/components/mermaid-diagram";
import { renderMermaid, type MermaidMarkup } from "../../src/lib/mermaid";
import type { Theme } from "../../src/lib/theme";
import { useUiStore } from "../../src/store/ui";
import { stubSystemTheme } from "../helpers";

vi.mock(import("../../src/lib/mermaid"), () => ({ renderMermaid: vi.fn() }));

type Call = {
  source: string;
  theme: Theme;
  resolve: (markup: MermaidMarkup) => void;
  reject: (failure: unknown) => void;
};

class FakeSheet {
  css = "";

  replaceSync(css: string): void {
    this.css = css;
  }
}

const SOURCE = "flowchart LR\n  seed --> sprout";

let calls: Call[];

function markup(label: string, overrides: Partial<MermaidMarkup> = {}): MermaidMarkup {
  return {
    svg: `<svg id="svg-${label}"><g><text>${label}</text></g></svg>`,
    css: `#svg-${label} { fill: none; }`,
    title: undefined,
    hasDescription: false,
    ...overrides,
  };
}

function call(index: number): Call {
  const found = calls[index];
  if (found === undefined) {
    throw new Error(`renderMermaid was called ${String(calls.length)} times`);
  }
  return found;
}

async function settle(index: number, outcome: { markup: MermaidMarkup } | { failure: unknown }): Promise<void> {
  await act(async () => {
    if ("markup" in outcome) {
      call(index).resolve(outcome.markup);
    } else {
      call(index).reject(outcome.failure);
    }
    await Promise.resolve();
  });
}

function block(): HTMLElement {
  return document.querySelector<HTMLElement>("[tabindex='0']")!;
}

function adoptedCss(): string[] {
  return (document.adoptedStyleSheets as unknown as FakeSheet[]).map((sheet) => sheet.css);
}

beforeEach(() => {
  calls = [];
  vi.mocked(renderMermaid).mockImplementation(
    (source, theme) => new Promise((resolve, reject) => calls.push({ source, theme, resolve, reject })),
  );
  stubSystemTheme("light");
  useUiStore.setState({ themePreference: "light" });
  vi.stubGlobal("CSSStyleSheet", FakeSheet);
  Object.defineProperty(document, "adoptedStyleSheets", { value: [], writable: true, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(renderMermaid).mockReset();
});

describe("while the diagram loads", () => {
  it("shows the source in the block, with its line breaks", () => {
    render(<MermaidDiagram source={SOURCE} />);

    expect(block().querySelector("pre > code")?.textContent).toBe(SOURCE);
    expect(block().querySelector("pre")?.classList.contains("whitespace-pre")).toBe(true);
    expect(screen.queryByRole("figure")).toBeNull();
  });

  it("renders into an empty, hidden element of no height across the block's content", () => {
    render(<MermaidDiagram source={SOURCE} />);

    const container = vi.mocked(renderMermaid).mock.calls[0]?.[2];
    expect(container?.childNodes).toHaveLength(0);
    expect(container?.getAttribute("aria-hidden")).toBe("true");
    expect(container?.parentElement).toBe(block());
    expect([...container!.classList]).toEqual(expect.arrayContaining(["invisible", "absolute", "inset-x-3.5", "h-0"]));
  });

  it("keeps the render element when the diagram replaces the source", async () => {
    render(<MermaidDiagram source={SOURCE} />);
    const container = vi.mocked(renderMermaid).mock.calls[0]?.[2];

    await settle(0, { markup: markup("one") });

    expect(screen.getByRole("figure")).toBeDefined();
    expect(container?.isConnected).toBe(true);
    expect(container?.parentElement).toBe(block());
  });
});

describe("the diagram", () => {
  it("is a figure named Diagram, described by the source when the author wrote no description", async () => {
    render(<MermaidDiagram source={SOURCE} />);
    await settle(0, { markup: markup("one") });

    const figure = screen.getByRole("figure", { name: "Diagram" });
    expect(figure.querySelector("svg#svg-one")).not.toBeNull();
    const description = document.getElementById(figure.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe(SOURCE);
    expect(description?.classList.contains("sr-only")).toBe(true);
    expect(figure.contains(description)).toBe(true);
    expect(block().querySelector("pre")).toBeNull();
  });

  it("is named by the author's title and keeps the author's description", async () => {
    render(<MermaidDiagram source={SOURCE} />);
    await settle(0, { markup: markup("one", { title: "Watering plan", hasDescription: true }) });

    const figure = screen.getByRole("figure", { name: "Watering plan" });
    expect(figure.hasAttribute("aria-describedby")).toBe(false);
    expect(figure.querySelector(".sr-only")).toBeNull();
  });

  it("adopts its CSS as a stylesheet", async () => {
    render(<MermaidDiagram source={SOURCE} />);
    await settle(0, { markup: markup("one") });

    expect(adoptedCss()).toEqual(["#svg-one { fill: none; }"]);
  });
});

describe("a source that Mermaid rejects", () => {
  it("shows the source, the note and Mermaid's message", async () => {
    render(<MermaidDiagram source={SOURCE} />);
    await settle(0, { failure: new Error("Parse error on line 2:\n---^") });

    expect(block().querySelector("pre > code")?.textContent).toBe(SOURCE);
    const note = document.getElementById(block().getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe("The diagram cannot be shown.Parse error on line 2:\n---^");
    expect(block().contains(note)).toBe(false);
    expect(screen.queryByRole("figure")).toBeNull();
  });

  it("shows a failure that is not an Error as its text", async () => {
    render(<MermaidDiagram source={SOURCE} />);
    await settle(0, { failure: "No diagram type detected" });

    expect(screen.getByText("No diagram type detected")).toBeTruthy();
  });
});

describe("the block", () => {
  it("is the same element, and keeps focus, from loading to the diagram to an error", async () => {
    const { rerender } = render(<MermaidDiagram source={SOURCE} />);
    const loading = block();
    loading.focus();

    await settle(0, { markup: markup("one") });
    expect(block()).toBe(loading);
    expect(document.activeElement).toBe(loading);

    rerender(<MermaidDiagram source="flowchart ->" />);
    await settle(1, { failure: new Error("Parse error") });
    expect(block()).toBe(loading);
    expect(document.activeElement).toBe(loading);
    expect(adoptedCss()).toEqual([]);

    rerender(<MermaidDiagram source={SOURCE} />);
    await settle(2, { markup: markup("two") });
    expect(block()).toBe(loading);
    expect(block().hasAttribute("aria-describedby")).toBe(false);
    expect(screen.queryByText("The diagram cannot be shown.")).toBeNull();
  });
});

describe("a new render", () => {
  it("follows a theme change and keeps the old diagram until the new one is ready", async () => {
    render(<MermaidDiagram source={SOURCE} />);
    await settle(0, { markup: markup("light") });

    act(() => {
      useUiStore.setState({ themePreference: "dark" });
    });

    expect(call(1)).toMatchObject({ source: SOURCE, theme: "dark" });
    expect(document.querySelector("svg#svg-light")).not.toBeNull();
    await settle(1, { markup: markup("dark") });
    expect(document.querySelector("svg#svg-light")).toBeNull();
    expect(document.querySelector("svg#svg-dark")).not.toBeNull();
  });

  it("replaces the old stylesheet, and unmounting removes the last one", async () => {
    const { unmount } = render(<MermaidDiagram source={SOURCE} />);
    await settle(0, { markup: markup("light") });
    act(() => {
      useUiStore.setState({ themePreference: "dark" });
    });
    await settle(1, { markup: markup("dark") });

    expect(adoptedCss()).toEqual(["#svg-dark { fill: none; }"]);
    unmount();
    expect(adoptedCss()).toEqual([]);
  });

  it("discards the result of a render that the source changed after", async () => {
    const { rerender } = render(<MermaidDiagram source={SOURCE} />);
    rerender(<MermaidDiagram source="sequenceDiagram" />);
    rerender(<MermaidDiagram source="flowchart TD" />);

    await settle(0, { markup: markup("stale") });
    await settle(1, { failure: new Error("Parse error") });

    expect(document.querySelector("svg#svg-stale")).toBeNull();
    expect(screen.queryByText("The diagram cannot be shown.")).toBeNull();
    expect(block().querySelector("pre > code")?.textContent).toBe("flowchart TD");

    await settle(2, { markup: markup("fresh") });
    expect(document.querySelector("svg#svg-fresh")).not.toBeNull();
  });

  it("aborts the old render when the source changes, and the last one on unmount", () => {
    const { rerender, unmount } = render(<MermaidDiagram source={SOURCE} />);
    rerender(<MermaidDiagram source="flowchart TD" />);
    const signals = vi.mocked(renderMermaid).mock.calls.map(([, , , signal]) => signal);

    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    unmount();
    expect(signals[1]?.aborted).toBe(true);
  });

  it("does not run when the source and the theme stay the same", () => {
    const { rerender } = render(<MermaidDiagram source={SOURCE} />);
    rerender(<MermaidDiagram source={SOURCE} />);

    expect(renderMermaid).toHaveBeenCalledOnce();
  });
});

describe("the theme", () => {
  it("comes from the preference and is not written on <html>", () => {
    document.documentElement.className = "light";
    useUiStore.setState({ themePreference: "dark" });

    render(<MermaidDiagram source={SOURCE} />);

    expect(call(0).theme).toBe("dark");
    expect(document.documentElement.className).toBe("light");
  });
});
