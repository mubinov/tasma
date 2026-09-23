import type { Comment } from "@tasma/protocol";
import { useRef, useState, type RefObject } from "react";
import { focusFirst } from "./final-focus";
import type { CommentClose } from "./use-comment-editing";
import { usePendingFocus } from "./use-pending-focus";

/** One card of the list. */
export type CommentRow = {
  comment: Comment;
  /** The file still holds the comment. */
  onDisk: boolean;
  /** The card renders its editor in place of the comment. */
  editing: boolean;
  /**
   * Another comment follows this one in the file, so the serializer writes its
   * body's last line end back. Read from the file, not from the cards: a card
   * detached from the file is no comment the serializer writes.
   */
  lineEndRestored: boolean;
};

/** A comment whose editor is open, as the last read that held it had it, with that read's id order. */
export type SeenComment = { comment: Comment; read: readonly number[] };

/** The comments a card stands between, read before the write that removes it. */
type CommentPlace = { next?: number; previous?: number };

/** What a card in editing shows of its comment, so a poll that changes none of it keeps the held copy. */
function commentSignature({ id, title, body, author, created, updated, collapsed }: Comment): string {
  return JSON.stringify([id, title, body, author ?? null, created, updated ?? null, collapsed ?? null]);
}

/**
 * The last read that held each comment being edited. A comment that leaves the
 * file keeps its card and its place from here: left to unmount, the reader's
 * typing would go with no word. The same map is returned where nothing moved, so
 * a poll that changes nothing settles in one render.
 */
export function seenComments(
  comments: readonly Comment[],
  editingIds: ReadonlySet<number>,
  seen: ReadonlyMap<number, SeenComment>,
): ReadonlyMap<number, SeenComment> {
  let next: Map<number, SeenComment> | null = null;
  const read = comments.map(({ id }) => id);
  const order = read.join(",");

  for (const comment of comments) {
    const held = seen.get(comment.id);
    if (!editingIds.has(comment.id)
      || (held?.read.join(",") === order && commentSignature(held.comment) === commentSignature(comment))) {
      continue;
    }

    next ??= new Map(seen);
    next.set(comment.id, { comment, read });
  }
  for (const id of seen.keys()) {
    if (!editingIds.has(id)) {
      next ??= new Map(seen);
      next.delete(id);
    }
  }

  return next ?? seen;
}

/**
 * The cards to draw: the comments the file holds, and every card detached from
 * it, each directly after the last card still drawn that stood before it in its
 * own last read.
 *
 * The detached cards go in from the one that left last. A card that left
 * earlier was read beside the ones that left after it, so they are already
 * drawn when it looks for its place; the reverse does not hold. A card that left
 * earlier also read more of the other detached cards on the file, which is what
 * orders them.
 */
export function commentRows(
  comments: readonly Comment[],
  editingIds: ReadonlySet<number>,
  seen: ReadonlyMap<number, SeenComment>,
): CommentRow[] {
  const last = comments.at(-1)?.id;
  const rows: CommentRow[] = comments.map((comment) => ({
    comment,
    onDisk: true,
    editing: editingIds.has(comment.id),
    lineEndRestored: comment.id !== last,
  }));
  const detached = [...editingIds].flatMap((id) => {
    const held = seen.get(id);
    return held === undefined || comments.some((comment) => comment.id === id) ? [] : [held];
  });
  const detachedIds = new Set(detached.map(({ comment: { id } }) => id));
  const othersRead = ({ read }: SeenComment): number => read.filter((id) => detachedIds.has(id)).length;
  detached.sort((left, right) => othersRead(left) - othersRead(right));

  for (const { comment, read } of detached) {
    const before = new Set(read.slice(0, read.indexOf(comment.id)));
    const after = rows.findLastIndex((row) => before.has(row.comment.id)) + 1;
    rows.splice(after, 0, { comment, onDisk: false, editing: true, lineEndRestored: false });
  }

  return rows;
}

function placeOf(rows: readonly CommentRow[], place: number): CommentPlace {
  return { next: rows[place + 1]?.comment.id, previous: rows[place - 1]?.comment.id };
}

export type CommentList = {
  rows: readonly CommentRow[];
  /** The add form stands in place of the Add comment button. */
  adding: boolean;
  listRef: RefObject<HTMLOListElement | null>;
  headingRef: RefObject<HTMLHeadingElement | null>;
  addButtonRef: RefObject<HTMLButtonElement | null>;
  openAddForm: () => void;
  closeAddForm: (close: CommentClose) => void;
  openEditor: (place: number) => void;
  closeEditor: (place: number, close: CommentClose) => void;
  /** The write that removed the card at `place` landed. */
  deleted: (place: number) => void;
};

/**
 * The comment list of the task page: which cards are in editing, the cards
 * whose comment left the file, the add form, and where the caret goes as each
 * of them opens and closes.
 */
export function useCommentList(comments: readonly Comment[]): CommentList {
  const listRef = useRef<HTMLOListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const focusLater = usePendingFocus();
  const [editingIds, setEditingIds] = useState<ReadonlySet<number>>(() => new Set());
  const [seen, setSeen] = useState<ReadonlyMap<number, SeenComment>>(() => new Map());
  const [adding, setAdding] = useState(false);
  // Held during render rather than in an effect: a card whose comment left the
  // file has to keep its text in the very commit that drops it from the list.
  const held = seenComments(comments, editingIds, seen);
  if (held !== seen) {
    setSeen(held);
  }
  const rows = commentRows(comments, editingIds, held);

  /** A control of one card, absent where the card is in editing or has gone. */
  function cardControl(commentId: number | undefined, selector: string): HTMLElement | null {
    if (commentId === undefined) {
      return null;
    }

    return listRef.current?.querySelector<HTMLElement>(
      `[data-comment-id="${String(commentId)}"] ${selector}`,
    ) ?? null;
  }

  function addFormTitle(): HTMLElement | null {
    return document.querySelector<HTMLElement>("[data-add-form] [data-comment-title]");
  }

  /**
   * Where the caret goes when a card leaves. Each candidate is tried in turn:
   * a card in editing has no menu button, the Add comment button is absent while
   * the form stands in its place, and the heading ends the list before `<body>`
   * can.
   */
  function afterCard(place: CommentPlace): (HTMLElement | null)[] {
    return [
      cardControl(place.next, "[data-comment-menu]"),
      cardControl(place.next, "[data-comment-title]"),
      cardControl(place.previous, "[data-comment-menu]"),
      cardControl(place.previous, "[data-comment-title]"),
      addButtonRef.current,
      addFormTitle(),
      headingRef.current,
      document.querySelector<HTMLElement>("main"),
    ];
  }

  function openEditor(place: number): void {
    const commentId = rows[place]!.comment.id;
    // Updated from the set React holds, not the one this render read: several
    // editors can open or close before the page renders again.
    setEditingIds((open) => new Set(open).add(commentId));
    focusLater(() => {
      cardControl(commentId, "[data-comment-title]")?.focus();
    });
  }

  function closeEditor(place: number, close: CommentClose): void {
    const { comment: { id: commentId }, onDisk } = rows[place]!;
    const around = placeOf(rows, place);

    setEditingIds((open) => {
      const next = new Set(open);
      next.delete(commentId);
      return next;
    });

    // A card the file no longer holds has no menu button to return to, so the
    // caret resolves from the place the card last stood in.
    focusLater(
      onDisk
        ? () => {
            cardControl(commentId, "[data-comment-menu]")?.focus();
          }
        : () => {
            focusFirst(afterCard(around));
          },
      close.afterWrite,
    );
  }

  function openAddForm(): void {
    setAdding(true);
    focusLater(() => {
      addFormTitle()?.focus();
    });
  }

  function closeAddForm(close: CommentClose): void {
    setAdding(false);

    focusLater(
      close.afterWrite && close.commentId !== undefined
        ? () => {
            cardControl(close.commentId, "[data-comment-menu]")?.focus();
          }
        : () => {
            addButtonRef.current?.focus();
          },
      close.afterWrite,
    );
  }

  function deleted(place: number): void {
    const around = placeOf(rows, place);

    focusLater(() => {
      focusFirst(afterCard(around));
    });
  }

  return {
    rows,
    adding,
    listRef,
    headingRef,
    addButtonRef,
    openAddForm,
    closeAddForm,
    openEditor,
    closeEditor,
    deleted,
  };
}
