// How every listing and both views reach the terminal: one mark for a value a
// record does not state, one padding rule, the byte that keeps the shell prompt
// off the last line, and how an answer whose shape is not known yet is read.
//
// Alignment is for a reader's eye and is not a delimiter a parser can trust: the
// padding counts UTF-16 code units, so a wide character shifts the columns after
// it by a little.

import { wireText } from "./shell.js";

/** What a column carries where a record states no value. */
const ABSENT = "-";

/** The gap between two columns. Wide enough that a padded column reads as one. */
const GAP = "  ";

/**
 * A value as a cell.
 *
 * The three ways an answer states nothing print one mark, so a column never goes
 * empty and the columns after it stay where they are.
 */
export function cell(value: unknown): string {
  return value === undefined || value === null || value === "" ? ABSENT : wireText(value);
}

/**
 * Rows as aligned lines, in the order they were given: nothing here sorts.
 *
 * The last column is left unpadded, so no line ends in the spaces a reader would
 * have to strip.
 */
export function table(rows: string[][]): string {
  if (rows.length === 0) return "";

  const widths: number[] = [];

  for (const row of rows) {
    row.forEach((value, column) => {
      widths[column] = Math.max(widths[column] ?? 0, value.length);
    });
  }

  // Every column has a width: it was measured over these same rows.
  const lines = rows.map((row) =>
    row.map((value, column) => (column === row.length - 1 ? value : value.padEnd(widths[column]!))).join(GAP));

  return `${lines.join("\n")}\n`;
}

/** The text with a line break at its end, added only where it has none. */
export function withLineBreak(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * A value as a record to read fields off.
 *
 * An answer is whatever the port sent, and every writer reads a field off each
 * element of a listing, so an element that is no object answers with no fields
 * at all rather than throwing out of the writer printing it.
 */
export function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Whether an answer is the text route's.
 *
 * It stands here rather than beside the listing's own guard because two nouns
 * print that route's answer: `task view` and `comment view`.
 */
export function isTaskText(answer: unknown): answer is { text: string; hidden: unknown[] } {
  const { text, hidden } = fieldsOf(answer);

  return typeof text === "string" && Array.isArray(hidden);
}
