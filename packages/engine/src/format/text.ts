/** Text helpers shared by the reader, the writer and the fence tracker. */

/** One line without its terminator; `end` is the offset just past it. */
export type Line = { text: string; start: number; end: number };

export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      lines.push({ text: text.slice(start), start, end: text.length });
      break;
    }
    lines.push({ text: text.slice(start, newline), start, end: newline + 1 });
    start = newline + 1;
  }
  return lines;
}

/** A line without the carriage return that a CRLF file leaves at its end. */
export function stripCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** The number of line breaks in a piece of text. */
export function newlines(text: string): number {
  return text.split("\n").length - 1;
}

/** The lines of a region, without the empty piece a trailing line break leaves behind. */
export function regionLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
