import { useQuery } from "@tanstack/react-query";
import { useMatch, useRouter } from "@tanstack/react-router";
import type { AgentState } from "@tasma/protocol";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { agentStateQuery, projectsQuery } from "../api/queries";
import { useNoticeStore } from "../store/notices";
import { chatFilterOf, sameFilter } from "./use-chat-filter";

export type AgentSignal = {
  state: AgentState;
  /** The user stopped the motion of the current state. */
  still: boolean;
  stopMotion: () => void;
};

/** The state of the agents for the sidebar, and what a change of it says and plays. */
export function useAgentSignal(): AgentSignal {
  // The shell renders the sidebar wherever the router does, provider or not.
  const { queryClient, client } = useRouter().options.context;
  const { data } = useQuery(agentStateQuery(client), queryClient);
  const answer = data?.data.state;
  const state = answer ?? "off";
  const chatsSearch = useMatch({ from: "/", shouldThrow: false, select: (match) => match.search });
  const answeredRef = useRef(false);
  const [shownState, setShownState] = useState(state);
  const [still, setStill] = useState(false);

  if (state !== shownState) {
    setShownState(state);
    setStill(false);
  }

  // The unfiltered list announces each change itself, but not its first result after a mount.
  const announceNeedsYou = useEffectEvent((first: boolean) => {
    const projects = queryClient.getQueryData(projectsQuery(client).queryKey)?.data ?? [];
    const listAnnounces = chatsSearch !== undefined && sameFilter(chatFilterOf(chatsSearch, projects), {});
    if (first || !listAnnounces) {
      useNoticeStore.getState().announce("A chat needs you");
    }
  });

  useEffect(() => {
    if (answer === undefined) return;
    const first = !answeredRef.current;
    answeredRef.current = true;
    if (answer === "needs-you") {
      announceNeedsYou(first);
    }
  }, [answer]);

  return { state, still, stopMotion: () => setStill(true) };
}
