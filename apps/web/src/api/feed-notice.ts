import { TransportError } from "@tasma/protocol";
import { failureWords, joinFailureWords } from "../lib/failure-words";
import { noticeText, useNoticeStore, type Notice } from "../store/notices";

export const FEED_NOTICE_KEY = "feed";

const FAILED_READS = 3;

const RECOVERED = "Tasma gets changes again.";

export type FeedNotice = {
  /** A read of the feed rejected. Comes before the `status` of the same read. */
  failed: (error: unknown) => void;
  /** The count `onStatus` of the long poll reports. */
  status: (failures: number) => void;
  stop: () => void;
};

/** The reader is in the window, so a spoken line reaches them. */
function attended(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function feedWords(firstFailure: { error: unknown } | null): string[] {
  if (firstFailure === null) {
    return [];
  }

  const words = failureWords(firstFailure.error);
  // The query holds the cursor, a run id and a number, which a reader would say aloud.
  return [joinFailureWords(firstFailure.error instanceof TransportError
    ? { ...words, message: words.message.replace(/\?\S*/u, "") }
    : words)];
}

function shownFeedNotice(): Notice | undefined {
  return useNoticeStore.getState().notices.find(({ key }) => key === FEED_NOTICE_KEY);
}

/**
 * The one notice of the app for a change feed that fails: it opens after
 * `FAILED_READS` failed reads in a row, with the words of the first, and closes
 * with a spoken line when a read succeeds again. Its content stays the same
 * while the reads fail, so the store neither opens nor says it again.
 *
 * The last line it said while the reader was away from the window is said once
 * more when they come back, if it is still true, after the lines the store held
 * while the page was hidden.
 */
export function createFeedNotice(): FeedNotice {
  let firstFailure: { error: unknown } | null = null;
  // Fixed when the notice of the row opens, so a rejection after a handler threw does not change them.
  let words: string[] | null = null;
  // The last line said, if the reader was away when it was said.
  let unheard: "notice" | "recovery" | null = null;
  let repeat = 0;

  function said(line: "notice" | "recovery"): void {
    unheard = attended() ? null : line;
  }

  function comeBack(): void {
    if (!attended() || unheard === null) {
      return;
    }

    const line = unheard;
    unheard = null;
    cancelAnimationFrame(repeat);
    // A hidden page runs no animation frames, so the lines raised while it was
    // hidden land in the first frame after the return, where the store keeps one
    // of identical words. One frame later, the repeat is the last line heard.
    repeat = requestAnimationFrame(() => {
      const store = useNoticeStore.getState();
      const notice = shownFeedNotice();
      if (line === "notice" && notice !== undefined) {
        store.announce(noticeText(notice));
      } else if (line === "recovery" && notice === undefined && !store.dismissed.has(FEED_NOTICE_KEY)) {
        store.announce(RECOVERED);
      }
    });
  }

  document.addEventListener("visibilitychange", comeBack);
  window.addEventListener("focus", comeBack);

  return {
    failed: (error) => {
      firstFailure ??= { error };
    },
    status: (failures) => {
      const store = useNoticeStore.getState();

      if (failures === 0) {
        firstFailure = null;
        words = null;
        if (store.closeNotice(FEED_NOTICE_KEY)) {
          store.announce(RECOVERED);
          said("recovery");
        }
      } else if (failures >= FAILED_READS && !store.dismissed.has(FEED_NOTICE_KEY)) {
        words ??= feedWords(firstFailure);
        const opened = store.showNotice({
          key: FEED_NOTICE_KEY,
          form: "failure",
          title: "Tasma does not get changes",
          line: "The pages can show old data. Tasma tries again.",
          words,
        });

        if (opened) {
          said("notice");
        }
      }
    },
    stop: () => {
      document.removeEventListener("visibilitychange", comeBack);
      window.removeEventListener("focus", comeBack);
      cancelAnimationFrame(repeat);
      unheard = null;
      useNoticeStore.getState().closeNotice(FEED_NOTICE_KEY);
    },
  };
}
