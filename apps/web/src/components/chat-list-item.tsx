import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { Link } from "@tanstack/react-router";
import type { AnyChatListItem as Item } from "@tasma/protocol";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { usePendingChatInactive } from "../api/mutations";
import type { ChatPlace } from "../api/queries";
import { chatKey, markableChat } from "../lib/chat-list-announcements";
import { chatStateText } from "../lib/chat-messages";
import { fullChatTime, shortChatTime } from "../lib/chat-time";
import { BellSlashIcon } from "../lib/icons";
import { matchRanges } from "../lib/match-ranges";
import { useChatWrites } from "../lib/use-chat-writes";
import { StateMark } from "./chat-panel";
import { MENU_ITEM_CLASS, POPUP_CLASS, POSITIONER_CLASS, SELECTED_ROW_CLASS } from "./control-classes";

type ChatListItemProps = {
  item: Item;
  /** The chat the address opens. */
  selected: boolean;
  now: number;
  tabIndex: number | undefined;
  /** The words of the search, which the id or the tag, the title and the step mark. */
  words: readonly string[];
  /** The heading of the group that starts at the item, above it. */
  band?: Band;
};

/** The heading of a group of the list: its name and its count of chats on all pages. */
export type Band = { name: "Active" | "Other chats"; count: number };

/**
 * The scroll margin of an item, so a focus that scrolls the item into view keeps it clear of the scroll-to-top button
 * of the list: the `top-2` of the button, its `size-9` and 8px below it.
 */
export const ROW_CLASS = "scroll-mt-13";

/**
 * The scroll margin of an item under a band, so a focus that scrolls the item into view shows the band too, clear of
 * the button. It is the height of `GroupBand`, the line of `text-xs` and the `py-2`, and the margin of `ROW_CLASS`.
 */
export const BANDED_ROW_CLASS = "scroll-mt-[calc(var(--text-xs--line-height)+--spacing(4)+--spacing(13))]";

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

type MarkInactiveItemProps = {
  place: ChatPlace;
  actionsRef: RefObject<Menu.Root.Actions | null>;
  /** The right-click menu has no name, so there it names the chat. */
  label?: string;
};

export function MarkInactiveItem({ place, actionsRef, label }: MarkInactiveItemProps): ReactNode {
  const { markInactive } = useChatWrites(place);

  return (
    <Menu.Item
      aria-label={label}
      onClick={() => {
        // Base UI returns the focus when the popup unmounts, after its exit transition, and the mark can take the
        // trigger away before that. A controlled root mounts the popup again unless the close commits first.
        // eslint-disable-next-line @eslint-react/dom-no-flush-sync -- the close must commit before the unmount
        flushSync(() => {
          actionsRef.current?.close();
        });
        actionsRef.current?.unmount();
        void markInactive();
      }}
      className={MENU_ITEM_CLASS}
    >
      <BellSlashIcon size={14} aria-hidden="true" className="shrink-0" />
      Mark as not active
    </Menu.Item>
  );
}

export function ChatListItem({ item, selected, now, tabIndex, words, band }: ChatListItemProps): ReactNode {
  const { tag, title, chat, created, status } = item;
  const ofTask = "task" in item;
  const owner = ofTask ? item.task : tag;
  const place: ChatPlace = { tag, task: ofTask ? item.task : undefined, chat };
  const marking = usePendingChatInactive(place);
  const markable = markableChat(item) && !marking;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuActionsRef = useRef<ContextMenu.Root.Actions>(null);
  const label = [
    `${owner} ${title}`,
    ofTask ? item.step : `Chat ${String(chat)}`,
    ...(status === undefined ? [] : [chatStateText(status)]),
    fullChatTime(created),
  ];

  // A disabled root does not dismiss its open popup.
  if (menuOpen && !markable) {
    setMenuOpen(false);
  }

  return (
    <>
      {band !== undefined && <GroupBand {...band} />}
      {/* Disabled, the root leaves `contextmenu` alone, so WebKit shows its own menu. */}
      <ContextMenu.Root
        actionsRef={menuActionsRef}
        highlightItemOnHover={false}
        disabled={!markable}
        open={menuOpen}
        onOpenChange={(next) => {
          setMenuOpen(next);
        }}
      >
        <ContextMenu.Trigger
          render={(
            <Link
              from="/"
              to="/"
              search={(previous) => ({
                ...previous,
                ...(ofTask ? { task: item.task, tag: undefined } : { task: undefined, tag }),
                chat: String(chat),
              })}
              replace
              resetScroll={false}
              tabIndex={tabIndex}
              aria-label={label.join(", ")}
              aria-current={selected ? "page" : undefined}
              data-chat-key={chatKey(item)}
              onClick={(event) => {
                // A Control-click is a right click on macOS, and the link would follow its address.
                if (event.ctrlKey) {
                  event.preventDefault();
                }
              }}
              className={`relative block border-b border-line py-2.5 pr-3 pl-3.5 text-text hover:bg-surface-2 focus-visible:-outline-offset-2 data-[popup-open]:bg-surface-2 data-[popup-open]:inset-ring-1 data-[popup-open]:inset-ring-graphic ${band === undefined ? ROW_CLASS : BANDED_ROW_CLASS} ${selected ? SELECTED_ROW_CLASS : ""}`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 font-mono text-xs text-dim wrap-anywhere"><Marked text={owner} words={words} /></span>
                <time dateTime={created} className="ml-auto shrink-0 text-xs text-dim">{shortChatTime(created, now)}</time>
              </span>
              <span className="mt-0.5 block truncate text-sm font-medium text-text"><Marked text={title} words={words} /></span>
              {/* The minimum height keeps a row with no step and no mark at three lines. */}
              <span className="mt-0.5 flex min-h-(--text-xs--line-height) min-w-0 items-center gap-2">
                {ofTask && <span className="min-w-0 truncate text-xs text-subtle"><Marked text={item.step} words={words} /></span>}
                {status !== undefined && (
                  <span className="ml-auto flex shrink-0 text-xs">
                    <StateMark status={status} />
                  </span>
                )}
              </span>
            </Link>
          )}
        />
        <ContextMenu.Portal>
          <ContextMenu.Positioner className={POSITIONER_CLASS}>
            <ContextMenu.Popup className={`min-w-52 ${POPUP_CLASS}`}>
              <MarkInactiveItem
                place={place}
                actionsRef={menuActionsRef}
                label={`Mark as not active, chat ${String(chat)} of ${owner}`}
              />
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </>
  );
}
