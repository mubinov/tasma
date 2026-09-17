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

type NoticeState = {
  /** The newest last. */
  notices: readonly OpenNotice[];
  /** Per key, the content of the notice the reader dismissed last. */
  dismissed: ReadonlyMap<string, NoticeContent>;
  showNotice: (notice: Notice) => void;
  dismissNotice: (key: string) => void;
  closeNotice: (key: string) => void;
};

function noticeSignature({ form, title, line, words }: NoticeContent): string {
  return JSON.stringify([form, title, line ?? null, words]);
}

function sameContent(left: NoticeContent, right: NoticeContent): boolean {
  return noticeSignature(left) === noticeSignature(right);
}

let lastSerial = 0;

// Not persisted: a reload clears every notice.
export const useNoticeStore = create<NoticeState>((set) => ({
  notices: [],
  dismissed: new Map(),
  showNotice: (notice) => {
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
      const open = state.notices.find((notice) => notice.key === key);
      if (open === undefined) {
        return state;
      }

      const { form, title, line, words } = open;
      return {
        notices: state.notices.filter((notice) => notice !== open),
        dismissed: new Map(state.dismissed).set(key, { form, title, line, words }),
      };
    });
  },
  closeNotice: (key) => {
    set((state) => {
      if (!state.dismissed.has(key) && !state.notices.some((notice) => notice.key === key)) {
        return state;
      }

      const dismissed = new Map(state.dismissed);
      dismissed.delete(key);
      return { notices: state.notices.filter((notice) => notice.key !== key), dismissed };
    });
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
