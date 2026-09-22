import { useMutation, type QueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import type { Client } from "@tasma/protocol";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { bodyCorrection, taskWriteOptions } from "../api/mutations";
import type { FinalFocus } from "./final-focus";
import { useNoticeStore } from "../store/notices";
import { useUiStore, type EditRequest } from "../store/ui";
import { BLANK_TITLE, hasUnsavedText, isBlankTitle, savesNothing, type Draft } from "./text-draft";
import { useDiskChange, type DiskChange } from "./use-disk-change";

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
  hasComments: boolean;
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
  /** Whether the discard dialog is up, for Cancel and for a held route change alike. */
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
 * The editing state of the task page: the draft, the write, the guard on
 * leaving with unsaved text, the discard dialog and the focus each way out
 * lands on. The screen renders from what this returns and holds no state of the
 * editor itself.
 */
export function useTaskEditing(
  { queryClient, client, tag, id, disk, updated, hasComments }: TaskEditingOptions,
): TaskEditing {
  const editRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const diskLineRef = useRef<HTMLParagraphElement>(null);
  const discardFocusRef = useRef<FinalFocus>(null);
  const pendingFocusRef = useRef<"title" | "edit" | null>(null);
  const { mutateAsync: write, isPending: saving } = useMutation(taskWriteOptions(queryClient, client, tag));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [start, setStart] = useState<Draft>({ title: "", body: "" });
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const [bodyError, setBodyError] = useState<string | undefined>(undefined);
  const [cancelAsked, setCancelAsked] = useState(false);
  const editRequest = useUiStore((state) => state.editRequest);
  const [answered, setAnswered] = useState<EditRequest | null>(null);
  const unsaved = draft !== null && hasUnsavedText(start, draft);
  const diskChange = useDiskChange({ start, draft, disk, saving, updated });
  const blocker = useBlocker({
    shouldBlockFn: () => true,
    enableBeforeUnload: true,
    disabled: !unsaved,
    withResolver: true,
  });
  // The resolver is new on every render, and an answer that lands after the
  // render that started it needs the live one.
  const blockerRef = useRef(blocker);
  // The blocker reports an answer only a render later; the dialog closes on the answer itself.
  const [answeredBlock, setAnsweredBlock] = useState<typeof blocker | null>(null);

  /** The text on disk becomes the draft. The caller moves the caret. */
  function startEditing(): void {
    setStart(disk);
    setDraft(disk);
    setTitleError(undefined);
    setBodyError(undefined);
  }

  function openEditor(): void {
    startEditing();
    pendingFocusRef.current = "title";
  }

  /** Drops the text and closes both the editor and the dialog that asks about it. */
  function stopEditing(): void {
    setDraft(null);
    setCancelAsked(false);
    setTitleError(undefined);
    setBodyError(undefined);
  }

  /**
   * Cancel and a complete Save both return the page to reading. A route change
   * held behind the dialog runs instead of the focus move: the text is no
   * longer unsaved, so the question the dialog asks has no answer left.
   */
  function closeToReading(): void {
    stopEditing();

    if (blockerRef.current.status === "blocked") {
      discardFocusRef.current = "keep";
      blockerRef.current.proceed?.();
      return;
    }

    pendingFocusRef.current = "edit";
  }

  function keepEditing(): void {
    // Base UI then falls back to the element that had focus when it opened.
    discardFocusRef.current = null;
    setCancelAsked(false);
    setAnsweredBlock(blockerRef.current);
    blockerRef.current.reset?.();
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

  function discard(): void {
    // The write is about to land the very text this would drop, so Discard
    // waits for it as Cancel does. The dialog names the wait.
    if (saving) {
      return;
    }

    // Base UI's own destination is the control that opened the dialog, which on
    // a route change leaves with the screen; the page moves the caret itself.
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
    if (!diskChange.showing && savesNothing(start, draft, hasComments)) {
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
    useNoticeStore.getState().announce("Saving…");
    try {
      await write({
        id,
        writes: [{ id, change: { title: draft.title, body: draft.body } }],
        title: `${id} was not saved`,
        place: "task page",
      });
    } catch (error) {
      // The failure notice is announced a frame from now. A dialog open over
      // the write closes in this commit, so the focus it returns lands first.
      // eslint-disable-next-line @eslint-react/dom-no-flush-sync -- the close must commit before the next frame
      flushSync(() => {
        setBodyError(bodyCorrection(error));
        keepEditing();
      });
      return;
    }

    closeToReading();
    useNoticeStore.getState().announce("Saved.");
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
    if (event.key === "Escape") {
      event.preventDefault();
      // React flushes a discrete key synchronously, so the dialog this opens
      // mounts and attaches its dismissal listener above the React root while
      // the same keypress is still propagating there. Left to travel, that
      // keypress closes the dialog it has just opened.
      event.nativeEvent.stopPropagation();
      cancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  // Read during render rather than in an effect, so the first paint of the page
  // already shows the fields. The request is cleared below, once the editor it
  // asked for is open.
  if (editRequest !== null && editRequest !== answered && editRequest.tag === tag && editRequest.id === id) {
    setAnswered(editRequest);
    startEditing();
  }

  useEffect(() => {
    if (answered !== null) {
      useUiStore.getState().takeEditRequest();
      titleRef.current?.focus();
    }
  }, [answered]);

  useEffect(() => {
    blockerRef.current = blocker;
  });

  useLayoutEffect(() => {
    const target = pendingFocusRef.current;
    if (target === null) {
      return;
    }

    pendingFocusRef.current = null;
    (target === "title" ? titleRef.current : editRef.current)?.focus();
  });

  return {
    draft,
    saving,
    titleError,
    bodyError,
    diskChange,
    discardAsked: cancelAsked || (blocker.status === "blocked" && blocker !== answeredBlock),
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
