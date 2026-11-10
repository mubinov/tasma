import { Button } from "@base-ui/react/button";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { isActiveChat, type AnyChatListItem as Item, type ProjectSummary } from "@tasma/protocol";
import { useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { chatListQuery, type ChatFilter } from "../api/queries";
import { chatKey, chatListItems, NEW_CHAT_KEY } from "../lib/chat-list-announcements";
import { focusNewChatField } from "../lib/focus-in-view";
import { ArrowUpIcon, PlusIcon } from "../lib/icons";
import { searchWords } from "../lib/match-ranges";
import { filterKey, type FailedFields } from "../lib/use-chat-filter";
import { useFocusLost } from "../lib/use-focus-lost";
import { useMinute } from "../lib/use-minute";
import { usePendingFocus } from "../lib/use-pending-focus";
import { ChatFilterBar } from "./chat-filter-bar";
import { BAND_HEIGHT, ChatListItem, type Band } from "./chat-list-item";
import { BUTTON_CLASS, SCROLL_TO_TOP_CLASS } from "./control-classes";
import { RetryButton } from "./retry-button";
import { VirtualList } from "./virtual-list";

const route = getRouteApi("/");

/** The height of an item with three lines, before it is measured. */
const ITEM_HEIGHT = 79;

type ChatListProps = {
  /** The filter of the items on the screen. */
  filter: ChatFilter;
  /** The filter of the address. */
  requested: ChatFilter;
  projects: readonly ProjectSummary[];
  /** `null` while no read of the requested filter failed. */
  failedFields: FailedFields | null;
  onRetry: () => void;
  openKey: string | undefined;
  /**
   * The chat that "Chats" closed. The mount it comes with focuses its item, or
   * the search field, and calls `onReturned`. `NEW_CHAT_KEY` focuses the
   * New chat button.
   */
  returnKey: string | undefined;
  onReturned: () => void;
  /** The width and the border of the column. */
  className: string;
  /** Called when the column, or the project filter, goes away while the focus is in it. */
  onFocusLost: () => void;
};

function emptyText({ project, q }: ChatFilter): string {
  if (q !== undefined) {
    return `No chats match "${q}".`;
  }
  return project === undefined
    ? "No chats yet. Press New chat to start one. A chat also shows here when an agent starts a step of a task."
    : "This project has no chats.";
}

/**
 * The list of the chats, the active chats first and each group newest first,
 * the older pages it loads, and the filter above it.
 */
export function ChatList({
  filter,
  requested,
  projects,
  failedFields,
  onRetry,
  openKey,
  returnKey,
  onReturned,
  className,
  onFocusLost,
}: ChatListProps): ReactNode {
  const { client } = route.useRouteContext();
  const { data, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError }
    = useSuspenseInfiniteQuery(chatListQuery(client, filter));
  const items = chatListItems(data.pages);
  const listKey = filterKey(filter);
  const returnsToNewChat = returnKey === NEW_CHAT_KEY;
  // The preferred tab stop of the list of the filter at mount, after `returnKey` is cleared.
  const [mountReturn, setMountReturn] = useState({ key: returnsToNewChat ? undefined : returnKey, listKey });

  if (mountReturn.key !== undefined && mountReturn.listKey !== listKey) {
    setMountReturn({ key: undefined, listKey });
  }
  const now = useMinute();
  const columnRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const newChatRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const pendingFocus = usePendingFocus();
  const takeReturnFocus = useEffectEvent(() => {
    if (returnKey === undefined) {
      return;
    }
    if (returnsToNewChat) {
      newChatRef.current?.focus();
    } else if (items.length === 0) {
      inputRef.current?.focus();
    }
    onReturned();
  });

  useFocusLost(columnRef, onFocusLost);

  useLayoutEffect(() => {
    takeReturnFocus();
  }, []);

  function focusSearch(): void {
    pendingFocus(() => {
      inputRef.current?.focus();
    });
  }

  // A next page that cancels a live refresh adds itself to the old pages, and the refresh is lost.
  function retryOlder(): void {
    void fetchNextPage({ cancelRefetch: false });
  }

  // A next page asked for while the list reads gets no page. The end of the read renders the list, and
  // `onEnd` asks again.
  function loadOlderWhenIdle(): void {
    if (hasNextPage && !isFetching && !isFetchNextPageError) {
      retryOlder();
    }
  }

  return (
    <div ref={columnRef} className={`flex h-full min-h-0 flex-col bg-bg ${className}`}>
      <h2 id={headingId} className="sr-only">Chats</h2>
      <ChatFilterBar
        project={requested.project}
        projects={projects}
        failedFields={failedFields}
        onRetry={onRetry}
        inputRef={inputRef}
        onFocusLost={onFocusLost}
        onRetryFocusLost={focusSearch}
      />
      {items.length === 0
        ? <p className="min-h-0 flex-1 p-4 text-sm wrap-anywhere text-subtle">{emptyText(filter)}</p>
        : (
            <ChatRows
              items={items}
              total={data.pages[0]!.data.total}
              active={data.pages[0]!.data.active}
              listKey={listKey}
              words={searchWords(filter.q ?? "")}
              headingId={headingId}
              openKey={openKey}
              mountReturnKey={mountReturn.key}
              focusOnMount={returnKey !== undefined && !returnsToNewChat}
              now={now}
              loadingOlder={isFetchingNextPage}
              olderFailed={isFetchNextPageError && !isFetchingNextPage}
              onRetryOlder={retryOlder}
              onEnd={loadOlderWhenIdle}
              onFocusLost={focusSearch}
            />
          )}
      <div className="shrink-0 border-t border-line bg-bg p-3 pb-[calc(--spacing(3)+var(--notice-stack-height,0px))]">
        <NewChatButton buttonRef={newChatRef} />
      </div>
    </div>
  );
}

/** A button and not a link: it changes the panel of the same screen. */
function NewChatButton({ buttonRef }: { buttonRef: RefObject<HTMLButtonElement | null> }): ReactNode {
  const open = route.useSearch({ select: (search) => search.new === "1" });
  const navigate = useNavigate({ from: "/" });

  return (
    <Button
      ref={buttonRef}
      type="button"
      onClick={() => {
        if (open) {
          focusNewChatField();
          return;
        }
        void navigate({
          search: (previous) => ({ ...previous, task: undefined, tag: undefined, chat: undefined, new: "1" }),
          replace: true,
          resetScroll: false,
        });
      }}
      className={`${BUTTON_CLASS} w-full justify-center`}
    >
      <PlusIcon size={14} aria-hidden="true" />
      New chat
    </Button>
  );
}

type ChatRowsProps = {
  items: readonly Item[];
  total: number;
  /** The count of the active chats on all pages. */
  active: number;
  /** The filter of the items. A new one mounts a new list. */
  listKey: string;
  /** The words of the search, which the items mark. */
  words: readonly string[];
  headingId: string;
  openKey: string | undefined;
  mountReturnKey: string | undefined;
  /** Focus the tab stop at mount. */
  focusOnMount: boolean;
  now: number;
  loadingOlder: boolean;
  olderFailed: boolean;
  onRetryOlder: () => void;
  onEnd: () => void;
  /** Called when the last item goes away while the focus is in the rows. */
  onFocusLost: () => void;
};

function ChatRows({
  items,
  total,
  active,
  listKey,
  words,
  headingId,
  openKey,
  mountReturnKey,
  focusOnMount,
  now,
  loadingOlder,
  olderFailed,
  onRetryOlder,
  onEnd,
  onFocusLost,
}: ChatRowsProps): ReactNode {
  const rowsRef = useRef<HTMLDivElement>(null);
  // The focus is on an item or in the footer.
  const [focused, setFocused] = useState(false);
  const [shownKey, setShownKey] = useState(listKey);
  // The list of a new filter takes the focus that was in the list before it.
  const [focusNewList, setFocusNewList] = useState(false);

  if (listKey !== shownKey) {
    setShownKey(listKey);
    setFocusNewList(focused);
  }

  useFocusLost(rowsRef, onFocusLost);

  const bands = groupBands(items, total, active);

  return (
    <div
      ref={rowsRef}
      className="min-h-0 flex-1"
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={(event) => {
        // A window that goes to the background blurs the element and keeps it active.
        setFocused(event.currentTarget.contains(event.relatedTarget) || document.activeElement === event.target);
      }}
    >
      <VirtualList
        key={listKey}
        items={items}
        estimateSize={(_item, index) => ITEM_HEIGHT + (bands.has(index) ? BAND_HEIGHT : 0)}
        getKey={chatKey}
        labelledBy={headingId}
        roving={{ preferredKey: openKey ?? mountReturnKey, focusOnMount: focusOnMount || focusNewList }}
        renderItem={(item, index, tabIndex) => (
          <ChatListItem
            item={item}
            selected={chatKey(item) === openKey}
            now={now}
            tabIndex={tabIndex}
            words={words}
            band={bands.get(index)}
          />
        )}
        keepRendered={[...bands.keys()]}
        height="100%"
        total={total}
        footer={(
          <OlderFooter
            loading={loadingOlder}
            failed={olderFailed}
            onRetry={onRetryOlder}
            onRetryGone={() => {
              rowsRef.current?.querySelector<HTMLElement>(`[data-chat-key="${chatKey(items.at(-1)!)}"]`)?.focus();
            }}
          />
        )}
        onEnd={onEnd}
        anchorTop
        selectedKey={openKey}
        renderToTop={(goToTop) => <ToTopButton goToTop={goToTop} />}
      />
    </div>
  );
}

/** Returns the list to its top. When it goes away while it holds the focus, the first item takes the focus. */
function ToTopButton({ goToTop }: { goToTop: () => void }): ReactNode {
  const buttonRef = useRef<HTMLButtonElement>(null);

  useFocusLost(buttonRef, goToTop);

  return (
    <Button ref={buttonRef} type="button" aria-label="Scroll chats to top" onClick={goToTop} className={SCROLL_TO_TOP_CLASS}>
      <ArrowUpIcon size={16} aria-hidden="true" />
    </Button>
  );
}

/** The band of each group of the items, by the index of the first item of the group. */
function groupBands(items: readonly Item[], total: number, active: number): Map<number, Band> {
  const bands = new Map<number, Band>();
  if (isActiveChat(items[0]?.status)) {
    bands.set(0, { name: "Active", count: active });
  }
  const firstOther = items.findIndex((item) => !isActiveChat(item.status));
  if (firstOther > 0) {
    bands.set(firstOther, { name: "Other chats", count: total - active });
  }
  return bands;
}

type OlderFooterProps = {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  /** Moves the focus when "Try again" goes away with it. */
  onRetryGone: () => void;
};

/**
 * The state of the older chats. It owns the move of the focus from "Try again":
 * a new list or the end of the rows unmounts the footer, and the move with it.
 */
function OlderFooter({ loading, failed, onRetry, onRetryGone }: OlderFooterProps): ReactNode {
  const pendingFocus = usePendingFocus();

  return (
    <div className="flex items-center gap-3 px-3.5 py-2">
      <p role="status" className="text-sm text-subtle">
        {loading ? "Loading older chats" : failed ? "Older chats cannot be loaded." : ""}
      </p>
      {failed && (
        <RetryButton
          onRetry={onRetry}
          onFocusLost={() => {
            pendingFocus(onRetryGone);
          }}
        />
      )}
    </div>
  );
}
