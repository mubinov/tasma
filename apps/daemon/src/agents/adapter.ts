// What one agent configures for its chats, so that the ACP client in `acp.ts`
// holds nothing of any one agent.

import type { AcpObject, ChatAgent } from "@tasma/protocol";

export type AgentEnv = Record<string, string | undefined>;

export type AgentLaunch = { command: string; args: string[]; env: AgentEnv };

export type AgentAdapter = {
  agent: ChatAgent;
  /** Gives `failed` with the reason for the log, rather than throwing, when the agent cannot run here. */
  launch(env: AgentEnv): AgentLaunch | { failed: string };
  /** The reason a chat fails with when the agent refuses with `auth_required` (-32000). */
  notLoggedIn: string;
  /** Gives the update as the log keeps it: a new object when it changes anything. */
  filterUpdate(update: AcpObject): AcpObject;
};
