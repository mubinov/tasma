// The agent of a new chat with no agent of its own.

import type { ChatAgent } from "@tasma/protocol";

/** With only Claude offered, the agent of a new chat is Claude, and nothing is read or checked. */
export function offersOnlyClaude(offered: readonly ChatAgent[]): boolean {
  return offered.every((agent) => agent === "claude");
}

/**
 * The stored agent when the daemon offers it; else the only ready agent; else
 * Claude. Claude is always offered, and a ready Claude is the answer whatever
 * the other agents are, so they are checked only when Claude is not ready.
 */
export async function effectiveAgent(options: {
  offered: readonly ChatAgent[];
  stored: () => Promise<string | undefined>;
  ready: (agent: ChatAgent) => Promise<boolean>;
}): Promise<ChatAgent> {
  const { offered, stored, ready } = options;
  if (offersOnlyClaude(offered)) return "claude";

  const value = await stored();
  const chosen = offered.find((agent) => agent === value);
  if (chosen !== undefined) return chosen;

  if (await ready("claude")) return "claude";
  const others = offered.filter((agent) => agent !== "claude");
  const answers = await Promise.all(others.map(ready));
  const readyOthers = others.filter((_agent, index) => answers[index]);
  return readyOthers.length === 1 ? readyOthers[0]! : "claude";
}
