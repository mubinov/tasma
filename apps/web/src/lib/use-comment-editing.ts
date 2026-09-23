import { useMutation, type QueryClient } from "@tanstack/react-query";
import type { Client } from "@tasma/protocol";
import {
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  bodyCorrection,
  commentFailureTitle,
  commentWriteOptions,
  titleCorrection,
  type CommentWrite,
} from "../api/mutations";
import { useNoticeStore } from "../store/notices";
import { editorKeyDown } from "./editor-key-down";
import type { FinalFocus } from "./final-focus";
import { BLANK_COMMENT_TITLE, hasUnsavedText, isBlankTitle, savesNothing, type Draft } from "./text-draft";
import type { EditorSubject } from "./editor-subject";
import { savedWords, savingWords, subjectWords } from "./unsaved-words";
import { useDiskChange, type DiskChange } from "./use-disk-change";
import { useUnsavedEntry, type UnsavedGuard } from "./use-unsaved-guard";

const EMPTY: Draft = { title: "", body: "" };

/** The editors a comment card and the add form are, as the page's registry names them. */
export type CommentSubject = Exclude<EditorSubject, { kind: "task" }>;

/** How the editor closed, which picks where the page lands the caret. */
export type CommentClose = {
  /** A write closed the editor, rather than the reader. */
  afterWrite: boolean;
  /** The comment the write concerns: issued by an add, repeated by a save. */
  commentId?: number;
};

export type CommentEditingOptions = {
  queryClient: QueryClient;
  client: Client;
  /** The project the task belongs to. */
  tag: string;
  /** The task the comment belongs to. */
  taskId: string;
  subject: CommentSubject;
  /**
   * The comment as the last read that landed holds it. `null` for the add form,
   * and for a comment that left the file while its editor was open.
   */
  disk: Draft | null;
  /** The comment's own stamp, falling back to the task's: a comment never edited has none. */
  updated: string;
  /** Another comment follows this one, so the serializer writes its body's last line end back. */
  lineEndRestored: boolean;
  /** The page's one guard on leaving with unsaved text. */
  guard: UnsavedGuard;
  onClose: (close: CommentClose) => void;
};

export type CommentEditing = {
  draft: Draft;
  /** Its own write is in flight. */
  saving: boolean;
  /** Marks the title input not valid and names the correction under it. */
  titleError: string | undefined;
  /** Marks the body editor not valid and names the correction under it. */
  bodyError: string | undefined;
  diskChange: DiskChange;
  /** The comment left the file while this editor was open, so Save is replaced by Discard. */
  removed: boolean;
  /** Whether this editor's own discard dialog is up, which Cancel opens. */
  discardAsked: boolean;
  discardFocusRef: RefObject<FinalFocus>;
  titleRef: RefObject<HTMLInputElement | null>;
  cancelRef: RefObject<HTMLButtonElement | null>;
  saveRef: RefObject<HTMLButtonElement | null>;
  formRef: RefObject<HTMLFormElement | null>;
  diskLineRef: RefObject<HTMLParagraphElement | null>;
  removedLineRef: RefObject<HTMLParagraphElement | null>;
  /** The caret follows the "Changed on disk" line to the field below it. */
  diskLineFocusLost: () => void;
  /** The Save control leaves because the comment did; the caret follows it to the line that replaces it. */
  saveFocusLost: () => void;
  changeDraft: (next: Draft) => void;
  cancel: () => void;
  save: () => void;
  /** Answers the discard dialog the way Keep editing does. */
  keepEditing: () => void;
  discard: () => void;
  /** Writes nothing: the fields and the start text both become the text on disk. */
  reload: () => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
};

/**
 * One comment editor: the card in editing, or the add form. Each holds its own
 * draft, sends its own write and answers its own Cancel, so any number of them
 * stand open at once; leaving the page is the one question they share, which the
 * page-level guard asks.
 */
export function useCommentEditing({
  queryClient,
  client,
  tag,
  taskId,
  subject,
  disk,
  updated,
  lineEndRestored,
  guard,
  onClose,
}: CommentEditingOptions): CommentEditing {
  const titleRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const diskLineRef = useRef<HTMLParagraphElement>(null);
  const removedLineRef = useRef<HTMLParagraphElement>(null);
  const discardFocusRef = useRef<FinalFocus>(null);
  const pendingFocusRef = useRef(false);
  const { mutateAsync: write, isPending: saving } = useMutation(commentWriteOptions(queryClient, client, tag));
  const [start, setStart] = useState<Draft>(disk ?? EMPTY);
  const [draft, setDraft] = useState<Draft>(disk ?? EMPTY);
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const [bodyError, setBodyError] = useState<string | undefined>(undefined);
  const [cancelAsked, setCancelAsked] = useState(false);
  // The add form has no comment on disk; a card whose comment left the file has
  // lost one, and keeps its text rather than unmounting with the reader's typing.
  const removed = subject.kind === "comment" && disk === null;
  const unsaved = hasUnsavedText(start, draft);
  const diskChange = useDiskChange({
    subject,
    start,
    draft,
    disk: disk ?? start,
    saving,
    updated,
  });

  function close(result: CommentClose): void {
    setCancelAsked(false);
    onClose(result);
  }

  function keepEditing(): void {
    // Base UI then falls back to the element that had focus when it opened.
    discardFocusRef.current = null;
    setCancelAsked(false);
  }

  function cancel(): void {
    // Cancel is not offered while a write runs, so its keyboard path stops here too.
    if (saving) {
      return;
    }
    if (unsaved) {
      setCancelAsked(true);
      return;
    }

    close({ afterWrite: false });
  }

  // No write can be in flight here: Cancel and Esc are the only ways in and
  // both are refused while one runs, and the dialog is modal over the form.
  function discard(): void {
    // Base UI's own destination leaves with the editor; the page moves the caret.
    discardFocusRef.current = "keep";
    close({ afterWrite: false });
  }

  function variables(): CommentWrite {
    const change = { title: draft.title, body: draft.body };

    return subject.kind === "new"
      ? {
          id: taskId,
          noticeTitle: commentFailureTitle(taskId, "new", "added"),
          kind: "add",
          input: change,
        }
      : {
          id: taskId,
          noticeTitle: commentFailureTitle(taskId, subject.id, "saved"),
          kind: "update",
          commentId: subject.id,
          change,
        };
  }

  async function runSave(): Promise<void> {
    if (saving || removed) {
      return;
    }
    if (isBlankTitle(draft.title)) {
      // `Field.Error` is not a live region, so a caret already in the input
      // hears nothing: the correction is spoken for that path alone.
      const inTitle = document.activeElement === titleRef.current;
      setTitleError(BLANK_COMMENT_TITLE);
      titleRef.current?.focus();
      if (inTitle) {
        useNoticeStore.getState().announce(BLANK_COMMENT_TITLE);
      }
      return;
    }
    // A Save that restores the text the editor opened with is what the line on
    // screen promises, so the disk change takes the write past this return. The
    // add form never meets the case: a new comment is appended last.
    if (subject.kind === "comment" && !diskChange.showing && savesNothing(start, draft, lineEndRestored)) {
      close({ afterWrite: false });
      return;
    }
    // Cancel and the "Changed on disk" line both leave the card while the write
    // runs, so a caret on either goes to Save, which stays.
    const leaving = [cancelRef.current, diskLineRef.current];
    if (leaving.some((element) => element?.contains(document.activeElement) === true)) {
      saveRef.current?.focus();
    }

    setTitleError(undefined);
    setBodyError(undefined);
    useNoticeStore.getState().announce(savingWords(subject));
    let written;
    try {
      written = await write(variables());
    } catch (error) {
      // The failure notice is announced a frame from now. A dialog open over
      // the write closes in this commit, so the focus it returns lands first.
      // eslint-disable-next-line @eslint-react/dom-no-flush-sync -- the close must commit before the next frame
      flushSync(() => {
        setTitleError(titleCorrection(error));
        setBodyError(bodyCorrection(error));
        keepEditing();
        // The editor still holds its text, so the question the page dialog asks
        // has no answer left.
        guard.keepEditing();
      });
      return;
    }

    guard.landed(subject);
    close({ afterWrite: true, commentId: written.commentId });
    useNoticeStore.getState().announce(savedWords(subject));
  }

  function save(): void {
    void runSave();
  }

  // A write moves the caret itself before it starts, so this is left with the
  // paths that take the line away with the editor still open.
  function diskLineFocusLost(): void {
    titleRef.current?.focus();
  }

  function saveFocusLost(): void {
    pendingFocusRef.current = true;
  }

  // The line the control sits in shows only where the disk differs, so there is
  // always a comment to reload from.
  function reload(): void {
    const text = disk ?? start;
    setStart(text);
    setDraft(text);
    titleRef.current?.focus();
  }

  function changeDraft(next: Draft): void {
    setDraft(next);
    // The mark and the line go at the next change of the field the daemon named.
    if (next.title !== draft.title) {
      setTitleError(undefined);
    }
    if (next.body !== draft.body) {
      setBodyError(undefined);
    }
  }

  function onKeyDown(event: ReactKeyboardEvent): void {
    editorKeyDown(event, cancel, formRef);
  }

  useUnsavedEntry(guard, subject, unsaved ? { removed, saving } : null);
  /*
   * The caret moves only off the control the swap removes: a caret in a field
   * had nothing taken from under it, and a line that accepts no text would send
   * the next keystrokes nowhere. Where the caret does move, the line is read on
   * focus, so the words are not spoken as well.
   */
  const announceRemoval = useEffectEvent(() => {
    useNoticeStore.getState().announce(`${subjectWords(subject)} was removed on disk. It can no longer be saved.`);
  });

  useLayoutEffect(() => {
    if (!removed || pendingFocusRef.current) {
      return;
    }

    announceRemoval();
  }, [removed]);

  // The line is there only while the comment is removed, so the other path that
  // takes the control away — the editor closing — resolves to nothing. No modal
  // dialog can be open here: the move happens only where the caret was on Save.
  useLayoutEffect(() => {
    if (!pendingFocusRef.current) {
      return;
    }

    pendingFocusRef.current = false;
    removedLineRef.current?.focus();
  });

  return {
    draft,
    saving,
    titleError,
    bodyError,
    diskChange,
    removed,
    discardAsked: cancelAsked,
    discardFocusRef,
    titleRef,
    cancelRef,
    saveRef,
    formRef,
    diskLineRef,
    removedLineRef,
    diskLineFocusLost,
    saveFocusLost,
    changeDraft,
    cancel,
    save,
    keepEditing,
    discard,
    reload,
    onKeyDown,
  };
}
