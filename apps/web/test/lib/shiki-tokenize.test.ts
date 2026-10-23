import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { expect, it, vi } from "vitest";
import { createTokenizer, type Hast } from "../../src/lib/shiki-tokenize";

const scan = vi.hoisted(() => vi.fn());

vi.mock(import("shiki/engine/javascript"), async (importOriginal) => {
  const actual = await importOriginal();
  type Options = Parameters<typeof actual.createJavaScriptRegexEngine>[0];
  return {
    ...actual,
    createJavaScriptRegexEngine: vi.fn((options?: Options) => {
      const engine = actual.createJavaScriptRegexEngine(options);
      return {
        ...engine,
        createScanner: (patterns: Parameters<typeof engine.createScanner>[0]) => {
          scan();
          return engine.createScanner(patterns);
        },
      };
    }),
  };
});

vi.mock(import("shiki/langs"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    bundledLanguages: { ...actual.bundledLanguages, broken: () => Promise.reject(new Error("the chunk failed to load")) },
  };
});

type HastNode = Hast | Hast["children"][number];
type HastElement = Extract<HastNode, { type: "element" }>;

function elementsOf(node: HastNode): HastElement[] {
  const own = node.type === "element" ? [node] : [];
  return "children" in node ? [...own, ...node.children.flatMap(elementsOf)] : own;
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(textOf).join("") : "";
}

/** The token spans that Shiki gave a colour. */
function colouredSpans(node: HastNode): HastElement[] {
  return elementsOf(node).filter((element) => element.tagName === "span" && /\bcolor:/.test(String(element.properties.style)));
}

const tokenize = createTokenizer();

const CODE = "// sum\nconst total = 1 + 2;";

it("gives the code Shiki colours that follow the theme, in a block that is a tab stop", async () => {
  const { id, hast } = await tokenize({ id: 7, code: CODE, language: "ts" });

  expect(id).toBe(7);
  expect(textOf(hast!)).toBe(CODE);
  expect(colouredSpans(hast!).length).toBeGreaterThan(0);
  expect(colouredSpans(hast!).every((span) => String(span.properties.style).startsWith("color:light-dark("))).toBe(true);
  expect(elementsOf(hast!).find((element) => element.tagName === "pre")!.properties.tabindex).toBe("0");
});

it("tokenizes with one JavaScript regex engine at target ES2018", async () => {
  await tokenize({ id: 1, code: CODE, language: "ts" });

  expect(createJavaScriptRegexEngine).toHaveBeenCalledExactlyOnceWith({ target: "ES2018", forgiving: true });
  expect(scan).toHaveBeenCalled();
});

it("colours a language that is embedded in the code", async () => {
  const code = "# Sum\n\n```py\ndef add(a, b):\n    return a + b\n```";
  const { hast } = await tokenize({ id: 1, code, language: "markdown" });

  expect(colouredSpans(hast!).some((span) => textOf(span) === "def")).toBe(true);
});

it.each(["no-such-language", "", "text"])("gives no colours to the code of the language %j", async (language) => {
  const { hast } = await tokenize({ id: 1, code: CODE, language });

  expect(textOf(hast!)).toBe(CODE);
  expect(colouredSpans(hast!)).toEqual([]);
});

it("gives no colours to a line of 1,000 characters or more, and colours the other lines", async () => {
  const long = `const big = ${"1".repeat(1_000)};`;
  const { hast } = await tokenize({ id: 1, code: `const small = 1;\n${long}`, language: "ts" });

  const [small, big] = elementsOf(hast!).filter((element) => element.properties.class === "line");
  expect(colouredSpans(small!).length).toBeGreaterThan(0);
  expect(textOf(big!)).toBe(long);
  expect(colouredSpans(big!)).toEqual([]);
});

it("gives no HAST when the grammar fails to load", async () => {
  expect(await tokenize({ id: 7, code: CODE, language: "broken" })).toEqual({ id: 7 });
});
