// The route over the change feed: a long-poll read after a cursor.

import { routes } from "@tasma/protocol";
import type { EventsReply, Success } from "@tasma/protocol";
import type { RouteEntry } from "../http/router.js";
import { readEventsQuery } from "../tasks/filter.js";
import type { Feed } from "./feed.js";

/**
 * The feed route. A value of `after` that is no cursor gets `reset` rather than
 * 400, because the cursor is opaque to a client.
 */
export function eventRoutes(feed: Feed): RouteEntry[] {
  return [
    {
      route: routes.readEvents,
      handler: async (request): Promise<Success<EventsReply>> => {
        const { after } = readEventsQuery(request.query);
        return { data: await feed.read(after), diagnostics: [] };
      },
    },
  ];
}
