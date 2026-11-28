import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

export function useQueryCache<T>(queryClient: QueryClient, read: (queryClient: QueryClient) => T): T {
  return useSyncExternalStore(
    (onChange) => queryClient.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    () => read(queryClient),
  );
}
