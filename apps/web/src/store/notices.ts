import type { Diagnostic } from "@tasma/protocol";
import { useEffect, useEffectEvent } from "react";
import { create } from "zustand";

export type NoticeContent = {
  /** A warning lists findings; a failure says what did not happen. */
  form: "warning" | "failure";
  title: string;
  /** The muted line under the title. */
  line?: string;
  words: readonly string[];
};

export type Notice = NoticeContent & {
  /** One notice per key, e.g. "task-read:<task id>". */
  key: string;
};

export type OpenNotice = Notice & {
  /** New each time the notice opens or its content changes, also for content equal to the notice it follows. */
  serial: number;
};

/** One thing the application said, a node of its own so equal words said twice are announced twice. */
export type SpokenMessage = { serial: number; words: string };

/**
 * What a modal dialog holds back, in the order it was raised. A message carries
 * a key only where its raiser may need to withdraw it: words held behind a
 * dialog outlive the screen state that raised them.
 */
type Held = { key: string | undefined } & (
  | { kind: "notice"; notice: Notice }
  | { kind: "message"; words: string }
);

/**
 * How long a message stays in the spoken region, so no stale words are met
 * later. Long enough for a reader that resolves the region's text only when the
 * message reaches its queue, behind whatever it is already speaking.
 */
const SPOKEN_LIFETIME = 3000;

type NoticeState = {
  /** The newest last. */
  notices: readonly OpenNotice[];
  /** Per key, the content of the notice the reader dismissed last. */
  dismissed: ReadonlyMap<string, NoticeContent>;
  /** What the spoken region holds, the newest last. */
  spoken: readonly SpokenMessage[];
  /**
   * Open modal dialogs. It lives beside the notices because a notice raised
   * while one is up is unreachable, not merely covered: Base UI puts
   * `aria-hidden` on everything outside the popup. A count rather than a flag,
   * since dialogs nest and a flag owned by two breaks on the first close.
   */
  modalDialogs: number;
  /** Raised while a dialog is open, opened in this order when the last one closes. */
  held: readonly Held[];
  showNotice: (notice: Notice) => void;
  dismissNotice: (key: string) => void;
  closeNotice: (key: string) => void;
  say: (words: string, key?: string) => void;
  /** Drops a keyed message a dialog still holds. Words already spoken stand. */
  unsay: (key: string) => void;
  openModalDialog: () => void;
  closeModalDialog: () => void;
};

function noticeSignature({ form, title, line, words }: NoticeContent): string {
  return JSON.stringify([form, title, line ?? null, words]);
}

function sameContent(left: NoticeContent, right: NoticeContent): boolean {
  return noticeSignature(left) === noticeSignature(right);
}

function without(held: readonly Held[], kind: Held["kind"], key: string): readonly Held[] {
  return held.filter((item) => item.kind !== kind || item.key !== key);
}

let lastSerial = 0;

// Not persisted: a reload clears every notice.
export const useNoticeStore = create<NoticeState>((set, get) => ({
  notices: [],
  dismissed: new Map(),
  spoken: [],
  modalDialogs: 0,
  held: [],
  showNotice: (notice) => {
    if (get().modalDialogs > 0) {
      set((state) => ({
        held: [...without(state.held, "notice", notice.key), { kind: "notice", key: notice.key, notice }],
      }));
      return;
    }

    set((state) => {
      const open = state.notices.find(({ key }) => key === notice.key);
      if (open !== undefined) {
        return sameContent(open, notice)
          ? state
          : { notices: [...state.notices.filter((item) => item !== open), { ...notice, serial: ++lastSerial }] };
      }

      const dismissed = state.dismissed.get(notice.key);
      if (dismissed !== undefined && sameContent(dismissed, notice)) {
        return state;
      }

      return { notices: [...state.notices, { ...notice, serial: ++lastSerial }] };
    });
  },
  dismissNotice: (key) => {
    set((state) => {
      const held = without(state.held, "notice", key);
      const open = state.notices.find((notice) => notice.key === key);
      if (open === undefined) {
        return held.length === state.held.length ? state : { held };
      }

      const { form, title, line, words } = open;
      return {
        notices: state.notices.filter((notice) => notice !== open),
        dismissed: new Map(state.dismissed).set(key, { form, title, line, words }),
        held,
      };
    });
  },
  closeNotice: (key) => {
    set((state) => {
      const held = without(state.held, "notice", key);
      const known = state.dismissed.has(key) || state.notices.some((notice) => notice.key === key);
      if (!known) {
        return held.length === state.held.length ? state : { held };
      }

      const dismissed = new Map(state.dismissed);
      dismissed.delete(key);
      return { notices: state.notices.filter((notice) => notice.key !== key), dismissed, held };
    });
  },
  say: (words, key) => {
    if (get().modalDialogs > 0) {
      set((state) => ({
        held: [
          ...(key === undefined ? state.held : without(state.held, "message", key)),
          { kind: "message", key, words },
        ],
      }));
      return;
    }

    const serial = ++lastSerial;
    set((state) => ({ spoken: [...state.spoken, { serial, words }] }));
    setTimeout(() => {
      set((state) => ({ spoken: state.spoken.filter((message) => message.serial !== serial) }));
    }, SPOKEN_LIFETIME);
  },
  unsay: (key) => {
    set((state) => {
      const held = without(state.held, "message", key);

      return held.length === state.held.length ? state : { held };
    });
  },
  openModalDialog: () => {
    set((state) => ({ modalDialogs: state.modalDialogs + 1 }));
  },
  closeModalDialog: () => {
    const state = get();
    // Floored: one unmatched close would otherwise leave the count negative,
    // which reads as "no dialog is open" for the rest of the session.
    const modalDialogs = Math.max(0, state.modalDialogs - 1);
    const released = modalDialogs === 0 ? state.held : [];
    set({ modalDialogs, held: modalDialogs === 0 ? [] : state.held });

    for (const item of released) {
      if (item.kind === "notice") {
        get().showNotice(item.notice);
      } else {
        get().say(item.words);
      }
    }
  },
}));

export function noticeWords(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map(({ code, message }) => `${code} · ${message}`);
}

/**
 * Keeps the notice under `key` in step with what a screen renders: `null` closes
 * it, and so does unmount or a change of key.
 */
export function useNotice(key: string, content: NoticeContent | null): void {
  // A screen builds the content on each render, so the object is new every time.
  const contentSignature = content === null ? null : noticeSignature(content);

  const sync = useEffectEvent(() => {
    if (content === null) {
      useNoticeStore.getState().closeNotice(key);
    } else {
      useNoticeStore.getState().showNotice({ ...content, key });
    }
  });

  useEffect(() => {
    sync();
  }, [key, contentSignature]);

  useEffect(
    () => () => {
      useNoticeStore.getState().closeNotice(key);
    },
    [key],
  );
}

/**
 * Keeps the count of open modal dialogs in step with what a dialog renders. The
 * cleanup counts out a dialog unmounted while still open as well as one that
 * closes.
 */
export function useModalDialog(open: boolean): void {
  useEffect(() => {
    if (!open) {
      return;
    }

    useNoticeStore.getState().openModalDialog();

    return () => {
      useNoticeStore.getState().closeModalDialog();
    };
  }, [open]);
}
