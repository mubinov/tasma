// What the setup routes answer: whether the setup of Tasma on this machine is
// complete, check by check, and how an install of the tasma skill ended.

import type { ChatAgent } from "./chat.js";

/**
 * `not-run`: the check did not run, because of the mode, the skip flag, or a
 * check that it needs did not pass. `unknown`: the check ran and could not
 * decide.
 */
export type SetupCheck = "pass" | "fail" | "not-run" | "unknown";

export type AgentSetup = { agent: ChatAgent; installed: SetupCheck; loggedIn: SetupCheck; skill: SetupCheck };

/**
 * `agents` holds one entry for each agent that a chat can run, in the same
 * order each time. `defaultAgent` is the agent of a new chat with no agent of
 * its own. Only the full read gives it, and not when the user's configuration
 * file cannot be read.
 */
export type SetupStatus = {
  project: SetupCheck;
  workflow: SetupCheck;
  cli: SetupCheck;
  agents: AgentSetup[];
  defaultAgent?: ChatAgent;
};

/**
 * The answer to an install of the tasma skill for each agent. `running`: the
 * install did not end within the hold, and `run` names it in the next call.
 * `npx-missing`: the login shell has no `npx` on its `PATH`. `output` holds at
 * most the last 64 KiB of the output of the command.
 */
export type SkillInstall
  = | { result: "installed" }
    | { result: "running"; run: string }
    | { result: "npx-missing" }
    | { result: "failed"; output: string };
