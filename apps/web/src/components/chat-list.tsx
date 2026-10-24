import { Button } from "@base-ui/react/button";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { ChatListItem as Item } from "@tasma/protocol";
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { chatListQuery } from "../api/queries";
import { chatKey } from "../lib/chat-list-announcements";
import { useFocusLost } from "../lib/use-focus-lost";
import { usePendingFocus } from "../lib/use-pending-focus";
import { ChatListItem } from "./chat-list-item";
import { BUTTON_CLASS } from "./control-classes";
import { VirtualList } from "./virtual-list";

const route = getRouteApi("/");

/** The height of an item with three lines, before it is measured. */
const ITEM_HEIGHT = 79;

const MINUTE = 60_000;

type ChatListProps = {
  openKey: string | undefined;
  /**
   * The chat that "Chats" closed. The mount it comes with focuses its item, or
   * the empty text, and calls `onReturned`.
   */
  returnKey: string | undefined;
  onReturned: () => void;
  /** The width and the border of the column. */
  className: string;
  /** Called when the column goes away while the focus is in it. */
  onFocusLost: () => void;
};

/** The time the items count from, a new one each minute. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, MINUTE);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return now;
}

/** The list of the chats of all projects, newest first, and the older pages it loads. */
export function ChatList({ openKey, returnKey, onReturned, className, onFocusLost }: ChatListProps): ReactNode {
  const { client } = route.useRouteContext();
  const { data, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError }
    = useSuspenseInfiniteQuery(chatListQuery(client));
  const items = data.pages.flatMap((page) => page.data.items);
  // The preferred tab stop for the life of the list, after `returnKey` is cleared.
  const [mountReturnKey] = useState(returnKey);
  // The rows that replace the empty text while it has the focus take the focus.
  const [emptyFocused, setEmptyFocused] = useState(false);
  const now = useMinute();
  const columnRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  const headingId = useId();
  const pendingFocus = usePendingFocus();
  const failed = isFetchNextPageError && !isFetchingNextPage;
  const takeReturnFocus = useEffectEvent(() => {
    if (returnKey === undefined) {
      return;
    }
    if (items.length === 0) {
      emptyRef.current?.focus();
    }
    onReturned();
  });

  useFocusLost(columnRef, onFocusLost);

  useLayoutEffect(() => {
    takeReturnFocus();
  }, []);

  function focusItem(key: string): void {
    columnRef.current?.querySelector<HTMLElement>(`[data-chat-key="${key}"]`)?.focus();
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

  const footer = (
    <div className="flex items-center gap-3 px-3.5 py-2">
      <p role="status" className="text-sm text-subtle">
        {isFetchingNextPage ? "Loading older chats" : failed ? "Older chats cannot be loaded." : ""}
      </p>
      {failed && (
        <OlderRetry
          onRetry={retryOlder}
          onFocusLost={() => {
            pendingFocus(() => {
              focusItem(chatKey(items.at(-1)!));
            });
          }}
        />
      )}
    </div>
  );

  return (
    <div ref={columnRef} className={`flex h-full min-h-0 flex-col bg-bg ${className}`}>
      <h2 id={headingId} className="sr-only">Chats</h2>
      {items.length === 0
        ? <EmptyText ref={emptyRef} onFocusChange={setEmptyFocused} />
        : (
            <ChatRows
              items={items}
              total={data.pages[0]!.data.total}
              headingId={headingId}
              openKey={openKey}
              mountReturnKey={mountReturnKey}
              focusOnMount={returnKey !== undefined || emptyFocused}
              now={now}
              footer={footer}
              onEnd={loadOlderWhenIdle}
              onFocusLost={() => {
                pendingFocus(() => {
                  emptyRef.current?.focus();
                });
              }}
            />
          )}
    </div>
  );
}

type EmptyTextProps = {
  ref: RefObject<HTMLParagraphElement | null>;
  onFocusChange: (focused: boolean) => void;
};

function EmptyText({ ref, onFocusChange }: EmptyTextProps): ReactNode {
  useFocusLost(ref, () => {
    onFocusChange(false);
  });

  return (
    <p
      ref={ref}
      tabIndex={-1}
      onFocus={() => {
        onFocusChange(true);
      }}
      onBlur={(event) => {
        // A window that goes to the background blurs the element and keeps it active.
        onFocusChange(document.activeElement === event.currentTarget);
      }}
      className="p-4 text-sm text-subtle"
    >
      No chats yet. A chat shows here when an agent starts a step of a task.
    </p>
  );
}

type ChatRowsProps = {
  items: readonly Item[];
  total: number;
  headingId: string;
  openKey: string | undefined;
  mountReturnKey: string | undefined;
  /** Focus the tab stop at mount. */
  focusOnMount: boolean;
  now: number;
  footer: ReactNode;
  onEnd: () => void;
  /** Called when the last item goes away while the focus is in the rows. */
  onFocusLost: () => void;
};

function ChatRows(
  { items, total, headingId, openKey, mountReturnKey, focusOnMount, now, footer, onEnd, onFocusLost }: ChatRowsProps,
): ReactNode {
  const rowsRef = useRef<HTMLDivElement>(null);

  useFocusLost(rowsRef, onFocusLost);

  return (
    <div ref={rowsRef} className="min-h-0 flex-1">
      <VirtualList
        items={items}
        estimateSize={ITEM_HEIGHT}
        getKey={chatKey}
        labelledBy={headingId}
        roving={{ preferredKey: openKey ?? mountReturnKey, focusOnMount }}
        renderItem={(item, _index, tabIndex) => (
          <ChatListItem item={item} selected={chatKey(item) === openKey} now={now} tabIndex={tabIndex} />
        )}
        height="100%"
        className="pb-(--notice-stack-height) scroll-pb-(--notice-stack-height)"
        total={total}
        footer={footer}
        onEnd={onEnd}
        anchorTop
      />
    </div>
  );
}

type OlderRetryProps = { onRetry: () => void; onFocusLost: () => void };

/** A page load or a live refresh can remove the button while it has the focus. */
function OlderRetry({ onRetry, onFocusLost }: OlderRetryProps): ReactNode {
  const ref = useRef<HTMLButtonElement>(null);

  useFocusLost(ref, onFocusLost);

  return (
    <Button ref={ref} type="button" onClick={onRetry} className={`${BUTTON_CLASS} shrink-0`}>
      Try again
    </Button>
  );
}
