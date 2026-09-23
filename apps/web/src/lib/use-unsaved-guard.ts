import { useBlocker } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { useNoticeStore } from "../store/notices";
import { useUiStore } from "../store/ui";
import type { FinalFocus } from "./final-focus";
import { editorKey, type EditorSubject } from "./editor-subject";
import { savedStatus, unsavedDescription, type UnsavedEditor } from "./unsaved-words";
import { usePendingFocus } from "./use-pending-focus";

/** What the guard holds of an editor beside its subject. */
type EditorState = Omit<UnsavedEditor, "subject"> & {
  /** Its own write is in flight, so Discard must not drop the text on its way to disk. */
  saving: boolean;
};

/** One editor as the page-level guard holds it. */
type RegisteredEditor = UnsavedEditor & EditorState;

/** What the dialog says while a write it must wait for is running. */
const SAVING_WAIT = "Saving…";

export type UnsavedGuard = {
  /** Keeps an editor registered while it holds unsaved text; `null` takes it out. */
  register: (subject: EditorSubject, state: EditorState | null) => void;
  /**
   * Answers the dialog the way Keep editing does, and drops the route change.
   * With no dialog open it does nothing, so a refused save keeps the caret in its field.
   */
  keepEditing: () => void;
  /**
   * An editor's save landed. Where nothing else is unsaved, the route change the
   * dialog holds runs at once: the blocker drops its resolver as soon as the
   * registry empties it, so the answer cannot wait for an effect.
   */
  landed: (subject: EditorSubject) => void;
  asked: boolean;
  /** Names every editor that is unsaved, so Keep editing gives the reader somewhere to go. */
  description: string;
  /** The wait, and then what a save that landed behind the dialog did. Visible text alone. */
  status: string | undefined;
  finalFocusRef: RefObject<FinalFocus>;
  discard: () => void;
};

/**
 * The one guard on leaving the task page with unsaved text. Every editor of the
 * page registers here — the task text, a comment card, the add form — so the
 * route change is blocked once, and the dialog asks about all of them together.
 * An editor's own Cancel keeps its own dialog: that question is about one
 * editor, this one is about the page.
 */
export function useUnsavedGuard(): UnsavedGuard {
  const [editors, setEditors] = useState<ReadonlyMap<string, RegisteredEditor>>(() => new Map());
  const [previousEditors, setPreviousEditors] = useState<ReadonlyMap<string, RegisteredEditor>>(() => new Map());
  const [lastSaved, setLastSaved] = useState<EditorSubject | null>(null);
  const finalFocusRef = useRef<FinalFocus>(null);
  // Where the caret stood as the dialog opened, which Keep editing returns to.
  const openerRef = useRef<Element | null>(null);
  const focusLater = usePendingFocus();
  // A save answers the dialog from a continuation rather than a render, so it
  // needs the registry as it stands then, not as the render that sent it read it.
  const editorsRef = useRef<ReadonlyMap<string, RegisteredEditor>>(editors);
  const blocker = useBlocker({
    shouldBlockFn: () => {
      openerRef.current = document.activeElement;
      return true;
    },
    enableBeforeUnload: true,
    disabled: editors.size === 0,
    withResolver: true,
  });
  // The resolver is new on every render, and an answer that lands after the
  // render that started it needs the live one.
  const blockerRef = useRef(blocker);
  // The blocker reports an answer only a render later; the dialog closes on the answer itself.
  const [answeredBlock, setAnsweredBlock] = useState<typeof blocker | null>(null);
  const asked = blocker.status === "blocked" && blocker !== answeredBlock;
  const list = [...editors.values()];
  const saving = list.some((editor) => editor.saving);

  function register(subject: EditorSubject, state: EditorState | null): void {
    const key = editorKey(subject);

    setEditors((current) => {
      if (state === null) {
        if (!current.has(key)) {
          return current;
        }

        const next = new Map(current);
        next.delete(key);
        return next;
      }

      return new Map(current).set(key, { subject, ...state });
    });
  }

  /** The dialog closes, so the next one it opens says nothing about a save this one saw land. */
  function answer(): void {
    openerRef.current = null;
    setAnsweredBlock(blockerRef.current);
    setLastSaved(null);
  }

  function keepEditing(): void {
    if (blockerRef.current.status !== "blocked") {
      return;
    }

    const dropped = useUiStore.getState().takeDroppedFocus();
    if (openerRef.current?.isConnected === false) {
      // The element the dialog opened from has gone: the caret goes where a save
      // that closed its editor behind the dialog would have put it, or to the main region.
      finalFocusRef.current = "keep";
      focusLater(() => {
        // Still on the closing dialog's control where no move took the caret.
        const before = document.activeElement;
        dropped?.();
        if (document.activeElement === before) {
          document.querySelector<HTMLElement>("main")?.focus();
        }
      });
    } else {
      // Base UI then falls back to the element that had focus when it opened.
      finalFocusRef.current = null;
    }
    answer();
    blockerRef.current.reset?.();
  }

  /** Lets the held route change run, with the caret left to the screen it opens. */
  function proceed(): void {
    finalFocusRef.current = "keep";
    useUiStore.getState().takeDroppedFocus();
    answer();
    blockerRef.current.proceed?.();
  }

  function landed(subject: EditorSubject): void {
    const key = editorKey(subject);
    const rest = [...editorsRef.current.keys()].filter((open) => open !== key);
    if (blockerRef.current.status === "blocked" && rest.length === 0) {
      proceed();
    }
  }

  /**
   * The route change runs and takes every editor's text with it, the page
   * unmounting with it. Nothing drops the text on its own: every navigation this
   * guard can block leaves the task page.
   */
  function discard(): void {
    // A write is about to land the very text this would drop, so Discard waits
    // for it. The status shows the wait, and is read on entry alone, so the wait
    // is spoken as well.
    if (saving) {
      useNoticeStore.getState().announce(SAVING_WAIT);
      return;
    }

    proceed();
  }

  // Adjusted during render rather than in an effect, so the dialog never shows a
  // sentence about an editor that has already finished. While the dialog stands
  // open the only way a key leaves is a save that landed: a refusal and a
  // comment removed on disk both keep their text.
  if (previousEditors !== editors) {
    setPreviousEditors(editors);
    if (asked) {
      const saved = [...previousEditors].filter(([key]) => !editors.has(key)).map(([, editor]) => editor.subject);
      if (saved.length > 0) {
        setLastSaved(saved[saved.length - 1]!);
      }
    } else {
      setLastSaved(null);
    }
  }

  useEffect(() => {
    blockerRef.current = blocker;
    editorsRef.current = editors;
  });

  return {
    register,
    keepEditing,
    landed,
    asked,
    description: unsavedDescription(list) ?? "",
    status: saving ? SAVING_WAIT : lastSaved === null ? undefined : savedStatus(lastSaved, list),
    finalFocusRef,
    discard,
  };
}

/** Keeps one editor in the page's registry while it holds unsaved text. */
export function useUnsavedEntry(guard: UnsavedGuard, subject: EditorSubject, state: EditorState | null): void {
  const key = editorKey(subject);
  const signature = state === null ? null : JSON.stringify([state.removed, state.saving]);
  const sync = useEffectEvent(() => {
    guard.register(subject, state);
  });
  // Held in a ref rather than reached through `useEffectEvent`, which is not
  // callable once the editor has unmounted — and unmount is how a card that
  // saved, or a page that closed, leaves the registry.
  const entryRef = useRef({ register: guard.register, subject });

  useEffect(() => {
    entryRef.current = { register: guard.register, subject };
  });

  useEffect(() => {
    sync();
  }, [key, signature]);

  useEffect(
    () => () => {
      const { register, subject: registered } = entryRef.current;
      register(registered, null);
    },
    [key],
  );
}
