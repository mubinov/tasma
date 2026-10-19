// The routes over the chats of one task: the list, one chat, and a long-poll
// read of the log of one chat after a cursor.

import { routes } from "@tasma/protocol";
import type { Chat, ChatEventsReply, Success } from "@tasma/protocol";
import type { RouteEntry } from "../http/router.js";
import { assertNoQuery, readChatEventsQuery } from "../tasks/filter.js";
import type { ChatRegistry } from "./registry.js";

/** The most bytes of entries in one reply. A reply always holds at least one entry, however large. */
const CHAT_REPLY_BYTES = 1024 * 1024;

const CHAT_NUMBER = /^[1-9]\d*$/;

/** The chat a path names. Any other text is 0, which `chats.get` refuses as no chat. */
function chatOf(segment: string): number {
  const chat = Number(segment);
  return CHAT_NUMBER.test(segment) && Number.isSafeInteger(chat) ? chat : 0;
}

/**
 * The entries after `after`, or a hold until the next one. The check of the
 * `seq` and the start of the wait run in one synchronous step, so an append
 * between them is never lost.
 */
async function readAfter(
  chats: ChatRegistry,
  place: { tag: string; task: string; chat: number },
  after: number,
): Promise<ChatEventsReply> {
  let live = await chats.get(place.tag, place.task, place.chat);
  if (after === live.chat.seq) {
    await live.wait();
    live = await chats.get(place.tag, place.task, place.chat);
  }
  const { seq } = live.chat;
  if (after > seq) return { reset: true, cursor: 0 };
  if (after === seq) return { cursor: after, entries: [] };
  // Never empty: the log gives at least one entry where one exists.
  const entries = await live.read(after, CHAT_REPLY_BYTES);
  return { cursor: entries.at(-1)!.seq, entries };
}

export function chatRoutes(chats: ChatRegistry): RouteEntry[] {
  return [
    {
      route: routes.listChats,
      handler: async (request): Promise<Success<Chat[]>> => {
        assertNoQuery(request.query);
        const listed = await chats.list(request.params.project!, request.params.id!);
        return { data: listed.chats.map((live) => live.chat), diagnostics: listed.diagnostics };
      },
    },
    {
      route: routes.readChat,
      handler: async (request): Promise<Success<Chat>> => {
        assertNoQuery(request.query);
        const live = await chats.get(request.params.project!, request.params.id!, chatOf(request.params.chat!));
        return { data: live.chat, diagnostics: live.diagnostics };
      },
    },
    {
      route: routes.readChatEvents,
      // No diagnostics, so a long-poll loop does not get the same finding at each reply.
      handler: async (request): Promise<Success<ChatEventsReply>> => {
        const { after } = readChatEventsQuery(request.query);
        const place = { tag: request.params.project!, task: request.params.id!, chat: chatOf(request.params.chat!) };
        return { data: await readAfter(chats, place, after), diagnostics: [] };
      },
    },
  ];
}
