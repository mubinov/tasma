import { AGENT_OPTION_RULES, type ChatAgent } from "@tasma/protocol";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { usePendingChatOptions } from "../api/mutations";
import type { ChatPlace } from "../api/queries";
import { useNoticeStore } from "../store/notices";
import type { ChatOption, ChatView } from "./chat-fold";
import { chatAnnouncements, chatModeOption, chatOptionWords } from "./chat-messages";
import type { ChatWrites } from "./use-chat-writes";

export type ChatLogRender = {
  view: ChatView;
  agent: ChatAgent;
  /** The log caught up. Its state at the first ready render is not news. */
  ready: boolean;
  /** A pick of this window is in progress. */
  picking: boolean;
};

/**
 * A pick period of this window: the ready renders from the one where `picking`
 * turns true to the one where it turns false. `start` is the mode before it.
 */
type PickPeriod = { start: string | undefined };

export type KeptLog = {
  /** The view of the last ready render, null before the first one. */
  before: ChatView | null;
  period: PickPeriod | null;
  /** The `seq` of each successful pick that no period took yet. */
  successes: readonly number[];
};

export const KEPT_LOG_START: KeptLog = { before: null, period: null, successes: [] };

export function withPickSuccess(kept: KeptLog, seq: number): KeptLog {
  return { ...kept, successes: [...kept.successes, seq] };
}

/**
 * The words for one render of a chat log, and what the next render compares
 * with. Inside a pick period the mode is left out, and the render that ends the
 * period announces it one time: when a pick of the period succeeded, or when
 * the mode is not the one before the period.
 */
export function nextChatLogAnnouncement(
  kept: KeptLog,
  { view, agent, ready, picking }: ChatLogRender,
): { kept: KeptLog; words: string[] } {
  if (!ready) {
    return { kept: { ...kept, before: null, period: null }, words: [] };
  }

  const { before, successes } = kept;
  const period = kept.period ?? (picking ? { start: chatModeOption(before ?? view)?.current } : null);
  const words = before === null ? [] : chatAnnouncements(before, view, agent, period === null);

  if (period === null) {
    // A success that the log reached outside a period is no mark for a later one.
    return { kept: { before: view, period, successes: successes.filter((seq) => seq > view.seq) }, words };
  }
  if (picking) {
    return { kept: { before: view, period, successes }, words };
  }

  const mode = chatModeOption(view);
  if (mode !== undefined && (successes.length > 0 || mode.current !== period.start)) {
    words.push(chatOptionWords(mode, mode.current));
  }
  return { kept: { before: view, period: null, successes: [] }, words };
}

/** A successful pick: its value and the `seq` of its answer. */
type PickSuccess = { value: string; seq: number };

export type ChatModePickInput = ChatPlace & {
  view: ChatView;
  agent: ChatAgent;
  ready: boolean;
  write: ChatWrites["pick"];
};

export type ChatModePick = {
  /** The option with the category `mode`. */
  mode: ChatOption | undefined;
  /** The values of the mode that are not offered. */
  hidden: readonly string[];
  /** The value of the pick in progress. */
  pending: string | undefined;
  pick: (option: ChatOption, value: string) => void;
};

/**
 * The mode picker of a chat log, and the announcements of that log: a change
 * of the mode must be spoken one time, inside a pick period or outside it.
 */
export function useChatModePick({ tag, task, chat, view, agent, ready, write }: ChatModePickInput): ChatModePick {
  const keptRef = useRef(KEPT_LOG_START);
  const pendingOptions = usePendingChatOptions({ tag, task, chat });
  const [lastSuccess, setLastSuccess] = useState<PickSuccess | null>(null);
  const unseenPick = lastSuccess !== null && view.seq < lastSuccess.seq ? lastSuccess : null;
  const mode = chatModeOption(view);
  const hiddenByOption = AGENT_OPTION_RULES[agent].hidden;
  // The id comes from the agent, so a name of an `Object.prototype` member must find nothing.
  const hidden = mode !== undefined && Object.hasOwn(hiddenByOption, mode.id) ? hiddenByOption[mode.id]! : [];
  const pending = pendingOptions.findLast((one) => one.configId === mode?.id)?.value ?? unseenPick?.value;
  // From the start of a write until it fails or the log reaches the `seq` of its answer.
  const picking = pendingOptions.length > 0 || unseenPick !== null;

  async function pick(option: ChatOption, value: string): Promise<void> {
    const seq = await write(option.id, value, option.name);
    if (seq === undefined) {
      return;
    }
    // In the same continuation as `setLastSuccess`, so no render ends the period between the two.
    keptRef.current = withPickSuccess(keptRef.current, seq);
    // Two answers can come in the wrong order.
    setLastSuccess((last) => (last !== null && last.seq >= seq ? last : { value, seq }));
  }

  const announceChange = useEffectEvent(() => {
    const { kept, words } = nextChatLogAnnouncement(keptRef.current, { view, agent, ready, picking });
    keptRef.current = kept;
    const { announce } = useNoticeStore.getState();
    for (const one of words) {
      announce(one);
    }
  });

  useEffect(() => {
    announceChange();
  }, [ready, view, agent, picking]);

  return {
    mode,
    hidden,
    pending,
    pick: (option, value) => {
      void pick(option, value);
    },
  };
}
