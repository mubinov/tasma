import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const GLOBAL_CSS = readFileSync(join(import.meta.dirname, "../src/styles/global.css"), "utf8");
const THEME_CSS = readFileSync(join(import.meta.dirname, "../src/styles/theme.css"), "utf8");

/** The index just past the block that opens at the first `{` after `at`. */
function pastBlock(css: string, at: number): number {
  let depth = 0;

  for (let index = css.indexOf("{", at); index < css.length; index += 1) {
    depth += css[index] === "{" ? 1 : css[index] === "}" ? -1 : 0;
    if (depth === 0) {
      return index + 1;
    }
  }

  return css.length;
}

/** What no `@layer` holds. A layered rule loses to these, whatever its specificity. */
function unlayered(css: string): string {
  let kept = "";
  let at = 0;

  while (at < css.length) {
    const layer = css.indexOf("@layer", at);
    if (layer === -1) {
      return kept + css.slice(at);
    }

    kept += css.slice(at, layer);
    at = pastBlock(css, layer);
  }

  return kept;
}

it("sets the grab cursor on every element under a dragging root, outside every layer", () => {
  expect(unlayered(GLOBAL_CSS)).toMatch(/html\.cursor-grabbing \*\s*\{[^}]*cursor:\s*grabbing/);
});

it("draws the focus ring in the focus role, inside a layer so a control can drop it", () => {
  expect(GLOBAL_CSS).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-focus\)[^}]*outline-offset:\s*2px/);
  expect(unlayered(GLOBAL_CSS)).not.toContain(":focus-visible");
});

it("fills every find match in the match role with a dotted underline, and the current one in the stronger role with a solid one", () => {
  expect(GLOBAL_CSS).toMatch(
    /::highlight\(task-find\)\s*\{[^}]*background-color:\s*var\(--color-match\);[^}]*color:\s*var\(--color-text\);[^}]*text-decoration:\s*underline dotted 1px var\(--color-text\)/,
  );
  expect(GLOBAL_CSS).toMatch(
    /::highlight\(task-find-current\)\s*\{[^}]*background-color:\s*var\(--color-match-current\);[^}]*color:\s*var\(--color-text\);[^}]*text-decoration:\s*underline 2px/,
  );
});

it("registers the page's scroll padding as a length that starts at 0, so script reads it in px", () => {
  expect(GLOBAL_CSS).toMatch(
    /@property --page-scroll-padding\s*\{\s*syntax:\s*"<length>";\s*inherits:\s*false;\s*initial-value:\s*0px;\s*\}/,
  );
});

it("gives the page a top scroll padding of the band on every screen, inside a layer so a screen can set its own", () => {
  expect(GLOBAL_CSS).toMatch(/@layer base\s*\{\s*html\s*\{[^}]*scroll-padding-top:\s*var\(--title-band\)/);
  expect(unlayered(GLOBAL_CSS)).not.toContain("scroll-padding-top");
});

it("gives a browser no band and no width for the window buttons", () => {
  expect(THEME_CSS).toMatch(/:root\s*\{[^}]*--title-band:\s*0px;[^}]*--title-controls:\s*0px;/);
});

it("puts the cover of the band above the top bar and below the sidebar", () => {
  const layer = (name: string) => Number(new RegExp(`--layer-${name}:\\s*(\\d+);`).exec(THEME_CSS)?.[1]);

  expect(layer("title-cover")).toBeGreaterThan(layer("top-bar"));
  expect(layer("title-cover")).toBeGreaterThan(layer("column-header"));
  expect(layer("title-cover")).toBeGreaterThan(layer("comment-header"));
  expect(layer("title-cover")).toBeLessThan(layer("sidebar"));
  expect(layer("sidebar")).toBeLessThan(layer("notice"));
});
