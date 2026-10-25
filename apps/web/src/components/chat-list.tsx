import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { ChatListItem as Item, ProjectSummary } from "@tasma/protocol";
import { useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { chatListQuery, type ChatFilter } from "../api/queries";
import { chatKey } from "../lib/chat-list-announcements";
import { searchWords } from "../lib/match-ranges";
import { filterKey, type FailedFields } from "../lib/use-chat-filter";
import { useFocusLost } from "../lib/use-focus-lost";
import { useMinute } from "../lib/use-minute";
import { usePendingFocus } from "../lib/use-pending-focus";
import { ChatFilterBar } from "./chat-filter-bar";
import { ChatListItem } from "./chat-list-item";
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
   * the search field, and calls `onReturned`.
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
    ? "No chats yet. A chat shows here when an agent starts a step of a task."
    : "This project has no chats.";
}

/** The list of the chats, newest first, the older pages it loads, and the filter above it. */
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
  const items = data.pages.flatMap((page) => page.data.items);
  const listKey = filterKey(filter);
  // The preferred tab stop of the list of the filter at mount, after `returnKey` is cleared.
  const [mountReturn, setMountReturn] = useState({ key: returnKey, listKey });

  if (mountReturn.key !== undefined && mountReturn.listKey !== listKey) {
    setMountReturn({ key: undefined, listKey });
  }
  const now = useMinute();
  const columnRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const pendingFocus = usePendingFocus();
  const takeReturnFocus = useEffectEvent(() => {
    if (returnKey === undefined) {
      return;
    }
    if (items.length === 0) {
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
        ? <p className="p-4 text-sm wrap-anywhere text-subtle">{emptyText(filter)}</p>
        : (
            <ChatRows
              items={items}
              total={data.pages[0]!.data.total}
              listKey={listKey}
              words={searchWords(filter.q ?? "")}
              headingId={headingId}
              openKey={openKey}
              mountReturnKey={mountReturn.key}
              focusOnMount={returnKey !== undefined}
              now={now}
              loadingOlder={isFetchingNextPage}
              olderFailed={isFetchNextPageError && !isFetchingNextPage}
              onRetryOlder={retryOlder}
              onEnd={loadOlderWhenIdle}
              onFocusLost={focusSearch}
            />
          )}
    </div>
  );
}

type ChatRowsProps = {
  items: readonly Item[];
  total: number;
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
        estimateSize={ITEM_HEIGHT}
        getKey={chatKey}
        labelledBy={headingId}
        roving={{ preferredKey: openKey ?? mountReturnKey, focusOnMount: focusOnMount || focusNewList }}
        renderItem={(item, _index, tabIndex) => (
          <ChatListItem item={item} selected={chatKey(item) === openKey} now={now} tabIndex={tabIndex} words={words} />
        )}
        height="100%"
        className="pb-(--notice-stack-height) scroll-pb-(--notice-stack-height)"
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
      />
    </div>
  );
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
