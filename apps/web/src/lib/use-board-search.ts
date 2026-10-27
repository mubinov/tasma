import { useQueries, type QueryClient } from "@tanstack/react-query";
import type { Client, Success, TaskList } from "@tasma/protocol";
import { useDeferredValue, useEffect, useState } from "react";
import { taskSearchQuery } from "../api/queries";

/** How long a search request runs before the live region says that it runs, in ms. */
export const BUSY_ANNOUNCE_DELAY = 1000;

/** A search result: the trimmed text it answers, and the result of each project, in board order. */
export type SearchResult = { text: string; reads: readonly Success<TaskList>[] };

/** The result the board shows, and the board value it was shown for. */
type ShownResult = SearchResult & { board: string };

export type BoardSearch = {
  /** The trimmed `q`: the text the board asks the daemon for. */
  searchText: string;
  /** The search of one or more projects for `searchText` runs, and has no result yet. */
  busy: boolean;
  /**
   * No search for `searchText` runs, and the search of one or more projects
   * failed while it was the board's text, and has no result.
   */
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

/** The union of the ids of `reads`; `null` when `reads` is empty or holds an `undefined`: then every card shows. */
export function searchIds(reads: readonly (Success<TaskList> | undefined)[]): ReadonlySet<string> | null {
  if (reads.length === 0 || !reads.every((read) => read !== undefined)) {
    return null;
  }

  return new Set(reads.flatMap((read) => read.data.entries.map(({ id }) => id)));
}

/**
 * The joined ids of the search of `text` in `tags`, from the cache; `null` for
 * an empty `text`, or while the cache has no result of one tag.
 */
export function cachedSearchIds(
  queryClient: QueryClient,
  client: Client,
  tags: readonly string[],
  text: string,
): ReadonlySet<string> | null {
  return text === ""
    ? null
    : searchIds(tags.map((tag) => queryClient.getQueryData(taskSearchQuery(client, tag, text).queryKey)));
}

/** `shown` is `next` on `board`: both are `null`, or `shown` is of `board` and holds the same reads. */
function isShown(shown: ShownResult | null, next: SearchResult | null, board: string): boolean {
  if (shown === null || next === null) {
    return shown === next;
  }

  return shown.board === board
    && shown.reads.length === next.reads.length
    && shown.reads.every((read, index) => read === next.reads[index]);
}

/** The board's search reads for `q` in the projects of `tags`, and the result its columns apply. */
export function useBoardSearch(
  client: Client,
  tags: readonly string[],
  board: string,
  q: string | undefined,
): BoardSearch {
  // The daemon splits `q` on whitespace, so a blank text is no search here either.
  const searchText = q?.trim() ?? "";
  const searchRequested = searchText !== "";
  // Not under Suspense: each new text is a new key. No `placeholderData`: it is
  // the data of the last query that had any, not of the previous text.
  const searchReads = useQueries({
    queries: tags.map((tag) => ({ ...taskSearchQuery(client, tag, searchText), enabled: searchRequested })),
  });
  const errorCounts = new Map(tags.map((tag, index) => [tag, searchReads[index]!.errorUpdateCount]));
  // A refetch of a key with no data sets its status back to pending and drops
  // its error, so a failure is read from the error count, which a refetch
  // keeps. The cache keeps the count after the board leaves the text or the
  // project too, so only the failures since both became the board's count. A
  // project that stays on the next board keeps its base: its observer does not
  // read again.
  const [errorBase, setErrorBase] = useState<{ searchText: string; counts: ReadonlyMap<string, number> }>({
    searchText,
    counts: errorCounts,
  });
  const textIsCurrent = errorBase.searchText === searchText;
  const errorsBefore = new Map(tags.map((tag) => [
    tag,
    (textIsCurrent ? errorBase.counts.get(tag) : undefined) ?? errorCounts.get(tag)!,
  ]));
  const tagsChanged = errorsBefore.size !== errorBase.counts.size || tags.some((tag) => !errorBase.counts.has(tag));

  if (!textIsCurrent || tagsChanged) {
    setErrorBase({ searchText, counts: errorsBefore });
  }

  const reads = searchReads.map((read) => read.data);
  const readFailed = tags.map((tag, index) => (
    reads[index] === undefined && errorCounts.get(tag)! > errorsBefore.get(tag)!
  ));
  const busy = searchRequested && reads.some((read, index) => read === undefined && !readFailed[index]);
  const failed = searchRequested && !busy && readFailed.includes(true);
  // The current text's result once every project has one, else, while a
  // search runs, the one shown before. Adjusted during render: an effect
  // would leave one render on the ids of a dropped result.
  const [shown, setShown] = useState<ShownResult | null>(null);
  let nextShown: SearchResult | null = null;

  if (searchRequested && tags.length > 0 && reads.every((read) => read !== undefined)) {
    nextShown = { text: searchText, reads };
  } else if (busy && shown?.board === board) {
    nextShown = shown;
  }
  if (!isShown(shown, nextShown, board)) {
    setShown(nextShown === null ? null : { ...nextShown, board });
  }

  const applied = useDeferredValue(shown);
  const settled = !busy && applied === shown;
  // The wait that has lasted BUSY_ANNOUNCE_DELAY. A new text restarts the timer
  // and keeps the mark, so the region keeps the earlier sentence until the new
  // text has also run for BUSY_ANNOUNCE_DELAY.
  const [mark, setMark] = useState<{ board: string; text: string } | null>(null);

  if (mark !== null && (!busy || mark.board !== board)) {
    setMark(null);
  }

  useEffect(() => {
    if (!busy) {
      return;
    }

    const timer = setTimeout(() => {
      setMark({ board, text: searchText });
    }, BUSY_ANNOUNCE_DELAY);

    return () => {
      clearTimeout(timer);
    };
  }, [busy, board, searchText]);

  const announced = busy && mark !== null && mark.board === board ? mark.text : null;
  // Deferred with `applied`, so the region never says a result older than the busy sentence.
  const searching = useDeferredValue(announced);
  const ids = applied === null ? null : searchIds(applied.reads);

  return { searchText, busy, failed, searching, applied, ids, settled };
}
