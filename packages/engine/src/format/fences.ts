import { stripCR } from "./text.js";

/** A fence delimiter: up to three spaces of indentation, then three or more backticks or tildes. */
const DELIMITER = /^ {0,3}(`{3,}|~{3,})(.*)$/;

type Fence = { char: string; length: number; line: number };

/** Whether a delimiter line closes the fence that is open. */
function closes(delimiter: string, rest: string, open: Fence): boolean {
  return delimiter.startsWith(open.char) && delimiter.length >= open.length && /^[ \t]*$/.test(rest);
}

/**
 * The CommonMark 0.31.2 fenced code blocks a task file models.
 *
 * Container blocks are out of the subset: a fence carried by a list item or a
 * block quote is indented or prefixed, so it is not recognized. This does not
 * change marker recognition, because a marker starts at column 0 and a line at
 * column 0 leaves every container it follows.
 */
export class FenceTracker {
  #open: Fence | undefined;

  /** The line an unclosed fence opened on, or `undefined` when no fence is open. */
  get openedAt(): number | undefined {
    return this.#open?.line;
  }

  /** Feeds the next line and answers whether it is part of a fenced code block. */
  push(line: string, lineNumber: number): boolean {
    const match = DELIMITER.exec(stripCR(line));
    const open = this.#open;

    if (open !== undefined) {
      if (match !== null && closes(match[1]!, match[2]!, open)) this.#open = undefined;
      return true;
    }

    if (match === null) return false;
    const delimiter = match[1]!;
    if (delimiter.startsWith("`") && match[2]!.includes("`")) return false;
    this.#open = { char: delimiter.charAt(0), length: delimiter.length, line: lineNumber };
    return true;
  }
}
