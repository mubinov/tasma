import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { isAgentReady, type ChatAgent } from "@tasma/protocol";
import { useState } from "react";
import { agentSetupQuery } from "../api/queries";
import { chatAgentName } from "./chat-messages";
import { newestSetup } from "./setup-steps";

export type NewChatAgent = {
  /** The agent whose lists New chat shows, or undefined while it is not known. */
  agent: ChatAgent | undefined;
  /** The agent that a start sends: `agent` when the setup status lists more than one agent, else undefined. */
  sent: ChatAgent | undefined;
  /** The agents of the Agent picker, in the order of the setup status. Empty when the picker does not show. */
  choices: readonly ChatAgent[];
  /** The words for the last change of `agent` that the user did not make, or null. */
  moved: { words: string } | null;
  pick: (agent: ChatAgent) => void;
};

export type NewChatAgentInput = {
  /** The agent that the start that waits sent, `undefined` when it sent none, or `null` while no start waits. */
  waiting: ChatAgent | undefined | null;
};

const NO_CHOICES: readonly ChatAgent[] = [];

/** What the agent of New chat would be from the setup status alone. */
type FromSetup = Omit<NewChatAgent, "moved" | "pick"> & { ready: readonly ChatAgent[] };

const UNKNOWN: FromSetup = { agent: undefined, sent: undefined, choices: NO_CHOICES, ready: NO_CHOICES };

/**
 * The agent of New chat. With one agent offered, it is that agent and no read
 * runs. Else the full read of the setup status gives the ready agents and the
 * default: the agent is the pick of the user while that agent is ready, else
 * the default. A start that waits with an agent fixes the agent until it ends.
 * Nothing is saved.
 */
export function useNewChatAgent({ waiting }: NewChatAgentInput): NewChatAgent {
  const { client, queryClient } = useRouter().options.context;
  const [offered] = useState(() => newestSetup(queryClient)?.agents.map(({ agent }) => agent));
  const only = offered?.length === 1 ? offered[0] : undefined;
  const { data } = useQuery({ ...agentSetupQuery(client), enabled: only === undefined }, queryClient);
  // A view that mounts while a start waits takes the agent of that start, so a refused start keeps it.
  // The default is never a pick, so a later change of the default moves the view.
  const [picked, setPicked] = useState<ChatAgent | undefined>(() =>
    waiting === data?.data.defaultAgent ? undefined : (waiting ?? undefined),
  );
  const waits = waiting !== null;

  let fromSetup = UNKNOWN;
  if (only !== undefined) {
    fromSetup = { ...UNKNOWN, agent: only };
  } else if (data?.data.defaultAgent !== undefined) {
    const { agents, defaultAgent } = data.data;
    const ready = agents.filter(isAgentReady).map(({ agent }) => agent);
    const agent = picked !== undefined && ready.includes(picked) ? picked : defaultAgent;
    fromSetup = {
      agent,
      sent: agents.length > 1 ? agent : undefined,
      choices: ready.length > 1 ? ready : NO_CHOICES,
      ready,
    };
  }
  const { ready, choices } = fromSetup;
  const { agent, sent } = waiting === undefined || waiting === null ? fromSetup : { agent: waiting, sent: waiting };

  const [shown, setShown] = useState({ agent, waits });
  const [moved, setMoved] = useState<{ words: string } | null>(null);
  const pickLost = picked !== undefined && fromSetup.agent !== undefined && !ready.includes(picked);

  if (pickLost) {
    setPicked(undefined);
  }
  if (shown.agent !== agent || shown.waits !== waits) {
    setShown({ agent, waits });
    if (shown.agent !== undefined && agent !== undefined && shown.agent !== agent && !shown.waits && !waits) {
      const words = `New chat uses ${chatAgentName(agent)}.`;
      setMoved({ words: pickLost ? `${chatAgentName(shown.agent)} is not ready anymore. ${words}` : words });
    }
  }

  return {
    agent,
    sent,
    choices,
    moved,
    pick: (next) => {
      setPicked(next === data?.data.defaultAgent ? undefined : next);
      setShown({ agent: next, waits });
    },
  };
}
