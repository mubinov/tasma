import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { ChatListItem } from "@tasma/protocol";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { chatListQuery } from "../api/queries";
import { chatKey, chatListAnnouncements, type OpenChat } from "../lib/chat-list-announcements";
import { useDocumentTitle } from "../lib/document-title";
import { focusInView } from "../lib/focus-in-view";
import { usePendingFocus } from "../lib/use-pending-focus";
import { useWide } from "../lib/use-wide";
import { useNoticeStore } from "../store/notices";
import { ChatList } from "./chat-list";
import { DashboardChat } from "./dashboard-chat";
import { NAVIGATION_BY_PATH } from "../navigation";
import { ScreenHeading } from "./screen-heading";

const route = getRouteApi("/");

const { label: TITLE } = NAVIGATION_BY_PATH["/"];

/**
 * The chats of all projects in a list, and the open chat beside it. A narrow
 * window shows one of the two.
 */
export function DashboardScreen(): ReactNode {
  const { client } = route.useRouteContext();
  const { task, chat } = route.useSearch();
  const open: OpenChat | undefined = task === undefined || chat === undefined
    ? undefined
    : { task, chat: Number(chat) };
  const openKey = open === undefined ? undefined : chatKey(open);
  const { data } = useSuspenseInfiniteQuery(chatListQuery(client));
  const wide = useWide();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingFocus = usePendingFocus();
  const lastItemsRef = useRef<readonly ChatListItem[] | null>(null);
  // The chat that "Chats" closed, for the one mount of the list that follows.
  const [returnKey, setReturnKey] = useState<string>();
  const [shownKey, setShownKey] = useState(openKey);

  if (openKey !== shownKey) {
    setShownKey(openKey);
    if (openKey !== undefined) {
      setReturnKey(undefined);
    }
  }

  // The first result after a mount announces nothing.
  const announceChanges = useEffectEvent((items: readonly ChatListItem[]) => {
    const before = lastItemsRef.current;
    lastItemsRef.current = items;
    if (before !== null) {
      for (const words of chatListAnnouncements(before, items, open)) {
        useNoticeStore.getState().announce(words);
      }
    }
  });

  useEffect(() => {
    announceChanges(data.pages.flatMap((page) => page.data.items));
  }, [data]);

  useDocumentTitle(TITLE);

  const showList = wide || open === undefined;
  const showChat = wide || open !== undefined;

  return (
    <div className="-m-6 -mb-[calc(--spacing(6)+var(--notice-stack-height,0px))] flex h-screen min-h-[30rem] sm:-m-10 sm:-mb-[calc(--spacing(10)+var(--notice-stack-height,0px))]">
      <ScreenHeading className="sr-only">{TITLE}</ScreenHeading>
      {showList && (
        <ChatList
          openKey={openKey}
          returnKey={returnKey}
          onReturned={() => {
            setReturnKey(undefined);
          }}
          className={wide ? "w-task-sidebar shrink-0 border-r border-line" : "w-full"}
          onFocusLost={() => {
            pendingFocus(() => {
              focusInView(headingRef.current);
            });
          }}
        />
      )}
      {showChat && (
        <DashboardChat
          open={open}
          wide={wide}
          headingRef={headingRef}
          onBack={() => {
            setReturnKey(openKey);
          }}
        />
      )}
    </div>
  );
}
