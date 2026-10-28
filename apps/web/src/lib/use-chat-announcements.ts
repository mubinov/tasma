import { chatMark } from "@tasma/protocol";
import type { Chat, ChatState, ChatStatus } from "@tasma/protocol";
import { useEffect, useEffectEvent, useRef } from "react";
import { useNoticeStore } from "../store/notices";

export type ChatInState = { chat: number; state: ChatState };

export type ChatAnnouncementsInput = {
  /** The chats of the task as read, oldest first. */
  chats: readonly Chat[];
  /**
   * A read of the chats is in progress. The hook counts from the first render
   * with no read in progress: a cached list at mount can be old, and its read
   * brings the change.
   */
  fetching: boolean;
  /** The status of the task is not final. */
  stateful: boolean;
  /** From `currentStep`. */
  currentStep: string | undefined;
  /** The chat that the panel shows. The panel announces it. */
  openChat: number | undefined;
  /**
   * While true, a chat newer than the newest chat when quiet began is held back.
   * The render where quiet ends announces the newest held chat by the usual
   * rules, so `seen` must arrive no later than that render. A change of that
   * chat after quiet ends is announced.
   */
  quiet: boolean;
  /**
   * That chat in that state counts as announced. The value is used up when the
   * chat, after a render in that state, renders in another state.
   */
  seen?: ChatInState;
};

export type KeptChats = {
  /** The newest chat and the state of its mark, undefined for no mark. */
  newest: { chat: number; markState: ChatState | undefined } | null;
  /** While quiet, the number of the newest chat when quiet began, or 0 for none. */
  quietAfter: number | null;
  seen: ChatInState | undefined;
  /** "shown" once `seen.chat` rendered in `seen.state`, "spent" once it then rendered in another state. */
  seenPhase: "waiting" | "shown" | "spent";
};

function sameChatState(one: ChatInState | undefined, other: ChatInState | undefined): boolean {
  return one?.chat === other?.chat && one?.state === other?.state;
}

function announcement(step: string, mark: ChatStatus | undefined): string | null {
  if (mark?.state === "needs-you") {
    return `The ${step} chat needs you.`;
  }
  return mark?.state === "failed" ? `The ${step} chat failed.` : null;
}

function nextSeenPhase(kept: KeptChats | null, seen: ChatInState | undefined, chats: readonly Chat[]): KeptChats["seenPhase"] {
  if (seen === undefined) {
    return "waiting";
  }
  const lastPhase = kept !== null && sameChatState(seen, kept.seen) ? kept.seenPhase : "waiting";
  const listed = chats.find(({ chat }) => chat === seen.chat);
  if (lastPhase === "spent" || listed === undefined) {
    return lastPhase;
  }
  if (listed.state === seen.state) {
    return "shown";
  }
  return lastPhase === "shown" ? "spent" : "waiting";
}

/**
 * The words for one render of the chats, and what the next render compares
 * with. The first render, with nothing kept, announces nothing.
 */
export function nextChatAnnouncement(
  kept: KeptChats | null,
  { chats, fetching, stateful, currentStep, openChat, quiet, seen }: ChatAnnouncementsInput,
): { kept: KeptChats | null; words: string | null } {
  if (kept === null && fetching) {
    return { kept: null, words: null };
  }

  const newest = chats.at(-1);
  const mark = newest === undefined ? undefined : chatMark(newest, currentStep);
  const current = newest === undefined ? null : { chat: newest.chat, markState: mark?.state };
  const floor = kept === null ? current : kept.newest;
  const quietAfter = quiet ? kept?.quietAfter ?? floor?.chat ?? 0 : null;
  const seenPhase = nextSeenPhase(kept, seen, chats);
  const next = { newest: current, quietAfter, seen, seenPhase };

  if (kept === null || newest === undefined) {
    return { kept: next, words: null };
  }

  const before = kept.newest;
  const changed = before === null
    || newest.chat > before.chat
    || (newest.chat === before.chat && mark?.state !== before.markState);
  const held = quietAfter !== null && newest.chat > quietAfter;
  const released = quietAfter === null && kept.quietAfter !== null && newest.chat > kept.quietAfter;
  const known = seenPhase !== "spent" && sameChatState(seen, newest);
  const announced = (changed || released) && stateful && newest.chat !== openChat && !held && !known;

  return { kept: next, words: announced ? announcement(newest.step, mark) : null };
}

/**
 * Announces the newest chat of a task when its mark changes to a state that
 * needs a human, or comes in with one.
 */
export function useChatAnnouncements(input: ChatAnnouncementsInput): void {
  const keptRef = useRef<KeptChats | null>(null);

  const announceChange = useEffectEvent(() => {
    const { kept, words } = nextChatAnnouncement(keptRef.current, input);
    keptRef.current = kept;
    if (words !== null) {
      useNoticeStore.getState().announce(words);
    }
  });

  const { chats, fetching, stateful, currentStep, openChat, quiet, seen } = input;
  useEffect(() => {
    announceChange();
  }, [chats, fetching, stateful, currentStep, openChat, quiet, seen?.chat, seen?.state]);
}
