/** The title and the body an editor holds, as its two fields show them. */
export type Draft = { title: string; body: string };

function sameText(left: Draft, right: Draft): boolean {
  return left.title === right.title && left.body === right.body;
}

/** Whether the editor holds text that differs from the text it opened with. */
export function hasUnsavedText(start: Draft, draft: Draft): boolean {
  return !sameText(start, draft);
}

/**
 * Whether a Save would leave the file as it is. `lineEndRestored` says the
 * serializer writes the body's last line end back, because another piece
 * follows the body — a comment after the task body, a later comment after this
 * one — so a body that is the start body without that line end writes nothing.
 * The reverse is a change: a line end the start body has not is text the daemon
 * keeps.
 */
export function savesNothing(start: Draft, draft: Draft, lineEndRestored: boolean): boolean {
  if (draft.title !== start.title) {
    return false;
  }

  return draft.body === start.body
    || (lineEndRestored && start.body.endsWith("\n") && draft.body === start.body.slice(0, -1));
}

/** The correction for a task title `isBlankTitle` refuses. */
export const BLANK_TITLE = "A task needs a title.";

/** The same for a comment's title, which is required where its body is not. */
export const BLANK_COMMENT_TITLE = "A comment needs a title.";

export function isBlankTitle(title: string): boolean {
  return title.trim() === "";
}

export type DiskComparison = {
  /** The text the editor opened with. */
  start: Draft;
  /** The text it holds now. */
  draft: Draft;
  /** The text of the last read that landed. */
  disk: Draft;
};

/**
 * Whether the disk holds text the editor knows nothing of. A disk that already
 * holds the text in the editor reports nothing, which covers a write whose
 * answer was lost but which the daemon carried out.
 */
export function changedOnDisk({ start, draft, disk }: DiskComparison): boolean {
  return !sameText(disk, start) && !sameText(disk, draft);
}
