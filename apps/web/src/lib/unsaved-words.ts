import type { EditorSubject } from "./editor-subject";

/** One editor holding unsaved text, as the page-level guard registers it. */
export type UnsavedEditor = {
  subject: EditorSubject;
  /** The comment left the file while its editor was open, so its text can no longer be saved. */
  removed: boolean;
};

/** A comment inside a sentence. */
export function commentWords(id: number): string {
  return `comment #${String(id)}`;
}

/** The subject inside a sentence. */
function subjectPhrase(subject: EditorSubject): string {
  switch (subject.kind) {
    case "task":
      return "the task text";
    case "comment":
      return commentWords(subject.id);
    case "new":
      return "the new comment";
  }
}

function capitalize(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The subject at the head of a sentence. */
export function subjectWords(subject: EditorSubject): string {
  return capitalize(subjectPhrase(subject));
}

/** What a control that belongs to one of several editors is named. */
export function reloadLabel(subject: EditorSubject): string {
  return subject.kind === "comment" ? `Discard and reload ${commentWords(subject.id)}` : "Discard and reload";
}

/** What the editor says when its write starts. */
export function savingWords(subject: EditorSubject): string {
  switch (subject.kind) {
    case "task":
      return "Saving…";
    case "comment":
      return `Saving ${commentWords(subject.id)}…`;
    case "new":
      return "Adding the new comment…";
  }
}

/** What the editor says when its write lands. */
export function savedWords(subject: EditorSubject): string {
  switch (subject.kind) {
    case "task":
      return "Saved.";
    case "comment":
      return `${subjectWords(subject)} saved.`;
    case "new":
      return "Comment added.";
  }
}

const ORDER: Record<EditorSubject["kind"], number> = { task: 0, comment: 1, new: 2 };

/** The task text first, then the comments by id, then the add form. */
function inReadingOrder(editors: readonly UnsavedEditor[]): UnsavedEditor[] {
  return [...editors].sort((left, right) => {
    const places = ORDER[left.subject.kind] - ORDER[right.subject.kind];
    if (places !== 0 || left.subject.kind !== "comment" || right.subject.kind !== "comment") {
      return places;
    }

    return left.subject.id - right.subject.id;
  });
}

/**
 * The subjects as one phrase, with a run of comments folded into one plural:
 * "the task text and comments #3 and #5".
 */
function joinSubjects(subjects: readonly EditorSubject[]): string {
  const comments = subjects.filter((subject) => subject.kind === "comment");
  const others = subjects.filter((subject) => subject.kind !== "comment");
  const ids = comments.map(({ id }) => `#${String(id)}`);
  const folded = comments.length > 1 ? [`comments ${listWords(ids)}`] : comments.map(subjectPhrase);
  const parts = [
    ...others.filter(({ kind }) => kind === "task").map(subjectPhrase),
    ...folded,
    ...others.filter(({ kind }) => kind === "new").map(subjectPhrase),
  ];

  return listWords(parts);
}

/** "a", "a and b", "a, b and c". */
function listWords(parts: readonly string[]): string {
  if (parts.length < 3) {
    return parts.join(" and ");
  }

  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`;
}

function removedClauses(editors: readonly UnsavedEditor[]): string[] {
  return editors
    .filter(({ removed }) => removed)
    .map(({ subject }) => `${subjectWords(subject)} was removed on disk and cannot be saved.`);
}

/** The sentence about the editors that can still be saved, `null` where none can. */
function unsavedClause(editors: readonly UnsavedEditor[], still: boolean): string | null {
  const saveable = editors.filter(({ removed }) => !removed).map(({ subject }) => subject);
  if (saveable.length === 0) {
    return null;
  }

  const verb = saveable.length > 1 ? "are" : "is";

  return `${capitalize(joinSubjects(saveable))} ${verb} ${still ? "still " : ""}not saved.`;
}

/**
 * What the page dialog asks about, `null` where no editor holds unsaved text.
 * It names every editor, so Keep editing gives the reader somewhere to go.
 */
export function unsavedDescription(editors: readonly UnsavedEditor[]): string | null {
  if (editors.length === 0) {
    return null;
  }

  const ordered = inReadingOrder(editors);
  const clause = unsavedClause(ordered, false);

  return [...(clause === null ? [] : [clause]), ...removedClauses(ordered), "There is no undo."].join(" ");
}

/**
 * What the page dialog shows once one editor's save lands while it stands open.
 * Visible text alone: the editor itself speaks its own completion.
 */
export function savedStatus(saved: EditorSubject, rest: readonly UnsavedEditor[]): string {
  const ordered = inReadingOrder(rest);
  const clause = unsavedClause(ordered, true);

  return [savedWords(saved), ...(clause === null ? [] : [clause]), ...removedClauses(ordered)].join(" ");
}
