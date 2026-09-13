/** The count as a warnings line shows it and a screen reader summary says it, in the same words. */
export function warningCount(count: number): string {
  return count === 1 ? "1 warning" : `${String(count)} warnings`;
}
