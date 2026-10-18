/**
 * The words of each string literal in `source`, split on whitespace. A
 * template literal is also split on quotes and on `${` and `}`, so a class in
 * a string inside one of its expressions is a word of its own.
 */
export function stringWords(source: string): string[] {
  return [...source.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`]*)`/g)]
    .flatMap(([, double, single, template]) =>
      (template === undefined ? (double ?? single ?? "").split(/\s+/) : template.split(/[\s"'${}]+/)));
}

/** The utility of a class, after its variants: `dark:hover:bg-muted/50` gives `bg-muted/50`. */
export function utilityOf(token: string): string {
  let depth = 0;
  let start = 0;
  [...token].forEach((char, index) => {
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === ":" && depth === 0) start = index + 1;
  });
  return token.slice(start);
}

/** The utility prefixes that take a colour name. */
export const COLOR_PREFIX = "(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|divide|caret|decoration|accent|shadow|inset-shadow|inset-ring)";

/** The opacity modifier of a colour utility: `/50`, `/2.5`, `/[0.5]` or `/(--alpha)`. */
export const OPACITY = "(?:\\/(?:\\d+(?:\\.\\d+)?|\\[[^\\]]+\\]|\\(--[\\w-]+\\)))?";

/** The side or corner of a `rounded-*` utility: `rounded-t-lg`, `rounded-tl-lg`. */
export const RADIUS_SIDE = "(?:-(?:[trblsexy]|tl|tr|br|bl|ss|se|es|ee))?";
