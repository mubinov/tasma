import type { QueryObserverResult } from "@tanstack/react-query";
import { ProtocolError } from "@tasma/protocol";
import { useEffect, useEffectEvent } from "react";
import { failureWords, joinFailureWords } from "../lib/failure-words";
import { useNoticeStore } from "../store/notices";

export type RefusalRead = Pick<QueryObserverResult, "status" | "error" | "dataUpdatedAt">;

export type RefusalNoticeContent = {
  title: string;
  /** The muted line, given the time of the last success of the refused read. */
  line: (readAt: number) => string;
  /** Said when the notice closes because every read succeeds. */
  upToDate: string;
};

/** True when the daemon refused the newest read. Such a read keeps its data. */
export function isRefused({ status, error }: { status: string; error: unknown }): boolean {
  return status === "error" && error instanceof ProtocolError;
}

/**
 * Opens the failure notice under `key` when the daemon refuses one of `reads`,
 * about the first refused read in `reads`: the words of the refusal, and the
 * time of its last success. A failure that is not a refusal leaves the notice
 * as it is. It closes with the `upToDate` line once every read succeeds, and
 * with nothing said on a change of key and on unmount. After Dismiss it stays
 * closed until every read succeeds.
 *
 * Each read has data, so its status is never `"pending"`.
 */
export function useRefusalNotice(key: string, reads: readonly RefusalRead[], content: RefusalNoticeContent): void {
  // Read during render, so the query results notify the component of each read.
  const results = reads.map(({ status, error, dataUpdatedAt }) => ({ status, error, dataUpdatedAt }));

  const sync = useEffectEvent(() => {
    const store = useNoticeStore.getState();
    // Not the newest refusal: reads that are refused together finish in either order.
    const refused = results.find(isRefused);

    if (refused !== undefined) {
      if (!store.dismissed.has(key)) {
        store.showNotice({
          key,
          form: "failure",
          title: content.title,
          line: content.line(refused.dataUpdatedAt),
          words: [joinFailureWords(failureWords(refused.error))],
        });
      }
    } else if (results.every(({ status }) => status === "success") && store.closeNotice(key)) {
      store.announce(content.upToDate);
    }
  });

  useEffect(() => {
    sync();
  });

  useEffect(
    () => () => {
      useNoticeStore.getState().closeNotice(key);
    },
    [key],
  );
}
