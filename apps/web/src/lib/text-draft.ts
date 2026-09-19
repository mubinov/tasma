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
 * Whether a Save would leave the file as it is. Where a comment follows the
 * body, the daemon writes the body's last line end back, so a body that is the
 * start body without that line end writes nothing. The reverse is a change: a
 * line end the start body has not is text the daemon keeps.
 */
export function savesNothing(start: Draft, draft: Draft, hasComments: boolean): boolean {
  if (draft.title !== start.title) {
    return false;
  }

  return draft.body === start.body
    || (hasComments && start.body.endsWith("\n") && draft.body === start.body.slice(0, -1));
}

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
