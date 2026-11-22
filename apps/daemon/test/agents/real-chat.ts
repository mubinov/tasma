// The log reads and the waits of a chat with a real agent.

import type { ChatEvent } from "@tasma/protocol";
import type { LiveChat } from "../../src/chats/registry.js";
import { logOf } from "../helpers.js";

export const TURN_MS = 120_000;

/** Waits until the log holds `turns` turn ends, or a failure, and gives the log. */
export async function turnsEnded(live: LiveChat, turns: number): Promise<ChatEvent[]> {
  let log: ChatEvent[] = [];
  const ended = () => log.filter((event) => event.kind === "turn-end").length >= turns;
  const deadline = Date.now() + TURN_MS;
  while (!ended() && log.at(-1)?.kind !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    log = await logOf(live);
  }
  return log;
}

/** Waits until `holds` gives true, for up to `ms`, and gives its last result. */
export async function within(ms: number, holds: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + ms;
  let result = await holds();
  while (!result && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    result = await holds();
  }
  return result;
}

/**
 * The last event of `log` that is not an update. After the first turn the
 * adapter can send the title of the session, so an update can follow `turn-end`.
 */
export function lastNonUpdate(log: ChatEvent[]): ChatEvent | undefined {
  return log.findLast((event) => event.kind !== "update");
}

/** The text of the answers of the agent in `log`. */
export function answerText(log: ChatEvent[]): string {
  return log.flatMap((event) => {
    if (event.kind !== "update" || event.update.sessionUpdate !== "agent_message_chunk") return [];
    const content = event.update.content as { type?: string; text?: string };
    return content.type === "text" ? [content.text ?? ""] : [];
  }).join("");
}
