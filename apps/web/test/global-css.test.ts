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
