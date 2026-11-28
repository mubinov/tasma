import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Client } from "@tasma/protocol";
import { useEffect, useEffectEvent } from "react";
import { setupQuery } from "../api/queries";
import { useUiStore } from "../store/ui";
import { READ_INTERVAL_MS } from "./setup-steps";

/**
 * The full read of the setup status. The screen and the dialog of an agent read the same query, so a place that
 * polls reads for both. It also reads when the window gets focus. Returns a read that runs at once.
 */
export function useFullSetupRead(client: Client, poll: boolean): () => Promise<{ isError: boolean }> {
  const skillCheckStopped = useUiStore((state) => state.skillCheckStopped);
  const full = useQuery({
    ...setupQuery(client, skillCheckStopped ? { mode: "full", skipSkill: true } : { mode: "full" }),
    refetchInterval: poll ? READ_INTERVAL_MS : false,
    placeholderData: keepPreviousData,
  });

  const readAgain = useEffectEvent(() => {
    void full.refetch({ cancelRefetch: false });
  });

  // The library itself reacts only to `visibilitychange`, and a switch to
  // another app usually leaves the window visible.
  useEffect(() => {
    function onFocus(): void {
      readAgain();
    }

    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return () => full.refetch({ cancelRefetch: false });
}
