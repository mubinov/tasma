import { matchQuery, type QueryClient } from "@tanstack/react-query";
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

/**
 * Reads the change feed of the daemon for the whole app and marks the queries
 * each reply makes old. One invalidation per reply, so an active query reads
 * again once however many events the reply holds. The feed notice tells when
 * the reads fail.
 */
export function FeedSubscriber({ queryClient, client, mappings = FEED_MAPPINGS }: FeedSubscriberProps): null {
  useEffect(() => {
    const notice = createFeedNotice();
    const poll = startLongPoll<FeedEvent>({
      read: (after, signal) => client.readEvents(after, { signal }).then(
        ({ data }) => data,
        (error: unknown) => {
          notice.failed(error);
          throw error;
        },
      ),
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
      onStatus: notice.status,
    });

    return () => {
      poll.stop();
      notice.stop();
    };
  }, [queryClient, client, mappings]);

  return null;
}
