import { readFileSync } from "node:fs";

/**
 * The first block a document fences with three backticks and the given info
 * string. A contract document carries its reference example that way, so a
 * document that stops doing so fails here rather than comparing some other
 * block.
 */
export function firstFencedBlock(path: string, info: string): string {
  const text = readFileSync(path, "utf8");
  const open = `\n\`\`\`${info}\n`;
  const start = text.indexOf(open);
  const end = start === -1 ? -1 : text.indexOf("\n```\n", start + open.length);
  if (end === -1) throw new Error(`${path} carries no fenced ${info} block`);
  return text.slice(start + open.length, end + 1);
}
