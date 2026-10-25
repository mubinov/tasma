import type { Chat, FeedEvent, TransportReply } from "@tasma/protocol";
import { chatPath, chatRecord, stubChatLog } from "./chat-daemon";
import { stubFeed, successReply } from "./helpers";
import { TASK_PATH, daemon } from "./task-screen-fixtures";

export const CHATS_PATH = `${TASK_PATH}/chats`;

function chatEvent({ chat: number, step, state }: Chat): FeedEvent {
  return { kind: "chat", tag: "SAGA", task: "SAGA-3", chat: number, step, state } as FeedEvent;
}

/**
 * The task page's daemon with these chats, the record of each chat and a held
 * read of its log, and the feed of `stubFeed`.
 */
export function stubTaskChats(
  chats: Chat[],
  replies: Record<string, TransportReply | Promise<TransportReply>> = {},
) {
  const log = stubChatLog({
    ...daemon().replies,
    [CHATS_PATH]: successReply(chats),
    ...replies,
  });
  const feed = stubFeed(log);

  function records(next: readonly Chat[]): void {
    for (const one of next) {
      log.replies[chatPath(one.chat)] = successReply(one);
      // `stubChatLog` holds the log of the default chat already.
      if (one.chat !== chatRecord().chat) {
        log.hold(0, one.chat);
      }
    }
  }

  records(chats);

  return {
    ...log,
    records,
    mount: feed.mount,
    send: feed.send,
    /** The number of starts that the daemon was sent. */
    starts(): number {
      return log.requests.filter(({ method, path }) => method === "POST" && path === CHATS_PATH).length;
    },
    /** The daemon now has these chats, and the feed sends the event of the last one. */
    async change(next: Chat[]): Promise<void> {
      records(next);
      log.replies[CHATS_PATH] = successReply(next);
      await feed.send([chatEvent(next.at(-1)!)]);
    },
  };
}

export type TaskChatsStub = ReturnType<typeof stubTaskChats>;
