import { Link } from "@tanstack/react-router";
import type { ChatListItem as Item } from "@tasma/protocol";
import type { ReactNode } from "react";
import { chatKey } from "../lib/chat-list-announcements";
import { chatStateText } from "../lib/chat-messages";
import { fullChatTime, shortChatTime } from "../lib/chat-time";
import { matchRanges } from "../lib/match-ranges";
import { StateMark } from "./chat-panel";
import { SELECTED_ROW_CLASS } from "./control-classes";

type ChatListItemProps = {
  item: Item;
  /** The chat the address opens. */
  selected: boolean;
  now: number;
  tabIndex: number | undefined;
  /** The words of the search, which the id, the title and the step mark. */
  words: readonly string[];
  /** The heading of the group that starts at the item, above it. */
  band?: Band;
};

/** The heading of a group of the list: its name and its count of chats on all pages. */
export type Band = { name: "Active" | "Other chats"; count: number };

/**
 * The scroll margin of an item under a band, so a focus that scrolls the item into view shows the band too. It is
 * the height of `GroupBand`: the line of `text-xs` and the `py-2`.
 */
export const BANDED_ROW_CLASS = "scroll-mt-[calc(var(--text-xs--line-height)+--spacing(4))]";

/** The height of `GroupBand` in pixels, before it is measured. */
export const BAND_HEIGHT = 33;

function GroupBand({ name, count }: Band): ReactNode {
  return (
    <div className="flex items-baseline gap-2 bg-line py-2 pr-3 pl-3.5">
      <h3 className="font-chrome text-xs font-semibold tracking-wider text-subtle uppercase">
        {name}
        {" "}
        <span className="font-normal">
          {count}
          {name === "Active" && <span className="sr-only">{count === 1 ? " chat" : " chats"}</span>}
        </span>
      </h3>
    </div>
  );
}

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

export function ChatListItem({ item, selected, now, tabIndex, words, band }: ChatListItemProps): ReactNode {
  const { task, title, chat, step, created, status } = item;
  const label = [`${task} ${title}`, step, ...(status === undefined ? [] : [chatStateText(status)]), fullChatTime(created)];

  return (
    <>
      {band !== undefined && <GroupBand {...band} />}
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
        className={`relative block border-b border-line py-2.5 pr-3 pl-3.5 text-text hover:bg-surface-2 focus-visible:-outline-offset-2 ${band === undefined ? "" : BANDED_ROW_CLASS} ${selected ? SELECTED_ROW_CLASS : ""}`}
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
    </>
  );
}
