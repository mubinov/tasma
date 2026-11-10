import { create } from "zustand";
import { chatPlaceText, type ChatPlace } from "../api/queries";

/** The place of the text of the New chat view, which has no chat yet. A key of a chat holds "/". */
export const NEW_CHAT_DRAFT = "new-chat";

export type ChatDraftPlace = ChatPlace | typeof NEW_CHAT_DRAFT;

type ChatDraftState = {
  /** The text in the composer of each place, by `draftKey`. */
  drafts: ReadonlyMap<string, string>;
  /** An empty text removes the draft. */
  setDraft: (place: ChatDraftPlace, text: string) => void;
  /** Puts the text of a message that was not sent in front of the draft, as the kit composer does. */
  returnToDraft: (place: ChatDraftPlace, text: string) => void;
};

function draftKey(place: ChatDraftPlace): string {
  return place === NEW_CHAT_DRAFT ? NEW_CHAT_DRAFT : chatPlaceText(place);
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

export function chatDraft(place: ChatDraftPlace): string {
  return useChatDraftStore.getState().drafts.get(draftKey(place)) ?? "";
}

/** Calls `listener` with the draft of the place each time it changes. */
export function subscribeChatDraft(place: ChatDraftPlace, listener: (text: string) => void): () => void {
  const key = draftKey(place);
  return useChatDraftStore.subscribe((state, before) => {
    const text = state.drafts.get(key) ?? "";
    if (text !== (before.drafts.get(key) ?? "")) {
      listener(text);
    }
  });
}
