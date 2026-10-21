import { readFileSync } from "node:fs";
import { join } from "node:path";
import { utilityOf } from "./class-words";

const KIT_THEME = readFileSync(join(import.meta.dirname, "..", "..", "src", "styles", "kit-theme.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** The selector of the base rule of kit-theme.css that draws a border in the border colour, or "" with no such rule. */
export const KIT_BORDER_SELECTOR
  = /@layer base\s*\{\s*([^{}]+?)\s*\{\s*border-color:\s*var\(--color-border\);\s*\}\s*\}/.exec(KIT_THEME)?.[1] ?? "";

const BORDER_WIDTH = /^border(?:-[xytrblse])?(?:-\d+)?$/;

/** The `border` utilities that set no colour: a width, a style or a table layout. */
const BORDER_NOT_COLOR = /^border(?:-[xytrblse])?(?:-\d+|-solid|-dashed|-dotted|-double|-hidden|-none)?$|^border-(?:collapse|separate|spacing\b.*)$/;

/**
 * The elements under `root`, and `root`, that have a border width class and no
 * border colour class, both with no variant. Without a base rule, such a border
 * draws in the text colour.
 */
export function bareBorders(root: Element): Element[] {
  return [root, ...root.querySelectorAll("*")].filter((element) => {
    const utilities = [...element.classList].filter((name) => utilityOf(name) === name);
    return utilities.some((name) => BORDER_WIDTH.test(name))
      && utilities.every((name) => !name.startsWith("border") || BORDER_NOT_COLOR.test(name));
  });
}
