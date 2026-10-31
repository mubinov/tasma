// What the setup route answers: whether the setup of Tasma on this machine is
// complete, check by check.

import type { ChatAgent } from "./chat.js";

/**
 * `not-run`: the check did not run, because of the mode, the skip flag, or a
 * check that it needs did not pass. `unknown`: the check ran and could not
 * decide.
 */
export type SetupCheck = "pass" | "fail" | "not-run" | "unknown";

export type AgentSetup = { agent: ChatAgent; installed: SetupCheck; loggedIn: SetupCheck; skill: SetupCheck };

/** `agents` holds one entry for each agent that a chat can run, in the same order each time. */
export type SetupStatus = { project: SetupCheck; workflow: SetupCheck; cli: SetupCheck; agents: AgentSetup[] };
