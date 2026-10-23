import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";

/** The time that the lazy Shiki chunk and the grammar of a block take to load. */
export const SHIKI_LOAD = { timeout: 5000 };

/** The `Pre` and `Code` that the markdown gives a fenced block, with the plain `pre` as `plain`. */
export const plainComponents: SyntaxHighlighterProps["components"] = {
  Pre: (props) => <pre data-testid="plain" {...props} />,
  Code: (props) => <code {...props} />,
};

/** The token spans under `root` that Shiki gave an inline colour. */
export function colouredTokens(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("pre span[style]")].filter((span) => span.style.color !== "");
}
