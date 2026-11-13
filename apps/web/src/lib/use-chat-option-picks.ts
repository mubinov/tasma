import { AGENT_OPTION_RULES, type ChatAgent } from "@tasma/protocol";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { usePendingChatOptions } from "../api/mutations";
import type { ChatPlace } from "../api/queries";
import { useNoticeStore } from "../store/notices";
import type { ChatOption, ChatView } from "./chat-fold";
import { chatAnnouncements, chatOptionWords, chatPickerOptions } from "./chat-messages";
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
 * turns true to the one where it turns false. `start` holds the current value
 * of each option of the picker row before it, by option id.
 */
type PickPeriod = { start: Readonly<Record<string, string>> };

export type KeptLog = {
  /** The view of the last ready render, null before the first one. */
  before: ChatView | null;
  period: PickPeriod | null;
  /** Each successful pick that no period took yet: its option and the `seq` of its answer. */
  successes: readonly { configId: string; seq: number }[];
};

export const KEPT_LOG_START: KeptLog = { before: null, period: null, successes: [] };

export function withPickSuccess(kept: KeptLog, configId: string, seq: number): KeptLog {
  return { ...kept, successes: [...kept.successes, { configId, seq }] };
}

/** An option id comes from the agent, so a name of an `Object.prototype` member must find nothing. */
export function byOptionId<T>(record: Readonly<Record<string, T>>, configId: string): T | undefined {
  return Object.hasOwn(record, configId) ? record[configId] : undefined;
}

/** The values of an option of the agent that are not offered. */
export function hiddenValues(agent: ChatAgent, configId: string): readonly string[] {
  return byOptionId(AGENT_OPTION_RULES[agent].hidden, configId) ?? [];
}

function periodStart(view: ChatView): PickPeriod {
  return { start: Object.fromEntries(chatPickerOptions(view).map((option) => [option.id, option.current])) };
}

/**
 * The words for one render of a chat log, and what the next render compares
 * with. Inside a pick period the options of the picker row are left out, and
 * the render that ends the period announces each of them one time: when a pick
 * of it in the period succeeded, or when it is not the one before the period.
 * The picked options come first, so the result of a pick comes before its side
 * effects.
 */
export function nextChatLogAnnouncement(
  kept: KeptLog,
  { view, agent, ready, picking }: ChatLogRender,
): { kept: KeptLog; words: string[] } {
  if (!ready) {
    return { kept: { ...kept, before: null, period: null }, words: [] };
  }

  const { before, successes } = kept;
  const period = kept.period ?? (picking ? periodStart(before ?? view) : null);
  const words = before === null ? [] : chatAnnouncements(before, view, agent, period === null);

  if (period === null) {
    // A success that the log reached outside a period is no mark for a later one.
    return { kept: { before: view, period, successes: successes.filter(({ seq }) => seq > view.seq) }, words };
  }
  if (picking) {
    return { kept: { before: view, period, successes }, words };
  }

  const options = chatPickerOptions(view);
  const picked = options.filter((option) => successes.some(({ configId }) => configId === option.id));
  // An option with no value before the period counts as changed.
  const changed = options.filter((option) =>
    !picked.includes(option) && byOptionId(period.start, option.id) !== option.current);
  words.push(...[...picked, ...changed].map((option) => chatOptionWords(option, option.current)));
  return { kept: { before: view, period: null, successes: [] }, words };
}

/** A successful pick: its value and the `seq` of its answer. */
type PickSuccess = { value: string; seq: number };

const NO_PICK_SUCCESSES: Readonly<Record<string, PickSuccess>> = {};

export type ChatOptionPicksInput = ChatPlace & {
  view: ChatView;
  agent: ChatAgent;
  ready: boolean;
  write: ChatWrites["pick"];
};

export type ChatOptionPick = {
  option: ChatOption;
  /** The values of the option that are not offered. */
  hidden: readonly string[];
  /** The value of the pick in progress. */
  pending: string | undefined;
};

export type ChatOptionPicks = {
  /** The pickers of the row, in the order of `chatPickerOptions`. */
  picks: readonly ChatOptionPick[];
  pick: (option: ChatOption, value: string) => void;
};

/**
 * The pickers of a chat log, and the announcements of that log: a change of
 * an option of the picker row must be spoken one time, inside a pick period or
 * outside it.
 */
export function useChatOptionPicks(
  { tag, task, chat, view, agent, ready, write }: ChatOptionPicksInput,
): ChatOptionPicks {
  const keptRef = useRef(KEPT_LOG_START);
  const pendingOptions = usePendingChatOptions({ tag, task, chat });
  // The last successful pick of each option, by option id.
  const [lastSuccesses, setLastSuccesses] = useState(NO_PICK_SUCCESSES);
  // The successful picks whose answer the log has not reached yet.
  const unseenPicks = Object.fromEntries(Object.entries(lastSuccesses).filter(([, { seq }]) => view.seq < seq));
  const picks = chatPickerOptions(view).map((option): ChatOptionPick => ({
    option,
    hidden: hiddenValues(agent, option.id),
    pending: pendingOptions.findLast((one) => one.configId === option.id)?.value
      ?? byOptionId(unseenPicks, option.id)?.value,
  }));
  // From the start of a write until it fails or the log reaches the `seq` of its answer.
  const picking = pendingOptions.length > 0 || Object.keys(unseenPicks).length > 0;

  async function pick(option: ChatOption, value: string): Promise<void> {
    const seq = await write(option.id, value, option.name);
    if (seq === undefined) {
      return;
    }
    // In the same continuation as `setLastSuccesses`, so no render ends the period between the two.
    keptRef.current = withPickSuccess(keptRef.current, option.id, seq);
    // Two answers can come in the wrong order.
    setLastSuccesses((last) => {
      const known = byOptionId(last, option.id);
      return known !== undefined && known.seq >= seq ? last : { ...last, [option.id]: { value, seq } };
    });
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
    picks,
    pick: (option, value) => {
      void pick(option, value);
    },
  };
}
