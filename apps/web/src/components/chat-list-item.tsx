import { Link } from "@tanstack/react-router";
import type { ChatListItem as Item } from "@tasma/protocol";
import type { ReactNode } from "react";
import { chatKey } from "../lib/chat-list-announcements";
import { chatStateText } from "../lib/chat-messages";
import { fullChatTime, shortChatTime } from "../lib/chat-time";
import { StateMark } from "./chat-panel";

type ChatListItemProps = {
  item: Item;
  /** The chat the address opens. */
  selected: boolean;
  now: number;
  tabIndex: number | undefined;
};

const SELECTED_CLASS = "bg-surface-2 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-text";

export function ChatListItem({ item, selected, now, tabIndex }: ChatListItemProps): ReactNode {
  const { task, title, chat, step, created, status } = item;
  const label = [`${task} ${title}`, step, ...(status === undefined ? [] : [chatStateText(status)]), fullChatTime(created)];

  return (
    <Link
      to="/"
      search={{ task, chat: String(chat) }}
      replace
      resetScroll={false}
      tabIndex={tabIndex}
      aria-label={label.join(", ")}
      aria-current={selected ? "page" : undefined}
      data-chat-key={chatKey(item)}
      className={`relative block border-b border-line py-2.5 pr-3 pl-3.5 text-text hover:bg-surface-2 focus-visible:-outline-offset-2 ${selected ? SELECTED_CLASS : ""}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 font-mono text-xs text-dim wrap-anywhere">{task}</span>
        <time dateTime={created} className="ml-auto shrink-0 text-xs text-dim">{shortChatTime(created, now)}</time>
      </span>
      <span className="mt-0.5 block truncate text-sm font-medium text-text">{title}</span>
      <span className="mt-0.5 flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-xs text-subtle">{step}</span>
        {status !== undefined && (
          <span className="ml-auto flex shrink-0 text-xs">
            <StateMark status={status} />
          </span>
        )}
      </span>
    </Link>
  );
}
