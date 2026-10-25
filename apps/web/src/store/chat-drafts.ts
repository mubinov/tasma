import { create } from "zustand";
import type { ChatPlace } from "../api/queries";

type ChatDraftState = {
  /** The text in the composer of each chat, by `draftKey`. */
  drafts: ReadonlyMap<string, string>;
  /** An empty text removes the draft. */
  setDraft: (place: ChatPlace, text: string) => void;
  /** Puts the text of a message that was not sent in front of the draft, as the kit composer does. */
  returnToDraft: (place: ChatPlace, text: string) => void;
};

function draftKey({ tag, task, chat }: ChatPlace): string {
  return `${tag}/${task}/${String(chat)}`;
}

// Not persisted: a restart of the app removes the drafts.
export const useChatDraftStore = create<ChatDraftState>((set, get) => ({
  drafts: new Map(),
  setDraft: (place, text) => {
    const key = draftKey(place);
    set((state) => {
      if ((state.drafts.get(key) ?? "") === text) {
        return state;
      }
      const drafts = new Map(state.drafts);
      if (text === "") {
        drafts.delete(key);
      } else {
        drafts.set(key, text);
      }
      return { drafts };
    });
  },
  returnToDraft: (place, text) => {
    get().setDraft(place, [text, chatDraft(place)].filter(Boolean).join("\n"));
  },
}));

export function chatDraft(place: ChatPlace): string {
  return useChatDraftStore.getState().drafts.get(draftKey(place)) ?? "";
}

/** Calls `listener` with the draft of the chat each time it changes. */
export function subscribeChatDraft(place: ChatPlace, listener: (text: string) => void): () => void {
  const key = draftKey(place);
  return useChatDraftStore.subscribe((state, before) => {
    const text = state.drafts.get(key) ?? "";
    if (text !== (before.drafts.get(key) ?? "")) {
      listener(text);
    }
  });
}
