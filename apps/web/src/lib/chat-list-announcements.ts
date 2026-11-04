import { isActiveChat, type ChatListItem, type ChatListPage } from "@tasma/protocol";
import { idNumber } from "./board";

/** The chat that the dashboard shows. */
export type OpenChat = { task: string; chat: number };

type Announced = "needs-you" | "failed";

/** More announcements than this from one result give their counts in their place. */
const MOST_ONE_BY_ONE = 3;

function byText(one: string, other: string): number {
  return Number(one > other) - Number(one < other);
}

/**
 * The order of the daemon inside one group of the list: newest first, then the
 * tag A to Z, the task number high first, the task id A to Z, the chat number
 * high first.
 */
function compareChats(one: ChatListItem, other: ChatListItem): number {
  return Date.parse(other.created) - Date.parse(one.created)
    || byText(one.tag, other.tag)
    || idNumber(other.task) - idNumber(one.task)
    || byText(one.task, other.task)
    || other.chat - one.chat;
}

export function sameChat(one: OpenChat, other: OpenChat): boolean {
  return one.task === other.task && one.chat === other.chat;
}

/** The identity of a chat in the list. */
export function chatKey({ task, chat }: OpenChat): string {
  return `${task}/${String(chat)}`;
}

/** The items of all loaded pages, each chat one time, at its first place. */
export function chatListItems(pages: readonly { data: ChatListPage }[]): ChatListItem[] {
  const items = new Map<string, ChatListItem>();
  for (const item of pages.flatMap((page) => page.data.items)) {
    const key = chatKey(item);
    if (!items.has(key)) {
      items.set(key, item);
    }
  }
  return [...items.values()];
}

function announcedState(item: ChatListItem): Announced | null {
  const state = item.status?.state;
  return state === "needs-you" || state === "failed" ? state : null;
}

/** What a new search or filter result announces: its number of chats. */
export function resultCountWords(total: number): string {
  if (total === 0) {
    return "No chats";
  }
  return total === 1 ? "1 chat" : `${String(total)} chats`;
}

function countWords(count: number, state: Announced): string {
  if (state === "needs-you") {
    return count === 1 ? "1 chat needs you" : `${String(count)} chats need you`;
  }
  return count === 1 ? "1 chat failed" : `${String(count)} chats failed`;
}

/** The latest item of each chat that the results of one filter held. */
export type KnownChats = ReadonlyMap<string, ChatListItem>;

/** Chats of two projects can share this key, so it only serves an item whose id is not known. */
function keyAcrossRename({ tag, task, chat, created, title }: ChatListItem): string {
  return `${task.slice(tag.length)}/${String(chat)}/${created}/${title}`;
}

/**
 * An id with another time names another chat: a new project can take the tag of
 * a renamed or deleted project, and its numbers start again.
 */
function lastItem(item: ChatListItem, known: KnownChats): ChatListItem | undefined {
  const sameId = known.get(chatKey(item));
  return sameId?.created === item.created ? sameId : known.get(keyAcrossRename(item));
}

/**
 * A chat stays only under its latest id and key, so a rename back reads its
 * latest state. An id that `items` holds is another chat with the same key.
 */
export function knownChats(items: readonly ChatListItem[], known: KnownChats = new Map()): KnownChats {
  const next = new Map(known);
  const held = new Set(items.map(chatKey));
  for (const item of items) {
    const last = lastItem(item, known);
    if (last !== undefined) {
      if (!held.has(chatKey(last))) {
        next.delete(chatKey(last));
      }
      next.delete(keyAcrossRename(last));
    }
    next.set(chatKey(item), item);
    next.set(keyAcrossRename(item), item);
  }
  return next;
}

/**
 * What a new result of the list of all chats announces after the last one: an
 * item, not the open chat, that is now "Needs you" or "Failed" and that `known`
 * holds with another state. A chat that a failed read left out of the last
 * result, or that a rename gave a new id, keeps its state in `known`.
 *
 * The daemon sorts the active chats first, so a last result that is empty or
 * holds an item outside Active held every active chat. An item that `known`
 * does not hold is then a new chat, got its state on a page that the result did
 * not load, or now matches the filter, and is announced. A last result of active
 * items alone can end before an older page, so only an item newer than the
 * newest of them is announced.
 */
export function chatListAnnouncements(
  before: readonly ChatListItem[],
  after: readonly ChatListItem[],
  open: OpenChat | undefined,
  known: KnownChats = knownChats(before),
): string[] {
  const newest = before[0];
  const reachedOther = before.some((one) => !isActiveChat(one.status));
  const found: { task: string; state: Announced }[] = [];

  function changedOutOfView(item: ChatListItem): boolean {
    return newest === undefined || reachedOther || compareChats(item, newest) < 0;
  }

  for (const item of after) {
    const state = announcedState(item);
    if (state === null || (open !== undefined && sameChat(item, open))) {
      continue;
    }

    const last = lastItem(item, known);
    const changed = last === undefined ? changedOutOfView(item) : announcedState(last) !== state;
    if (changed) {
      found.push({ task: item.task, state });
    }
  }

  if (found.length <= MOST_ONE_BY_ONE) {
    return found.map(({ task, state }) => (state === "needs-you" ? `${task} needs you` : `${task} failed`));
  }

  const counts = (["needs-you", "failed"] as const).map((state) => [state, found.filter((one) => one.state === state).length] as const);
  return counts.filter(([, count]) => count > 0).map(([state, count]) => countWords(count, state));
}
