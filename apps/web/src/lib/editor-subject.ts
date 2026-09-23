/**
 * What the page calls each editor it can hold open at once. A value rather than
 * a string: one string cannot yield both the head of a sentence and the form
 * that sits inside one.
 */
export type EditorSubject
  = | { kind: "task" }
    | { kind: "comment"; id: number }
    | { kind: "new" };

/** The key the page's registry holds one editor under. */
export function editorKey(subject: EditorSubject): string {
  return subject.kind === "comment" ? `comment:${String(subject.id)}` : subject.kind;
}
