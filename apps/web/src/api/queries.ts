import { queryOptions } from "@tanstack/react-query";
import type { Client } from "@tasma/protocol";

/**
 * Two properties a new key has to keep: every key descends from `all`, so one
 * prefix invalidation drops everything the daemon said, and keys nest the way
 * the routes nest, so a write to one project leaves every other project's cache
 * intact.
 */
export const daemonKeys = {
  all: ["daemon"] as const,
  health: () => [...daemonKeys.all, "health"] as const,
};

/**
 * The query function returns the whole `Success<T>`: unwrapping to `.data` here
 * would drop the diagnostics, the only signal a hand edit changed a file.
 */
export function healthQuery(client: Client) {
  return queryOptions({
    queryKey: daemonKeys.health(),
    queryFn: () => client.readHealth(),
  });
}
