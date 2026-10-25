import { useQueryClient, type QueryCache, type QueryKey, type QueryObserverResult } from "@tanstack/react-query";
import { ProtocolError } from "@tasma/protocol";
import { useEffect, useEffectEvent } from "react";
import { failureWords, joinFailureWords } from "../lib/failure-words";
import { useNoticeStore } from "../store/notices";

export type RefusalRead = {
  queryKey: QueryKey;
  /** The result of an observer of the query. */
  result: Pick<QueryObserverResult, "status" | "error" | "errorUpdatedAt">;
};

export type RefusalNoticeContent = {
  title: string;
  /** The muted line, given the earliest time at which a refused read was first refused since it last succeeded. */
  line: (refusedAt: number) => string;
  /** Said when the notice closes because every read succeeds. */
  upToDate: string;
};

/** True when the daemon refused the newest read. Such a read keeps its data. */
export function isRefused({ status, error }: { status: string; error: unknown }): boolean {
  return status === "error" && error instanceof ProtocolError;
}

const firstRefusals = new WeakMap<object, number>();

/**
 * Keeps the time of the first refusal of each query since it last succeeded,
 * also while no screen shows the query. A failure that is not a refusal keeps
 * the time.
 */
export function trackRefusals(cache: QueryCache): void {
  cache.subscribe(({ type, query }) => {
    if (type !== "updated") {
      return;
    }
    if (isRefused(query.state)) {
      if (!firstRefusals.has(query)) {
        firstRefusals.set(query, query.state.errorUpdatedAt);
      }
    } else if (query.state.status !== "error") {
      firstRefusals.delete(query);
    }
  });
}

type RefusalResult = { queryKey: QueryKey; status: string; error: unknown; errorUpdatedAt: number };

function firstRefusalAt(cache: QueryCache, { queryKey, errorUpdatedAt }: RefusalResult): number {
  const query = cache.find({ queryKey, exact: true });
  return (query && firstRefusals.get(query)) ?? errorUpdatedAt;
}

/**
 * Opens the failure notice under `key` when the daemon refuses one of `reads`,
 * with the words of the first refused read in `reads`, and the earliest time
 * at which a refused read was first refused since it last succeeded: a read
 * runs only after a change, so the reads matched the disk until then. A
 * failure that is not a refusal leaves the notice as it is. It closes with the
 * `upToDate` line once every read succeeds, and with nothing said on a change
 * of key and on unmount. After Dismiss it stays closed until every read
 * succeeds.
 *
 * Each read has data, so its status is never `"pending"`.
 */
export function useRefusalNotice(key: string, reads: readonly RefusalRead[], content: RefusalNoticeContent): void {
  const cache = useQueryClient().getQueryCache();
  // Read during render, so the query results notify the component of each read.
  const results = reads.map(({ queryKey, result: { status, error, errorUpdatedAt } }): RefusalResult => ({
    queryKey,
    status,
    error,
    errorUpdatedAt,
  }));

  const sync = useEffectEvent(() => {
    const store = useNoticeStore.getState();
    const refused = results.filter(isRefused);
    // Not the newest refusal: reads that are refused together finish in either order.
    const [first] = refused;

    if (first !== undefined) {
      if (!store.dismissed.has(key)) {
        store.showNotice({
          key,
          form: "failure",
          title: content.title,
          line: content.line(Math.min(...refused.map((read) => firstRefusalAt(cache, read)))),
          words: [joinFailureWords(failureWords(first.error))],
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
