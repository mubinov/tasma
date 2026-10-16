import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const GLOBAL_CSS = readFileSync(join(import.meta.dirname, "../src/styles/global.css"), "utf8");

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

it("unsticks the comment headers and their scroll margin in a short window while the find row is open, outside every layer", () => {
  const css = unlayered(GLOBAL_CSS);

  expect(css).toMatch(/@media \(max-height: 30rem\)\s*\{\s*html:has\(\[data-find-row\]\) \[data-comment-header\]\s*\{\s*position:\s*static;/);
  expect(css).toMatch(/html:has\(\[data-find-row\]\) \[data-comment-text\] \*\s*\{\s*scroll-margin-top:\s*0;/);
});

it("registers the page's scroll padding as a length that starts at 0, so script reads it in px", () => {
  expect(GLOBAL_CSS).toMatch(
    /@property --page-scroll-padding\s*\{\s*syntax:\s*"<length>";\s*inherits:\s*false;\s*initial-value:\s*0px;\s*\}/,
  );
});
