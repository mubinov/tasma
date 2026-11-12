// The routes over the agents that a chat can run, apart from any chat.

import type { AgentDefaultsStore, AgentOptionsEntry, AgentOptionsStore } from "@tasma/engine";
import { AGENT_OPTION_RULES, routes } from "@tasma/protocol";
import type { AgentOptions, ChatAgent, Success } from "@tasma/protocol";
import { DaemonError } from "../http/failure.js";
import type { RouteEntry } from "../http/router.js";
import { assertNoQuery } from "../tasks/filter.js";
import { startDefaults, startOptions } from "./options.js";

/**
 * The agent routes. The faults of the files come back as diagnostics, not on
 * stderr. A refresh that a read starts writes one line on stderr when it fails.
 */
export function agentRoutes(parts: {
  options: AgentOptionsStore;
  defaults: AgentDefaultsStore;
  /** Gets the stored list of each read of the options, and does not hold the answer. */
  refresh: (agent: ChatAgent, entry: AgentOptionsEntry | undefined) => void;
}): RouteEntry[] {
  return [
    {
      route: routes.readAgentOptions,
      handler: async (request): Promise<Success<AgentOptions>> => {
        assertNoQuery(request.query);
        const name = request.params.agent!;
        if (!Object.hasOwn(AGENT_OPTION_RULES, name)) {
          throw new DaemonError("agent-unknown", `Tasma knows no agent "${name}"`);
        }
        const agent = name as ChatAgent;
        const [optionsRead, defaultsRead] = await Promise.all([parts.options.read(), parts.defaults.read()]);
        const diagnostics = [...optionsRead.diagnostics, ...defaultsRead.diagnostics];
        const entry = optionsRead.lists[agent];
        parts.refresh(agent, entry);
        if (entry === undefined) return { data: { agent, options: [] }, diagnostics };
        const { defaults } = startDefaults(agent, entry.options, defaultsRead);
        const options = startOptions(agent, entry.options, defaults);
        return { data: { agent, options, updated: entry.updated }, diagnostics };
      },
    },
  ];
}
