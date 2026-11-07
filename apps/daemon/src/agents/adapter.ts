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

/** A command that the agent started in the background and that still runs. */
export type RunningCommand = { mark: "job" | "service" | undefined; name: string };

/** `jobsEnded`: the `job` commands that this check found ended. A later check does not count them again. */
export type BackgroundState = { running: RunningCommand[]; jobsEnded: number };

export type BackgroundCommands = {
  /** Reads one session update of the agent, before `filterUpdate` drops a part of it. */
  note(update: AcpObject): void;
  /** A command that it cannot check counts as not running. */
  running(): Promise<BackgroundState>;
  /** Whether the update marks the end of an own turn of the agent. */
  ownTurnEnded(update: AcpObject): boolean;
};

export type AgentAdapter = {
  agent: ChatAgent;
  /** Gives a result rather than throwing when the agent cannot run here. */
  launch(env: AgentEnv): LaunchResult;
  /** Whether the agent is logged in: `undefined` when it cannot tell. */
  loggedIn(env: AgentEnv, signal: AbortSignal): Promise<boolean | undefined>;
  /** The fixed paths that hold the tasma skill of this agent in `env`. Never a wide search. */
  skillFiles(env: AgentEnv): string[];
  /** Whether the agent itself lists the tasma skill: `false` with no binary, `undefined` when it cannot tell. */
  skillListed(env: AgentEnv, signal: AbortSignal): Promise<boolean | undefined>;
  /** The name of the agent for `npx skills add -a`. */
  skillsAgent: string;
  /**
   * Runs the ACP server of the agent in this process, over its stdin and
   * stdout. Only an agent whose ACP server is code of the daemon has it.
   */
  serve?(): Promise<void>;
  /** The reason a chat fails with when the agent refuses with `auth_required` (-32000). */
  notLoggedIn: string;
  /** The reason a chat fails with when the agent no longer has the session of the chat. */
  sessionGone: string;
  /** The reason a project chat fails with when the agent no longer has the session of the chat. */
  projectSessionGone: string;
  /** Gives the update as the log keeps it: a new object when it changes anything. */
  filterUpdate(update: AcpObject): AcpObject;
  /** The `_meta` of `session/new` and `session/resume`. */
  sessionMeta?: AcpObject;
  /** The background commands of one agent process. `log` takes each line for the log of the daemon. */
  backgroundCommands?(log: (cause: string) => void): BackgroundCommands;
};
