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

/** One announcement, a node of its own in the spoken region, so the same words raised a frame apart are heard twice. */
export type Announcement = {
  serial: number;
  words: string;
  /** The timestamp of the animation frame it landed in. */
  frame: number;
};

/**
 * How long a message stays in the spoken region, so no stale words are met
 * later. Long enough for a reader that resolves the region's text only when the
 * message reaches its queue, behind whatever it is already speaking.
 */
const SPOKEN_LIFETIME = 7000;

type NoticeState = {
  /** The newest last. */
  notices: readonly OpenNotice[];
  /** Per key, the content of the notice the reader dismissed last. */
  dismissed: ReadonlyMap<string, NoticeContent>;
  /** What the spoken region holds, the newest last. */
  announced: readonly Announcement[];
  /** Opens or replaces the notice under its key, and announces it. */
  showNotice: (notice: Notice) => void;
  dismissNotice: (key: string) => void;
  closeNotice: (key: string) => void;
  /**
   * Raises the words one animation frame after the call: a live message and a
   * focus move in the same commit compete, and the live message loses.
   * Identical words raised inside one frame are one announcement, so an effect
   * that StrictMode runs twice says its words once.
   */
  announce: (words: string) => void;
};

function noticeSignature({ form, title, line, words }: NoticeContent): string {
  return JSON.stringify([form, title, line ?? null, words]);
}

function sameContent(left: NoticeContent, right: NoticeContent): boolean {
  return noticeSignature(left) === noticeSignature(right);
}

/** The parts as one spoken line, each closed as a sentence so a reader pauses between them. */
export function asSentences(parts: readonly string[]): string {
  return parts.map((part) => (/[.!?…]$/u.test(part) ? part : `${part}.`)).join(" ");
}

/** What the panel says. */
function noticeText({ title, line, words }: NoticeContent): string {
  return asSentences([title, ...(line === undefined ? [] : [line]), ...words]);
}

let lastSerial = 0;

// Not persisted: a reload clears every notice.
export const useNoticeStore = create<NoticeState>((set, get) => ({
  notices: [],
  dismissed: new Map(),
  announced: [],
  showNotice: (notice) => {
    const { notices, dismissed } = get();
    const standing = notices.find(({ key }) => key === notice.key) ?? dismissed.get(notice.key);
    if (standing !== undefined && sameContent(standing, notice)) {
      return;
    }

    set((state) => ({
      notices: [...state.notices.filter(({ key }) => key !== notice.key), { ...notice, serial: ++lastSerial }],
    }));
    get().announce(noticeText(notice));
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
  announce: (words) => {
    requestAnimationFrame((frame) => {
      if (get().announced.some((message) => message.frame === frame && message.words === words)) {
        return;
      }

      const serial = ++lastSerial;
      set((state) => ({ announced: [...state.announced, { serial, words, frame }] }));
      setTimeout(() => {
        set((state) => ({ announced: state.announced.filter((message) => message.serial !== serial) }));
      }, SPOKEN_LIFETIME);
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
