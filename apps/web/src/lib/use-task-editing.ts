import { useMutation, type QueryClient } from "@tanstack/react-query";
import type { Client } from "@tasma/protocol";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { bodyCorrection, taskWriteOptions } from "../api/mutations";
import { useNoticeStore } from "../store/notices";
import { useUiStore, type EditRequest } from "../store/ui";
import { editorKeyDown } from "./editor-key-down";
import type { FinalFocus } from "./final-focus";
import { BLANK_TITLE, hasUnsavedText, isBlankTitle, savesNothing, type Draft } from "./text-draft";
import type { EditorSubject } from "./editor-subject";
import { savedWords, savingWords } from "./unsaved-words";
import { useDiskChange, type DiskChange } from "./use-disk-change";
import { usePendingFocus } from "./use-pending-focus";
import { useUnsavedEntry, type UnsavedGuard } from "./use-unsaved-guard";
import { pageFailureLine } from "./write-failure";

/** The task text is one of the editors the page can hold open at once. */
const SUBJECT: EditorSubject = { kind: "task" };

export type TaskEditingOptions = {
  queryClient: QueryClient;
  client: Client;
  /** The project the task belongs to. */
  tag: string;
  id: string;
  /** The title and the body of the last read that landed. */
  disk: Draft;
  /** The `updated` of that read. */
  updated: string;
  /** The daemon writes the body's last line end back where a comment follows it. */
  lineEndRestored: boolean;
  /** The page's one guard on leaving with unsaved text, shared with every comment editor. */
  guard: UnsavedGuard;
};

export type TaskEditing = {
  /** The text the two fields hold, `null` while the page is in reading. */
  draft: Draft | null;
  /** A write is in flight. */
  saving: boolean;
  /** Marks the title input not valid and names the correction under it. */
  titleError: string | undefined;
  /** Marks the body editor not valid and names the correction under it. */
  bodyError: string | undefined;
  diskChange: DiskChange;
  /** Whether this editor's own discard dialog is up, which Cancel opens. */
  discardAsked: boolean;
  discardFocusRef: RefObject<FinalFocus>;
  editRef: RefObject<HTMLButtonElement | null>;
  cancelRef: RefObject<HTMLButtonElement | null>;
  saveRef: RefObject<HTMLButtonElement | null>;
  titleRef: RefObject<HTMLInputElement | null>;
  formRef: RefObject<HTMLFormElement | null>;
  diskLineRef: RefObject<HTMLParagraphElement | null>;
  /** The caret follows the "Changed on disk" line to the field below it. */
  diskLineFocusLost: () => void;
  openEditor: () => void;
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
 * The editing state of the task page's title and body: the draft, the write,
 * the discard dialog and the focus each way out lands on. The screen renders
 * from what this returns and holds no state of the editor itself. Leaving the
 * page is the guard's question, not this editor's.
 */
export function useTaskEditing(
  { queryClient, client, tag, id, disk, updated, lineEndRestored, guard }: TaskEditingOptions,
): TaskEditing {
  const editRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const diskLineRef = useRef<HTMLParagraphElement>(null);
  const discardFocusRef = useRef<FinalFocus>(null);
  const focusLater = usePendingFocus();
  const { mutateAsync: write, isPending: saving } = useMutation(taskWriteOptions(queryClient, client, tag));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [start, setStart] = useState<Draft>({ title: "", body: "" });
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const [bodyError, setBodyError] = useState<string | undefined>(undefined);
  const [cancelAsked, setCancelAsked] = useState(false);
  const editRequest = useUiStore((state) => state.editRequest);
  const [answered, setAnswered] = useState<EditRequest | null>(null);
  const unsaved = draft !== null && hasUnsavedText(start, draft);
  const diskChange = useDiskChange({ subject: SUBJECT, start, draft, disk, saving, updated });

  /** The text on disk becomes the draft. The caller moves the caret. */
  function startEditing(): void {
    setStart(disk);
    setDraft(disk);
    setTitleError(undefined);
    setBodyError(undefined);
  }

  function openEditor(): void {
    startEditing();
    focusLater(() => {
      titleRef.current?.focus();
    });
  }

  /** Drops the text and closes both the editor and the dialog that asks about it. */
  function stopEditing(): void {
    setDraft(null);
    setCancelAsked(false);
    setTitleError(undefined);
    setBodyError(undefined);
  }

  /** Cancel and a complete Save both return the page to reading. */
  function closeToReading(afterWrite = false): void {
    stopEditing();
    focusLater(() => {
      editRef.current?.focus();
    }, afterWrite);
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

    closeToReading();
  }

  // No write can be in flight here: Cancel and Esc are the only ways in and both
  // are refused while one runs, and the dialog is modal over the form and the bar.
  function discard(): void {
    // Base UI's own destination is the control that opened the dialog, which
    // this path removes with the editor; the page moves the caret itself.
    discardFocusRef.current = "keep";
    closeToReading();
  }

  async function runSave(): Promise<void> {
    if (draft === null || saving) {
      return;
    }
    if (isBlankTitle(draft.title)) {
      // `Field.Error` is not a live region, so a caret already in the input
      // hears nothing: the correction is spoken for that path alone. Every
      // other path moves focus, and the move reads the correction out itself.
      const inTitle = document.activeElement === titleRef.current;
      setTitleError(BLANK_TITLE);
      titleRef.current?.focus();
      if (inTitle) {
        useNoticeStore.getState().announce(BLANK_TITLE);
      }
      return;
    }
    // A Save that restores the text the editor opened with is what the line on
    // screen promises, so the disk change takes the write past this return.
    if (!diskChange.showing && savesNothing(start, draft, lineEndRestored)) {
      closeToReading();
      return;
    }
    // Cancel and the "Changed on disk" line both leave the page while the write
    // runs, so a caret on either goes to Save, which stays.
    const leaving = [cancelRef.current, diskLineRef.current];
    if (leaving.some((element) => element?.contains(document.activeElement) === true)) {
      saveRef.current?.focus();
    }

    setBodyError(undefined);
    // The wait shows in the Save label alone, which a reader is not told about:
    // a ⌘↩ save keeps the caret in a field, and a name change on a control that
    // does not hold focus is not announced.
    useNoticeStore.getState().announce(savingWords(SUBJECT));
    try {
      await write({
        id,
        writes: [{ id, change: { title: draft.title, body: draft.body } }],
        failure: { title: `${id} was not saved`, line: (error) => pageFailureLine(error) },
      });
    } catch (error) {
      // The failure notice is announced a frame from now. A dialog open over
      // the write closes in this commit, so the focus it returns lands first.
      // eslint-disable-next-line @eslint-react/dom-no-flush-sync -- the close must commit before the next frame
      flushSync(() => {
        setBodyError(bodyCorrection(error));
        keepEditing();
        // The editor still holds its text, so the question the page dialog asks
        // has no answer left.
        guard.keepEditing();
      });
      return;
    }

    guard.landed(SUBJECT);
    closeToReading(true);
    useNoticeStore.getState().announce(savedWords(SUBJECT));
  }

  function save(): void {
    void runSave();
  }

  // A write moves the caret itself before it starts, so this is left with the
  // paths that take the line away with the editor still open.
  function diskLineFocusLost(): void {
    titleRef.current?.focus();
  }

  function reload(): void {
    startEditing();
    titleRef.current?.focus();
  }

  function changeDraft(next: Draft): void {
    setDraft(next);
    if (!isBlankTitle(next.title)) {
      setTitleError(undefined);
    }
    if (next.body !== draft?.body) {
      setBodyError(undefined);
    }
  }

  function onKeyDown(event: ReactKeyboardEvent): void {
    editorKeyDown(event, cancel, formRef);
  }

  // Read during render rather than in an effect, so the first paint of the page
  // already shows the fields. The request is cleared below, once the editor it
  // asked for is open.
  if (editRequest !== null && editRequest !== answered && editRequest.tag === tag && editRequest.id === id) {
    setAnswered(editRequest);
    startEditing();
  }

  useUnsavedEntry(guard, SUBJECT, unsaved ? { removed: false, saving } : null);

  useEffect(() => {
    if (answered !== null) {
      useUiStore.getState().takeEditRequest();
      titleRef.current?.focus();
    }
  }, [answered]);

  return {
    draft,
    saving,
    titleError,
    bodyError,
    diskChange,
    discardAsked: cancelAsked,
    discardFocusRef,
    editRef,
    cancelRef,
    saveRef,
    titleRef,
    formRef,
    diskLineRef,
    diskLineFocusLost,
    openEditor,
    changeDraft,
    cancel,
    save,
    keepEditing,
    discard,
    reload,
    onKeyDown,
  };
}
