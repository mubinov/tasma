import { matchQuery, type QueryClient } from "@tanstack/react-query";
import type { Client, FeedEvent } from "@tasma/protocol";
import { useEffect } from "react";
import { FEED_MAPPINGS, filtersOf, type FeedMappings } from "../api/feed-events";
import { startLongPoll } from "../api/long-poll";
import { daemonKeys } from "../api/queries";

type FeedSubscriberProps = {
  queryClient: QueryClient;
  client: Client;
  mappings?: FeedMappings;
};

/**
 * Reads the change feed of the daemon for the whole app and marks the queries
 * each reply makes old. One invalidation per reply, so an active query reads
 * again once however many events the reply holds.
 */
export function FeedSubscriber({ queryClient, client, mappings = FEED_MAPPINGS }: FeedSubscriberProps): null {
  useEffect(() => {
    const poll = startLongPoll<FeedEvent>({
      read: (after, signal) => client.readEvents(after, { signal }).then(({ data }) => data),
      onEvents: (events) => {
        const filters = filtersOf(events, mappings);
        if (filters.length > 0) {
          void queryClient.invalidateQueries({
            predicate: (query) => filters.some((filter) => matchQuery(filter, query)),
          });
        }
      },
      onReset: () => {
        void queryClient.invalidateQueries({ queryKey: daemonKeys.all });
      },
    });

    return () => {
      poll.stop();
    };
  }, [queryClient, client, mappings]);

  return null;
}
