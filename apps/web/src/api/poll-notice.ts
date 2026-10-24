import type { QueryObserverResult } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef } from "react";
import { failureWords, joinFailureWords } from "../lib/failure-words";
import { useNoticeStore } from "../store/notices";

export type PollRead = Pick<QueryObserverResult, "dataUpdatedAt" | "errorUpdateCount" | "errorUpdatedAt" | "error">;

/** A read and the name its count is kept under, which stays the same while reads join or leave the list. */
export type NamedPollRead = { name: string; read: PollRead };

export type PollNoticeContent = {
  title: string;
  /** The muted line, given the time of the last success of the read the words are about. */
  line: (readAt: number) => string;
};

type PollCount = { dataUpdatedAt: number; errorUpdateCount: number; failuresInRow: number };

const FAILED_POLLS = 2;

/** The count of a read at this render, from the count seen at the render before. */
function nextCount(poll: PollRead, seen: PollCount | undefined): PollCount {
  const { dataUpdatedAt, errorUpdateCount, errorUpdatedAt } = poll;

  if (seen === undefined) {
    return { dataUpdatedAt, errorUpdateCount, failuresInRow: 0 };
  }
  if (dataUpdatedAt === seen.dataUpdatedAt) {
    const failuresInRow = seen.failuresInRow + errorUpdateCount - seen.errorUpdateCount;
    return { dataUpdatedAt, errorUpdateCount, failuresInRow };
  }

  // Polls run seconds apart, so a success and a failure between two renders
  // leave the newer of the two as the only one known to be in a row.
  return { dataUpdatedAt, errorUpdateCount, failuresInRow: Number(errorUpdatedAt > dataUpdatedAt) };
}

/**
 * Opens the failure notice under `key` once one of `reads` has failed two polls
 * in a row, about the first such read in `reads`: the words of its last error,
 * and the time of its last success. It closes when no read is failing that way,
 * on a change of key and on unmount. After Dismiss it stays closed until a poll
 * succeeds.
 *
 * A read that leaves `reads` drops its count, and counts from zero when it
 * comes back.
 */
export function usePollNotice(key: string, reads: readonly NamedPollRead[], content: PollNoticeContent): void {
  // Read during render, so the query results notify the component of each poll.
  const polls = reads.map(({ name, read: { dataUpdatedAt, errorUpdateCount, errorUpdatedAt, error } }) => ({
    name,
    dataUpdatedAt,
    errorUpdateCount,
    errorUpdatedAt,
    error,
  }));
  const countsRef = useRef<{ key: string; counts: ReadonlyMap<string, PollCount> } | null>(null);

  const sync = useEffectEvent(() => {
    const previous = countsRef.current?.key === key ? countsRef.current.counts : new Map<string, PollCount>();
    const tracked = polls.map((poll) => ({ poll, count: nextCount(poll, previous.get(poll.name)) }));
    countsRef.current = { key, counts: new Map(tracked.map(({ poll, count }) => [poll.name, count])) };

    // Not the newest error: reads that fail together finish in either order, and
    // words that change on every poll would replace the notice on every poll.
    const failing = tracked.find(({ count }) => count.failuresInRow >= FAILED_POLLS)?.poll;
    const store = useNoticeStore.getState();

    if (failing === undefined) {
      store.closeNotice(key);
    } else if (!store.dismissed.has(key)) {
      store.showNotice({
        key,
        form: "failure",
        title: content.title,
        line: content.line(failing.dataUpdatedAt),
        words: [joinFailureWords(failureWords(failing.error))],
      });
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
