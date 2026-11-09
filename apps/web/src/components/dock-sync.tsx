import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { Client } from "@tasma/protocol";
import { useEffect } from "react";
import { dockState, sendDockState } from "../api/dock";
import { agentStateQuery } from "../api/queries";

type DockSyncProps = {
  queryClient: QueryClient;
  client: Client;
};

/** Sends the state of the agents to the Dock icon of the macOS app, also on a screen with no sidebar. */
export function DockSync({ queryClient, client }: DockSyncProps): null {
  const { data } = useQuery(agentStateQuery(client), queryClient);
  const state = dockState(data?.data);

  useEffect(() => {
    if (state !== undefined) {
      void sendDockState(state);
    }
  }, [state]);

  return null;
}
