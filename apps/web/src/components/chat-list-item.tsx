import { Link } from "@tanstack/react-router";
import type { ChatListItem as Item } from "@tasma/protocol";
import type { ReactNode } from "react";
import { chatKey } from "../lib/chat-list-announcements";
import { chatStateText } from "../lib/chat-messages";
import { fullChatTime, shortChatTime } from "../lib/chat-time";
import { matchRanges } from "../lib/match-ranges";
import { StateMark } from "./chat-panel";

type ChatListItemProps = {
  item: Item;
  /** The chat the address opens. */
  selected: boolean;
  now: number;
  tabIndex: number | undefined;
  /** The words of the search, which the id, the title and the step mark. */
  words: readonly string[];
};

const SELECTED_CLASS = "bg-surface-2 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-text";

/** The look of `::highlight(task-find)` in `global.css`, the find matches of the task page. */
const MARK_CLASS = "bg-match text-text underline decoration-dotted decoration-1 decoration-text";

function Marked({ text, words }: { text: string; words: readonly string[] }): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;

  for (const { start, end } of matchRanges(text, words)) {
    parts.push(text.slice(at, start), <mark key={start} className={MARK_CLASS}>{text.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(text.slice(at));

  return parts;
}

export function ChatListItem({ item, selected, now, tabIndex, words }: ChatListItemProps): ReactNode {
  const { task, title, chat, step, created, status } = item;
  const label = [`${task} ${title}`, step, ...(status === undefined ? [] : [chatStateText(status)]), fullChatTime(created)];

  return (
    <Link
      from="/"
      to="/"
      search={(previous) => ({ ...previous, task, chat: String(chat) })}
      replace
      resetScroll={false}
      tabIndex={tabIndex}
      aria-label={label.join(", ")}
      aria-current={selected ? "page" : undefined}
      data-chat-key={chatKey(item)}
      className={`relative block border-b border-line py-2.5 pr-3 pl-3.5 text-text hover:bg-surface-2 focus-visible:-outline-offset-2 ${selected ? SELECTED_CLASS : ""}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 font-mono text-xs text-dim wrap-anywhere"><Marked text={task} words={words} /></span>
        <time dateTime={created} className="ml-auto shrink-0 text-xs text-dim">{shortChatTime(created, now)}</time>
      </span>
      <span className="mt-0.5 block truncate text-sm font-medium text-text"><Marked text={title} words={words} /></span>
      <span className="mt-0.5 flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-xs text-subtle"><Marked text={step} words={words} /></span>
        {status !== undefined && (
          <span className="ml-auto flex shrink-0 text-xs">
            <StateMark status={status} />
          </span>
        )}
      </span>
    </Link>
  );
}
