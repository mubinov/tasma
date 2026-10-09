import { useQuery } from "@tanstack/react-query";
import type { Client, Success, TaskList } from "@tasma/protocol";
import { useDeferredValue, useEffect, useState } from "react";
import { POLL_INTERVAL, taskSearchQuery } from "../api/queries";

/** How long a search request runs before the live region says that it runs, in ms. */
export const BUSY_ANNOUNCE_DELAY = 1000;

/** A search result, and the trimmed text it answers. */
export type SearchResult = { text: string; read: Success<TaskList> };

export type BoardSearch = {
  /** The trimmed `q`: the text the board asks the daemon for. */
  searchText: string;
  /** `q` has words, so the board asks for a search. */
  searchRequested: boolean;
  /** The request for `searchText` runs, and the board has no result for it yet. */
  busy: boolean;
  /** The search for `searchText` failed while it was the board's text, and has no result. */
  failed: boolean;
  /** The text the busy sentence names, deferred with `applied`; `null` while the region says no busy sentence. */
  searching: string | null;
  /** The result the rendered columns apply, `null` while they apply none. */
  applied: SearchResult | null;
  /** The ids of `applied`, `null` while every card shows. */
  ids: ReadonlySet<string> | null;
  /** The columns use what the board has for `q`: its result, or every card. */
  settled: boolean;
};

export function idsOf(read: Success<TaskList> | undefined): ReadonlySet<string> | null {
  return read === undefined ? null : new Set(read.data.entries.map(({ id }) => id));
}

/** The board's search read for `q`, and the result its columns apply. */
export function useBoardSearch(client: Client, tag: string, q: string | undefined): BoardSearch {
  // The daemon splits `q` on whitespace, so a blank text is no search here either.
  const searchText = q?.trim() ?? "";
  const searchRequested = searchText !== "";
  // Not under Suspense: each new text is a new key. No `placeholderData`: it is
  // the data of the last query that had any, not of the previous text.
  const searchRead = useQuery({
    ...taskSearchQuery(client, tag, searchText),
    enabled: searchRequested,
    refetchInterval: POLL_INTERVAL,
  });
  // A refetch of a key with no data sets its status back to pending and drops
  // its error, so a failure is read from the error count, which a refetch
  // keeps. The cache keeps the count after the board leaves the text too, so
  // only the failures since the text became the board's count.
  const [errorBase, setErrorBase] = useState({ tag, searchText, count: searchRead.errorUpdateCount });
  const baseIsCurrent = errorBase.tag === tag && errorBase.searchText === searchText;

  if (!baseIsCurrent) {
    setErrorBase({ tag, searchText, count: searchRead.errorUpdateCount });
  }

  const errorsBefore = baseIsCurrent ? errorBase.count : searchRead.errorUpdateCount;
  const failed = searchRequested && searchRead.data === undefined && searchRead.errorUpdateCount > errorsBefore;
  const busy = searchRequested && searchRead.data === undefined && !failed;
  // The current text's result, else, while its request runs, the one shown
  // before. Adjusted during render: an effect would leave one render on the
  // ids of a dropped result.
  const [shown, setShown] = useState<SearchResult & { tag: string } | null>(null);
  let nextShown: SearchResult | null = null;

  if (searchRequested && searchRead.data !== undefined) {
    nextShown = { text: searchText, read: searchRead.data };
  } else if (busy && shown?.tag === tag) {
    nextShown = shown;
  }
  if ((shown?.read ?? null) !== (nextShown?.read ?? null)) {
    setShown(nextShown === null ? null : { ...nextShown, tag });
  }

  const applied = useDeferredValue(shown);
  const settled = searchRequested
    ? (applied !== null && applied.read === searchRead.data) || (failed && applied === null)
    : applied === null;
  // The wait that has lasted BUSY_ANNOUNCE_DELAY. A new text restarts the timer
  // and keeps the mark, so the region keeps the earlier sentence until the new
  // text has also run for BUSY_ANNOUNCE_DELAY.
  const [mark, setMark] = useState<{ tag: string; text: string } | null>(null);

  if (mark !== null && (!busy || mark.tag !== tag)) {
    setMark(null);
  }

  useEffect(() => {
    if (!busy) {
      return;
    }

    const timer = setTimeout(() => {
      setMark({ tag, text: searchText });
    }, BUSY_ANNOUNCE_DELAY);

    return () => {
      clearTimeout(timer);
    };
  }, [busy, tag, searchText]);

  const announced = busy && mark !== null && mark.tag === tag ? mark.text : null;
  // Deferred with `applied`, so the region never says a result older than the busy sentence.
  const searching = useDeferredValue(announced);

  return { searchText, searchRequested, busy, failed, searching, applied, ids: idsOf(applied?.read), settled };
}
