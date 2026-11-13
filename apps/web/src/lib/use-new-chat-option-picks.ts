import type { ChatAgent } from "@tasma/protocol";
import { useState } from "react";
import { chatOptions, type ChatOption } from "./chat-fold";
import { chatOptionValueName, chatOptionWords, chatPickerOptions } from "./chat-messages";
import { byOptionId, hiddenValues } from "./use-chat-option-picks";

/** A picker of the row of New chat. */
export type NewChatOption = {
  /** The option with the shown value as `current`. */
  shown: ChatOption;
  /** The option as the list gives it, with the start value as `current`. */
  listed: ChatOption;
  /** The values of the option that are not offered. */
  hidden: readonly string[];
};

export type DroppedPicks = { words: readonly string[] };

export type NewChatOptionPicksInput = {
  agent: ChatAgent;
  /** The config options of the last list that a read gave, or undefined while no read has given one. */
  configOptions: readonly unknown[] | undefined;
  /** The options that the start that waits sent, or null while no start waits. */
  sent: Readonly<Record<string, string>> | null;
};

export type NewChatOptionPicks = {
  /** The pickers of the row, in the order of `chatPickerOptions`. */
  options: readonly NewChatOption[];
  /** The words for the picks that the last change of the list dropped. */
  dropped: DroppedPicks | null;
  /** Each shown value that differs from its start value, by option id, or undefined with none. */
  changed: Readonly<Record<string, string>> | undefined;
  pick: (option: NewChatOption, value: string) => void;
};

/** A pick of the user, with the names to announce it by when a change of the list drops it. */
type OptionPick = { value: string; valueName: string; optionName: string };

function offers(option: ChatOption, hidden: readonly string[], value: string): boolean {
  return !hidden.includes(value) && option.values.some((one) => one.value === value);
}

/** With no list, a pick is named by its ids. */
function sentPicks(
  sent: Readonly<Record<string, string>> | null,
  rowOptions: readonly ChatOption[],
): ReadonlyMap<string, OptionPick> {
  return new Map(Object.entries(sent ?? {}).map(([configId, value]) => {
    const option = rowOptions.find(({ id }) => id === configId);
    const pick = option === undefined
      ? { value, valueName: value, optionName: configId }
      : { value, valueName: chatOptionValueName(option, value), optionName: option.name };
    return [configId, pick];
  }));
}

/** What a screen reader hears about a pick that a change of the list dropped. */
function droppedWords(pick: OptionPick, now: NewChatOption | undefined): string {
  if (now === undefined) {
    return `${pick.optionName} is not offered anymore.`;
  }
  return `${pick.valueName} is not offered anymore. ${chatOptionWords(now.listed, now.listed.current)}.`;
}

/**
 * The pickers of New chat. The shown value of an option is, while a start
 * waits, the value that it sent or the start value; else an offered pick of
 * the user, or the start value. A change of the list drops each pick that it
 * does not offer, but only after the wait: the start has sent its picks.
 */
export function useNewChatOptionPicks({ agent, configOptions, sent }: NewChatOptionPicksInput): NewChatOptionPicks {
  const rowOptions = configOptions === undefined ? [] : chatPickerOptions({ options: chatOptions(configOptions) });
  // A view that mounts while a start waits takes the picks of that start, so a refused start keeps them.
  const [picks, setPicks] = useState(() => sentPicks(sent, rowOptions));
  // No list has checked the picks of a start yet.
  const [checkedOn, setCheckedOn] = useState(sent === null ? configOptions : undefined);
  const [dropped, setDropped] = useState<DroppedPicks | null>(null);

  const options = rowOptions.map((option): NewChatOption => {
    const hidden = hiddenValues(agent, option.id);
    const picked = picks.get(option.id)?.value;
    const current = sent === null
      ? (picked !== undefined && offers(option, hidden, picked) ? picked : option.current)
      : (byOptionId(sent, option.id) ?? option.current);
    return { shown: { ...option, current }, listed: option, hidden };
  });
  const optionOf = (configId: string): NewChatOption | undefined =>
    options.find((option) => option.listed.id === configId);

  if (sent === null && checkedOn !== configOptions) {
    setCheckedOn(configOptions);
    const entries = [...picks];
    const lost = entries.filter(([configId, { value }]) => {
      const option = optionOf(configId);
      return option === undefined || !offers(option.listed, option.hidden, value);
    });
    if (lost.length > 0) {
      setPicks(new Map(entries.filter((entry) => !lost.includes(entry))));
      setDropped({ words: lost.map(([configId, one]) => droppedWords(one, optionOf(configId))) });
    }
  }

  const changed = options
    .filter(({ shown, listed }) => shown.current !== listed.current)
    .map(({ shown }): [string, string] => [shown.id, shown.current]);

  function pick({ listed }: NewChatOption, value: string): void {
    setPicks((current) => {
      const next = new Map(current);
      if (value === listed.current) {
        next.delete(listed.id);
      } else {
        next.set(listed.id, { value, valueName: chatOptionValueName(listed, value), optionName: listed.name });
      }
      return next;
    });
  }

  return { options, dropped, changed: changed.length === 0 ? undefined : Object.fromEntries(changed), pick };
}
