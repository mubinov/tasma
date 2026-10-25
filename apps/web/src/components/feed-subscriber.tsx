import { matchQuery, type QueryClient, type QueryFilters } from "@tanstack/react-query";
import type { Client, FeedEvent } from "@tasma/protocol";
import { useEffect } from "react";
import { FEED_MAPPINGS, filtersOf, type FeedMappings } from "../api/feed-events";
import { createFeedNotice } from "../api/feed-notice";
import { startLongPoll } from "../api/long-poll";
import { daemonKeys } from "../api/queries";

type FeedSubscriberProps = {
  queryClient: QueryClient;
  client: Client;
  mappings?: FeedMappings;
};

type Invalidator = {
  invalidate: (filters: QueryFilters) => void;
  stop: () => void;
};

/**
 * Marks queries old and reads the active ones again. The library lets some
 * reads in flight run on, for example a first load or a read of a query that no
 * screen shows. The result of such a read can predate the change, and it clears
 * the mark: such a query is marked again when that read lands.
 */
function createInvalidator(queryClient: QueryClient): Invalidator {
  const cache = queryClient.getQueryCache();
  // Weak: a query that leaves the cache in flight never lands.
  const landing = new WeakSet<object>();
  const stop = cache.subscribe(({ type, query: landed }) => {
    if (type === "updated" && landed.state.fetchStatus === "idle" && landing.delete(landed)) {
      void queryClient.invalidateQueries({ predicate: (query) => query === landed });
    }
  });

  return {
    invalidate: (filters) => {
      const inFlight = cache.findAll(filters)
        .filter(({ state }) => state.fetchStatus !== "idle")
        .map((query) => ({ query, read: query.promise }));
      void queryClient.invalidateQueries(filters);
      // A read the library started again has a new promise, and came after the change.
      for (const { query, read } of inFlight) {
        if (query.promise === read) {
          landing.add(query);
        } else {
          landing.delete(query);
        }
      }
    },
    stop,
  };
}

/**
 * Reads the change feed of the daemon for the whole app and marks the queries
 * each reply makes old. One invalidation per reply, so an active query reads
 * again once however many events the reply holds. The feed notice tells when
 * the reads fail.
 */
export function FeedSubscriber({ queryClient, client, mappings = FEED_MAPPINGS }: FeedSubscriberProps): null {
  useEffect(() => {
    const notice = createFeedNotice();
    const invalidator = createInvalidator(queryClient);
    const poll = startLongPoll<FeedEvent>({
      read: (after, signal) => client.readEvents(after, { signal }).then(
        // A read with no cursor gets no events, so it does not report a change between the earlier reads and this read.
        ({ data }) => (after === undefined ? { reset: true as const, cursor: data.cursor } : data),
        (error: unknown) => {
          notice.failed(error);
          throw error;
        },
      ),
      onEvents: (events) => {
        const filters = filtersOf(events, mappings);
        if (filters.length > 0) {
          invalidator.invalidate({ predicate: (query) => filters.some((filter) => matchQuery(filter, query)) });
        }
      },
      onReset: () => {
        invalidator.invalidate({ queryKey: daemonKeys.all });
      },
      onStatus: notice.status,
    });

    return () => {
      poll.stop();
      notice.stop();
      invalidator.stop();
    };
  }, [queryClient, client, mappings]);

  return null;
}
