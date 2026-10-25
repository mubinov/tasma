import type { Chat, FeedEvent, TransportReply } from "@tasma/protocol";
import { act } from "@testing-library/react";
import { expect, vi } from "vitest";
import { chatPath, chatRecord, stubChatLog } from "./chat-daemon";
import { heldBack, successReply } from "./helpers";
import { TASK_PATH, daemon } from "./task-screen-fixtures";

export const CHATS_PATH = `${TASK_PATH}/chats`;

function chatEvent({ chat: number, step, state }: Chat): FeedEvent {
  return { kind: "chat", tag: "SAGA", task: "SAGA-3", chat: number, step, state } as FeedEvent;
}

/**
 * The task page's daemon with these chats, the record of each chat and a held
 * read of its log, and a feed that holds each read after the first until the
 * test sends events.
 */
export function stubTaskChats(
  chats: Chat[],
  replies: Record<string, TransportReply | Promise<TransportReply>> = {},
) {
  const log = stubChatLog({
    ...daemon().replies,
    [CHATS_PATH]: successReply(chats),
    "/events": successReply({ cursor: "c0", events: [] }),
    ...replies,
  });
  let count = 0;
  let held = hold(0);

  function hold(index: number): (reply: TransportReply) => void {
    const { reply, answer } = heldBack();
    log.replies[`/events?after=c${String(index)}`] = reply;
    return answer;
  }

  function records(next: readonly Chat[]): void {
    for (const one of next) {
      log.replies[chatPath(one.chat)] = successReply(one);
      // `stubChatLog` holds the log of the default chat already.
      if (one.chat !== chatRecord().chat) {
        log.hold(0, one.chat);
      }
    }
  }

  /** The feed sends these events, and the test waits for the read after them. */
  async function send(events: FeedEvent[]): Promise<void> {
    const current = held;
    count += 1;
    held = hold(count);
    await act(async () => {
      current(successReply({ cursor: `c${String(count)}`, events }));
      await vi.waitFor(() => {
        expect(log.paths).toContain(`/events?after=c${String(count)}`);
      });
    });
  }

  records(chats);

  return {
    ...log,
    records,
    send,
    /** The number of starts that the daemon was sent. */
    starts(): number {
      return log.requests.filter(({ method, path }) => method === "POST" && path === CHATS_PATH).length;
    },
    /** The daemon now has these chats, and the feed sends the event of the last one. */
    async change(next: Chat[]): Promise<void> {
      records(next);
      log.replies[CHATS_PATH] = successReply(next);
      await send([chatEvent(next.at(-1)!)]);
    },
  };
}

export type TaskChatsStub = ReturnType<typeof stubTaskChats>;
