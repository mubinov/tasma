import { useInfiniteQuery } from "@tanstack/react-query";
import type { Client, ProjectSummary } from "@tasma/protocol";
import { useState } from "react";
import { chatListQuery, type ChatFilter } from "../api/queries";

export const FILTER_FAILURE_TEXT = "The chats cannot be loaded. The list shows the last result.";

/** The filter of the address: a project of the list, and a search with words. */
export function chatFilterOf({ project, q }: ChatFilter, projects: readonly ProjectSummary[]): ChatFilter {
  const text = q?.trim() ?? "";

  return {
    ...(project !== undefined && projects.some(({ tag }) => tag === project) ? { project } : {}),
    ...(text === "" ? {} : { q: text }),
  };
}

export function sameFilter(one: ChatFilter, other: ChatFilter): boolean {
  return one.project === other.project && one.q === other.q;
}

export function filterKey({ project, q }: ChatFilter): string {
  return JSON.stringify([project ?? null, q ?? null]);
}

/** The fields where the requested filter and the applied one differ. */
export type FailedFields = { search: boolean; project: boolean };

export type ChatFilterState = {
  /** The filter of the address. */
  requested: ChatFilter;
  /** The filter of the list on the screen. Its first page is in the cache. */
  applied: ChatFilter;
  /** The reads of `requested` that failed since it became the filter of the address, while it is not applied. */
  failures: number;
  /** The last failed read is one to announce: the first one, or one that `retry` started. */
  announceFailure: boolean;
  failed: boolean;
  failedFields: FailedFields;
  /** Reads `requested` again. */
  retry: () => void;
};

type ErrorBase = {
  key: string;
  /** The error count of the read when `key` became the filter of the address. */
  count: number;
  /** The failures when `retry` was last called for `key`. */
  retried: number | null;
};

/** The filter of the address, and the filter of the list, which changes when the first page of the new one comes. */
export function useChatFilter(
  client: Client,
  search: ChatFilter,
  projects: readonly ProjectSummary[],
): ChatFilterState {
  const requested = chatFilterOf(search, projects);
  const [applied, setApplied] = useState(requested);
  const pending = !sameFilter(requested, applied);
  const read = useInfiniteQuery({ ...chatListQuery(client, requested), enabled: pending });
  const key = filterKey(requested);
  // A refetch of a key with no data sets its status back to pending and drops
  // its error, so a failure is read from the error count, which the cache keeps
  // after the filter changes too.
  const [errorBase, setErrorBase] = useState<ErrorBase>({ key, count: read.errorUpdateCount, retried: null });
  const baseIsCurrent = errorBase.key === key;

  if (!baseIsCurrent) {
    setErrorBase({ key, count: read.errorUpdateCount, retried: null });
  }
  if (pending && read.data !== undefined) {
    setApplied(requested);
  }

  const failures = pending && read.data === undefined && baseIsCurrent ? read.errorUpdateCount - errorBase.count : 0;

  return {
    requested,
    applied,
    failures,
    announceFailure: failures === 1 || (errorBase.retried !== null && failures === errorBase.retried + 1),
    failed: failures > 0,
    failedFields: { search: requested.q !== applied.q, project: requested.project !== applied.project },
    retry: () => {
      setErrorBase({ ...errorBase, retried: failures });
      void read.refetch();
    },
  };
}
