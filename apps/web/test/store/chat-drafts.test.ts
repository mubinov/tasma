import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatDraft, NEW_CHAT_DRAFT, subscribeChatDraft, useChatDraftStore } from "../../src/store/chat-drafts";

const PLACE = { tag: "SAGA", task: "SAGA-3", chat: 2 };

const OTHER = { ...PLACE, chat: 3 };

beforeEach(() => {
  useChatDraftStore.setState({ drafts: new Map() });
});

describe("useChatDraftStore", () => {
  it("keeps one draft for each chat", () => {
    useChatDraftStore.getState().setDraft(PLACE, "Build the app.");
    useChatDraftStore.getState().setDraft(OTHER, "Review the parser.");
    useChatDraftStore.getState().setDraft({ ...PLACE, task: "SAGA-4" }, "Fix the lexer.");

    expect(chatDraft(PLACE)).toBe("Build the app.");
    expect(chatDraft(OTHER)).toBe("Review the parser.");
    expect(chatDraft({ ...PLACE, task: "SAGA-4" })).toBe("Fix the lexer.");
  });

  it("keeps the draft of a chat of a project apart from the draft of the task chat with the same number", () => {
    const project = { ...PLACE, task: undefined };

    useChatDraftStore.getState().setDraft(PLACE, "Build the app.");
    useChatDraftStore.getState().setDraft(project, "Plan the release.");

    expect(chatDraft(PLACE)).toBe("Build the app.");
    expect(chatDraft(project)).toBe("Plan the release.");
    expect([...useChatDraftStore.getState().drafts.keys()]).toEqual(["SAGA/SAGA-3/2", "SAGA/2"]);
  });

  it("gives an empty draft for a chat with none", () => {
    expect(chatDraft(PLACE)).toBe("");
  });

  it("removes the key of an empty draft", () => {
    useChatDraftStore.getState().setDraft(PLACE, "Build");
    useChatDraftStore.getState().setDraft(PLACE, "");

    expect(useChatDraftStore.getState().drafts.size).toBe(0);
  });

  it("changes no state for the same text", () => {
    useChatDraftStore.getState().setDraft(PLACE, "Build");
    const before = useChatDraftStore.getState();

    useChatDraftStore.getState().setDraft(PLACE, "Build");
    useChatDraftStore.getState().setDraft(OTHER, "");

    expect(useChatDraftStore.getState()).toBe(before);
  });

  it("puts a returned text in front of the draft, on a line of its own", () => {
    useChatDraftStore.getState().returnToDraft(PLACE, "Build the app.");
    expect(chatDraft(PLACE)).toBe("Build the app.");

    useChatDraftStore.getState().setDraft(OTHER, "Then test it.");
    useChatDraftStore.getState().returnToDraft(OTHER, "Build the app.");
    expect(chatDraft(OTHER)).toBe("Build the app.\nThen test it.");
  });

  it("keeps the New chat draft apart from the draft of each chat", () => {
    useChatDraftStore.getState().setDraft(NEW_CHAT_DRAFT, "Plan the release.");
    useChatDraftStore.getState().setDraft(PLACE, "Build the app.");

    expect(chatDraft(NEW_CHAT_DRAFT)).toBe("Plan the release.");
    expect(chatDraft(PLACE)).toBe("Build the app.");
    expect([...useChatDraftStore.getState().drafts.keys()]).toEqual(["new-chat", "SAGA/SAGA-3/2"]);
  });

  it("puts a returned text in front of the New chat draft", () => {
    useChatDraftStore.getState().setDraft(NEW_CHAT_DRAFT, "Then test it.");

    useChatDraftStore.getState().returnToDraft(NEW_CHAT_DRAFT, "Build the app.");

    expect(chatDraft(NEW_CHAT_DRAFT)).toBe("Build the app.\nThen test it.");
  });
});

describe("subscribeChatDraft", () => {
  it("gives each new draft of its chat, and nothing for another chat or the same text", () => {
    const listener = vi.fn<(text: string) => void>();
    const stop = subscribeChatDraft(PLACE, listener);

    useChatDraftStore.getState().setDraft(PLACE, "Build");
    useChatDraftStore.getState().setDraft(OTHER, "Review");
    useChatDraftStore.getState().setDraft(PLACE, "Build");
    useChatDraftStore.getState().setDraft(PLACE, "");
    stop();
    useChatDraftStore.getState().setDraft(PLACE, "Test");

    expect(listener.mock.calls).toEqual([["Build"], [""]]);
  });

  it("gives each new New chat draft, and nothing for a chat", () => {
    const listener = vi.fn<(text: string) => void>();
    const stop = subscribeChatDraft(NEW_CHAT_DRAFT, listener);

    useChatDraftStore.getState().setDraft(NEW_CHAT_DRAFT, "Plan");
    useChatDraftStore.getState().setDraft(PLACE, "Build");
    stop();

    expect(listener.mock.calls).toEqual([["Plan"]]);
  });
});
