/**
 * The typed fields of a task or a comment, without the symbol-keyed source the
 * parser attaches. `Object.entries` returns string keys only, so the symbol goes.
 */
export function withoutSnapshot(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}
