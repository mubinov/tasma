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

/**
 * What a new result of the list of all chats announces after the last one: an
 * item, not the open chat, that is now "Needs you" or "Failed" and was in the
 * last result with another state, or is newer than every item of its group in
 * the last result. An item of an older page is neither. `complete` tells that
 * the last result held all pages; an empty last result is complete.
 *
 * With no active item in the last result, no page held one, so every "Needs
 * you" item is new. With no other item, a "Failed" item can come from a page
 * the last result did not load, so it is new only after a complete result.
 */
export function chatListAnnouncements(
  before: readonly ChatListItem[],
  after: readonly ChatListItem[],
  open: OpenChat | undefined,
  complete = false,
): string[] {
  const newestActive = before.find((one) => isActiveChat(one.status));
  const newestOther = before.find((one) => !isActiveChat(one.status));
  const found: { task: string; state: Announced }[] = [];

  function isNew(item: ChatListItem): boolean {
    const active = isActiveChat(item.status);
    const newest = active ? newestActive : newestOther;
    if (newest === undefined) {
      return active || complete || before.length === 0;
    }
    return compareChats(item, newest) < 0;
  }

  for (const item of after) {
    const state = announcedState(item);
    if (state === null || (open !== undefined && sameChat(item, open))) {
      continue;
    }

    const last = before.find((one) => sameChat(one, item));
    const changed = last === undefined ? isNew(item) : announcedState(last) !== state;
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
