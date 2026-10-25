import type { Chat, ChatState } from "@tasma/protocol";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  nextChatAnnouncement,
  useChatAnnouncements,
  type ChatAnnouncementsInput,
  type KeptChats,
} from "../../src/lib/use-chat-announcements";
import { useNoticeStore } from "../../src/store/notices";
import { chatRecord } from "../chat-daemon";
import { frame } from "../setup/notice-store";

const BASE: ChatAnnouncementsInput = { chats: [], fetching: false, stateful: true, openChat: undefined, quiet: false };

afterEach(() => {
  cleanup();
});

function chat(number: number, state: ChatState = "working", step = "build"): Chat {
  const status = state === "continued-outside" ? { state, where: "vscode" } : { state };
  return chatRecord({ chat: number, step, ...status } as Partial<Chat>);
}

/** The words of each render of these inputs over the base inputs. The first render is the mount. */
function spoken(...renders: Partial<ChatAnnouncementsInput>[]): (string | null)[] {
  let kept: KeptChats | null = null;

  return renders.map((input) => {
    const next = nextChatAnnouncement(kept, { ...BASE, ...input });
    kept = next.kept;
    return next.words;
  });
}

describe("nextChatAnnouncement", () => {
  it("announces nothing at mount, also for a newest chat that needs you", () => {
    expect(spoken({ chats: [chat(1), chat(2, "needs-you")] })).toEqual([null]);
  });

  it("announces the newest chat that changes to needs you, and then to failed", () => {
    expect(spoken(
      { chats: [chat(1)] },
      { chats: [chat(1, "needs-you")] },
      { chats: [chat(1, "failed")] },
    )).toEqual([null, "The build chat needs you.", "The build chat failed."]);
  });

  it("names the step of the chat", () => {
    expect(spoken(
      { chats: [chat(1)] },
      { chats: [chat(1), chat(2, "failed", "review")] },
    )).toEqual([null, "The review chat failed."]);
  });

  it("announces the first chat of a task that comes in failed, one time", () => {
    expect(spoken(
      { chats: [] },
      { chats: [chat(1, "failed")] },
      { chats: [chat(1, "failed")] },
    )).toEqual([null, "The build chat failed.", null]);
  });

  it("announces a new newest chat that comes in needing you", () => {
    expect(spoken(
      { chats: [chat(1, "failed")] },
      { chats: [chat(1, "failed"), chat(2, "needs-you")] },
    )).toEqual([null, "The build chat needs you."]);
  });

  it("announces nothing for a change to working or to continued outside, nor for a new working chat", () => {
    expect(spoken(
      { chats: [chat(1, "needs-you")] },
      { chats: [chat(1)] },
      { chats: [chat(1, "continued-outside")] },
      { chats: [chat(1, "continued-outside"), chat(2)] },
    )).toEqual([null, null, null, null]);
  });

  it("announces nothing for a change of an older chat", () => {
    expect(spoken(
      { chats: [chat(1), chat(2)] },
      { chats: [chat(1, "needs-you"), chat(2)] },
    )).toEqual([null, null]);
  });

  it("announces nothing for the open chat, nor when that chat closes in the same state", () => {
    expect(spoken(
      { chats: [chat(1)], openChat: 1 },
      { chats: [chat(1, "needs-you")], openChat: 1 },
      { chats: [chat(1, "needs-you")] },
    )).toEqual([null, null, null]);
  });

  it("announces nothing while the status of the task is final", () => {
    expect(spoken(
      { chats: [chat(1)], stateful: false },
      { chats: [chat(1, "failed")], stateful: false },
    )).toEqual([null, null]);
  });

  it("waits for the read that runs at mount, and counts from the list it brings", () => {
    expect(spoken(
      { chats: [chat(1)], fetching: true },
      { chats: [chat(1, "needs-you")] },
      { chats: [chat(1, "failed")] },
    )).toEqual([null, null, "The build chat failed."]);
  });

  it("announces a change while a later read runs", () => {
    expect(spoken(
      { chats: [chat(1)] },
      { chats: [chat(1, "needs-you")], fetching: true },
    )).toEqual([null, "The build chat needs you."]);
  });
});

describe("quiet", () => {
  it("holds a new chat that comes in failed while quiet, and announces it when quiet ends", () => {
    expect(spoken(
      { chats: [chat(3)] },
      { chats: [chat(3)], quiet: true },
      { chats: [chat(3), chat(4, "failed")], quiet: true },
      { chats: [chat(3), chat(4, "failed")] },
      { chats: [chat(3), chat(4, "failed")] },
    )).toEqual([null, null, null, "The build chat failed.", null]);
  });

  it("announces nothing when quiet ends on a held chat that is seen in its state", () => {
    const seen = { chat: 4, state: "failed" } as const;

    expect(spoken(
      { chats: [chat(3)] },
      { chats: [chat(3), chat(4, "failed")], quiet: true },
      { chats: [chat(3), chat(4, "failed")], seen },
    )).toEqual([null, null, null]);
  });

  it("announces nothing when quiet ends on a held chat that is open or working", () => {
    expect(spoken(
      { chats: [chat(3)] },
      { chats: [chat(3), chat(4, "failed")], quiet: true },
      { chats: [chat(3), chat(4, "failed")], openChat: 4 },
    )).toEqual([null, null, null]);
    expect(spoken(
      { chats: [chat(3)] },
      { chats: [chat(3), chat(4)], quiet: true },
      { chats: [chat(3), chat(4)] },
    )).toEqual([null, null, null]);
  });

  it("announces a change of a held chat after quiet ends", () => {
    const seen = { chat: 4, state: "failed" } as const;

    expect(spoken(
      { chats: [chat(3)] },
      { chats: [chat(3), chat(4, "failed")], quiet: true },
      { chats: [chat(3), chat(4, "failed")], seen },
      { chats: [chat(3), chat(4, "needs-you")], seen },
    )).toEqual([null, null, null, "The build chat needs you."]);
  });

  it("holds a new chat that comes in with quiet in the same render", () => {
    expect(spoken(
      { chats: [chat(3)] },
      { chats: [chat(3), chat(4, "failed")], quiet: true },
    )).toEqual([null, null]);
  });

  it("announces the older newest chat that changes while quiet, and not again when quiet ends", () => {
    expect(spoken(
      { chats: [chat(3)], quiet: true },
      { chats: [chat(3, "needs-you")], quiet: true },
      { chats: [chat(3, "needs-you")] },
    )).toEqual([null, "The build chat needs you.", null]);
  });

  it("counts quiet from the mount when it mounts quiet", () => {
    expect(spoken(
      { chats: [chat(3)], quiet: true },
      { chats: [chat(3), chat(4, "failed")], quiet: true },
    )).toEqual([null, null]);
  });

  it("counts quiet from the list of the read that runs at mount", () => {
    expect(spoken(
      { chats: [chat(3)], quiet: true, fetching: true },
      { chats: [chat(3), chat(4, "failed")], quiet: true },
      { chats: [chat(3), chat(4, "failed")] },
    )).toEqual([null, null, null]);
  });

  it("holds the first chat of a task that comes in failed while quiet, until quiet ends", () => {
    expect(spoken(
      { chats: [] },
      { chats: [], quiet: true },
      { chats: [chat(1, "failed")], quiet: true },
      { chats: [chat(1, "failed")] },
    )).toEqual([null, null, null, "The build chat failed."]);
  });

  it("counts a second quiet time from the newest chat when it starts", () => {
    expect(spoken(
      { chats: [chat(3)] },
      { chats: [chat(3)], quiet: true },
      { chats: [chat(3), chat(4)], quiet: true },
      { chats: [chat(3), chat(4)] },
      { chats: [chat(3), chat(4)], quiet: true },
      { chats: [chat(3), chat(4, "failed")], quiet: true },
    )).toEqual([null, null, null, null, null, "The build chat failed."]);
  });
});

describe("seen", () => {
  it("announces a chat that comes in as seen only after it leaves that state and comes back", () => {
    const seen = { chat: 3, state: "failed" } as const;

    expect(spoken(
      { chats: [chat(2)], seen },
      { chats: [chat(2), chat(3, "failed")], seen },
      { chats: [chat(2), chat(3)], seen },
      { chats: [chat(2), chat(3, "failed")], seen },
    )).toEqual([null, null, null, "The build chat failed."]);
  });

  it("announces a chat seen needing you only after it leaves that state and comes back", () => {
    const seen = { chat: 3, state: "needs-you" } as const;

    expect(spoken(
      { chats: [chat(2)], seen },
      { chats: [chat(2), chat(3, "needs-you")], seen },
      { chats: [chat(2), chat(3)], seen },
      { chats: [chat(2), chat(3, "needs-you")], seen },
    )).toEqual([null, null, null, "The build chat needs you."]);
  });

  it("keeps the value while the list still shows the chat in its state before", () => {
    const seen = { chat: 4, state: "failed" } as const;

    expect(spoken(
      { chats: [chat(3)] },
      { chats: [chat(3), chat(4)], quiet: true },
      { chats: [chat(3), chat(4)], seen },
      { chats: [chat(3), chat(4, "failed")], seen },
      { chats: [chat(3), chat(4)], seen },
      { chats: [chat(3), chat(4, "failed")], seen },
    )).toEqual([null, null, null, null, null, "The build chat failed."]);
  });

  it("counts a new value from the first render that gets it", () => {
    expect(spoken(
      { chats: [chat(2)], seen: { chat: 3, state: "failed" } },
      { chats: [chat(2), chat(3, "failed")], seen: { chat: 3, state: "failed" } },
      { chats: [chat(2), chat(3)], seen: { chat: 3, state: "failed" } },
      { chats: [chat(2), chat(3), chat(4, "failed")], seen: { chat: 4, state: "failed" } },
    )).toEqual([null, null, null, null]);
  });
});

describe("useChatAnnouncements", () => {
  function mount(input: Partial<ChatAnnouncementsInput>) {
    const hook = renderHook(
      (props: ChatAnnouncementsInput) => {
        useChatAnnouncements(props);
      },
      { initialProps: { ...BASE, ...input } },
    );

    return (next: Partial<ChatAnnouncementsInput>): void => {
      hook.rerender({ ...BASE, ...next });
    };
  }

  async function announced(): Promise<string[]> {
    await frame();
    return useNoticeStore.getState().announced.map(({ words }) => words);
  }

  it("announces a change, and nothing at mount", async () => {
    const render = mount({ chats: [chat(1, "needs-you")] });
    expect(await announced()).toEqual([]);

    render({ chats: [chat(1, "failed")] });

    expect(await announced()).toEqual(["The build chat failed."]);
  });

  it("counts from the render where the read that runs at mount ends, also when the read brings the same chats", async () => {
    const chats = [chat(1)];
    const render = mount({ chats, fetching: true });

    render({ chats });
    render({ chats: [chat(1, "needs-you")] });

    expect(await announced()).toEqual(["The build chat needs you."]);
  });

  it("announces a held chat at the render where quiet ends, with the same chats", async () => {
    const chats = [chat(3), chat(4, "failed")];
    const render = mount({ chats: [chat(3)] });

    render({ chats, quiet: true });
    render({ chats });

    expect(await announced()).toEqual(["The build chat failed."]);
  });
});
