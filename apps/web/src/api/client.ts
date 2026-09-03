import { QueryClient } from "@tanstack/react-query";
import { createClient, TransportError, type Client } from "@tasma/protocol";
import { DAEMON_PATH_PREFIX } from "./paths";
import { createFetchTransport } from "./transport";

/** Reaches the daemon through the proxy, so every call stays same-origin. */
export function createDaemonClient(): Client {
  return createClient(createFetchTransport(DAEMON_PATH_PREFIX));
}

/**
 * A whitelist, not a blacklist: a `ProtocolError` is an answer, and asking again
 * Gets the same answer while the failure panel waits. A blacklist would also
 * repeat the plain `Error` `buildPath` raises for an argument no URL can carry,
 * which is a fault in our own code.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  // The count is 0-based on the first call, so `< 1` is exactly one retry.
  return error instanceof TransportError && failureCount < 1;
}

/**
 * `refetchOnWindowFocus` is left at the library's default of on: with no event
 * stream and no polling, returning to the browser after a task file is edited by
 * hand is the only moment this app has to notice. The stale time is what stops
 * that becoming a refetch on every alt-tab.
 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: 30_000,
      },
    },
  });
}
