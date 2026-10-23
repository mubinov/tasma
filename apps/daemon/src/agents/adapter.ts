// What one agent configures for its chats, so that the ACP client in `acp.ts`
// holds nothing of any one agent.

import type { AcpObject, ChatAgent } from "@tasma/protocol";

/** The flag that runs the daemon binary as the ACP server of one agent: `tasma-daemon --agent <name>`. */
export const AGENT_MODE = "--agent";

export type AgentEnv = Record<string, string | undefined>;

export type AgentLaunch = { command: string; args: string[]; env: AgentEnv };

/**
 * `missing` when the agent binary is not on the `PATH` of the environment, so
 * that another environment can be tried, and `failed` for any other reason the
 * agent cannot run. Each text is the reason for the log.
 */
export type LaunchResult = AgentLaunch | { missing: string } | { failed: string };

export type AgentAdapter = {
  agent: ChatAgent;
  /** Gives a result rather than throwing when the agent cannot run here. */
  launch(env: AgentEnv): LaunchResult;
  /**
   * Runs the ACP server of the agent in this process, over its stdin and
   * stdout. Only an agent whose ACP server is code of the daemon has it.
   */
  serve?(): Promise<void>;
  /** The reason a chat fails with when the agent refuses with `auth_required` (-32000). */
  notLoggedIn: string;
  /** Gives the update as the log keeps it: a new object when it changes anything. */
  filterUpdate(update: AcpObject): AcpObject;
};
