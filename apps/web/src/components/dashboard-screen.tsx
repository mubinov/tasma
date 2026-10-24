import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { ChatListItem } from "@tasma/protocol";
import { useDeferredValue, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { chatListQuery, projectsQuery } from "../api/queries";
import { chatKey, chatListAnnouncements, resultCountWords, type OpenChat } from "../lib/chat-list-announcements";
import { useDocumentTitle } from "../lib/document-title";
import { focusInView } from "../lib/focus-in-view";
import { FILTER_FAILURE_TEXT, filterKey, useChatFilter } from "../lib/use-chat-filter";
import { usePendingFocus } from "../lib/use-pending-focus";
import { useWide } from "../lib/use-wide";
import { useNoticeStore } from "../store/notices";
import { ChatList } from "./chat-list";
import { DashboardChat } from "./dashboard-chat";
import { NAVIGATION_BY_PATH } from "../navigation";
import { ScreenHeading } from "./screen-heading";

const route = getRouteApi("/");

const { label: TITLE } = NAVIGATION_BY_PATH["/"];

function announce(words: string): void {
  useNoticeStore.getState().announce(words);
}

/**
 * The chats of all projects in a list, and the open chat beside it. A narrow
 * window shows one of the two.
 */
export function DashboardScreen(): ReactNode {
  const { client } = route.useRouteContext();
  const search = route.useSearch();
  const { task, chat } = search;
  const open: OpenChat | undefined = task === undefined || chat === undefined
    ? undefined
    : { task, chat: Number(chat) };
  const openKey = open === undefined ? undefined : chatKey(open);
  const { data: { data: projects } } = useSuspenseQuery(projectsQuery(client));
  const { requested, applied: latestApplied, failures, announceFailure, failed, failedFields, retry }
    = useChatFilter(client, search, projects);
  const applied = useDeferredValue(latestApplied);
  const { data } = useSuspenseInfiniteQuery(chatListQuery(client, applied));
  const wide = useWide();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingFocus = usePendingFocus();
  const lastResultRef = useRef<{ key: string; items: readonly ChatListItem[] } | null>(null);
  // The chat that "Chats" closed, for the one mount of the list that follows.
  const [returnKey, setReturnKey] = useState<string>();
  const [shownKey, setShownKey] = useState(openKey);

  if (openKey !== shownKey) {
    setShownKey(openKey);
    if (openKey !== undefined) {
      setReturnKey(undefined);
    }
  }

  // The first result after a mount announces nothing, and a result of a new filter its count.
  const announceChanges = useEffectEvent((items: readonly ChatListItem[], total: number) => {
    const before = lastResultRef.current;
    const key = filterKey(applied);
    lastResultRef.current = { key, items };
    if (before === null) {
      return;
    }
    if (before.key !== key) {
      announce(resultCountWords(total));
      return;
    }
    for (const words of chatListAnnouncements(before.items, items, open)) {
      announce(words);
    }
  });

  useEffect(() => {
    announceChanges(data.pages.flatMap((page) => page.data.items), data.pages[0]!.data.total);
  }, [data]);

  const sayFailure = useEffectEvent(() => {
    if (announceFailure) {
      announce(FILTER_FAILURE_TEXT);
    }
  });

  useEffect(() => {
    if (failures > 0) {
      sayFailure();
    }
  }, [failures]);

  useDocumentTitle(TITLE);

  const showList = wide || open === undefined;
  const showChat = wide || open !== undefined;

  return (
    <div className="-m-6 -mb-[calc(--spacing(6)+var(--notice-stack-height,0px))] flex h-screen min-h-[30rem] sm:-m-10 sm:-mb-[calc(--spacing(10)+var(--notice-stack-height,0px))]">
      <ScreenHeading className="sr-only">{TITLE}</ScreenHeading>
      {showList && (
        <ChatList
          filter={applied}
          requested={requested}
          projects={projects}
          failedFields={failed ? failedFields : null}
          onRetry={retry}
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
          filter={applied}
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
