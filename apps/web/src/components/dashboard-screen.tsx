import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { AnyChatListItem } from "@tasma/protocol";
import { useDeferredValue, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { chatListQuery, projectsQuery } from "../api/queries";
import {
  chatKey,
  chatListAnnouncements,
  chatListItems,
  knownChats,
  NEW_CHAT_KEY,
  resultCountWords,
  sameChat,
  type KnownChats,
  type OpenChat,
} from "../lib/chat-list-announcements";
import { useDocumentTitle } from "../lib/document-title";
import { focusInView } from "../lib/focus-in-view";
import { sayStartedWords } from "../lib/started-chat";
import { FILTER_FAILURE_TEXT, filterKey, useChatFilter } from "../lib/use-chat-filter";
import { usePendingFocus } from "../lib/use-pending-focus";
import { useWide } from "../lib/use-wide";
import { useNoticeStore } from "../store/notices";
import { useUiStore, type ChatStartWatch } from "../store/ui";
import { ChatList } from "./chat-list";
import { DashboardChat } from "./dashboard-chat";
import { NAVIGATION_BY_PATH } from "../navigation";
import { ScreenHeading } from "./screen-heading";

const route = getRouteApi("/");

const { label: TITLE } = NAVIGATION_BY_PATH["/"];

function announce(words: string): void {
  useNoticeStore.getState().announce(words);
}

function openChatOf(task: string | undefined, tag: string | undefined, chat: string | undefined): OpenChat | undefined {
  if (task !== undefined && chat !== undefined) {
    return { task, chat: Number(chat) };
  }
  return tag !== undefined && chat !== undefined ? { tag, chat: Number(chat) } : undefined;
}

/** A chat of the project of the start that the list did not know at Send. It cannot be told from the new chat. */
function isWatchedChat(item: AnyChatListItem, { tag, snapshot }: ChatStartWatch): boolean {
  return !("task" in item) && item.tag === tag && !snapshot.has(chatKey(item));
}

/**
 * The chats of all projects in a list, and the open chat beside it. A narrow
 * window shows one of the two.
 */
export function DashboardScreen(): ReactNode {
  const { client } = route.useRouteContext();
  const search = route.useSearch();
  const open = openChatOf(search.task, search.tag, search.chat);
  const openKey = open === undefined ? undefined : chatKey(open);
  const newChat = search.new === "1";
  const { data: { data: projects } } = useSuspenseQuery(projectsQuery(client));
  const { requested, applied: latestApplied, failures, announceFailure, failed, failedFields, retry }
    = useChatFilter(client, search, projects);
  const applied = useDeferredValue(latestApplied);
  const { data, dataUpdatedAt } = useSuspenseInfiniteQuery(chatListQuery(client, applied));
  const wide = useWide();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingFocus = usePendingFocus();
  const lastResultRef = useRef<{ key: string; items: readonly AnyChatListItem[]; known: KnownChats } | null>(null);
  // The chat that "Chats" closed, for the one mount of the list that follows.
  const [returnKey, setReturnKey] = useState<string>();
  const [shownKey, setShownKey] = useState(openKey);

  if (openKey !== shownKey) {
    setShownKey(openKey);
    if (openKey !== undefined) {
      setReturnKey(undefined);
    }
  }

  // A start that cleared a filter part says its words here, before the count: a focus in the rows moves to the list.
  function sayWordsBeforeCount(): void {
    const { startedChat } = useUiStore.getState();

    if (startedChat !== null && !startedChat.focus && open !== undefined && sameChat(open, startedChat)) {
      sayStartedWords();
    }
  }

  // The first result after a mount announces nothing, and a result of a new filter its count.
  const announceChanges = useEffectEvent((items: readonly AnyChatListItem[], total: number) => {
    const before = lastResultRef.current;
    const key = filterKey(applied);
    const { chatStartWatch: watch, startedChat, setChatStartWatch } = useUiStore.getState();

    lastResultRef.current = { key, items, known: knownChats(items, before?.key === key ? before.known : undefined) };
    if (watch?.answeredAt != null && dataUpdatedAt >= watch.answeredAt) {
      setChatStartWatch(null);
    }
    if (before === null) {
      return;
    }
    if (before.key !== key) {
      sayWordsBeforeCount();
      announce(resultCountWords(total));
      return;
    }

    const announced = watch === null ? items : items.filter((item) => !isWatchedChat(item, watch));
    const shownChat = open ?? (newChat ? startedChat ?? undefined : undefined);

    for (const words of chatListAnnouncements(before.items, announced, shownChat, before.known)) {
      announce(words);
    }
  });

  // A read that gives an equal list keeps `data` and changes only the time.
  useEffect(() => {
    announceChanges(chatListItems(data.pages), data.pages[0]!.data.total);
  }, [data, dataUpdatedAt]);

  function watchStart(tag: string): void {
    const known = [...lastResultRef.current!.known.values()];
    const snapshot = new Set(known.filter((item) => !("task" in item) && item.tag === tag).map(chatKey));

    useUiStore.getState().setChatStartWatch({ tag, snapshot, answeredAt: null });
  }

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

  const showList = wide || (open === undefined && !newChat);
  const showChat = wide || open !== undefined || newChat;

  return (
    // The line of the page frame paints above the page. The transparent border takes the width of that line at each
    // zoom, so the line never covers the focus ring of a row.
    <div className="-m-6 -mt-[calc(--spacing(6)+var(--title-band))] -mb-[calc(--spacing(6)+var(--notice-stack-height,0px))] flex h-screen min-h-[30rem] border-l border-transparent pt-(--title-band) sm:-m-10 sm:-mt-[calc(--spacing(10)+var(--title-band))] sm:-mb-[calc(--spacing(10)+var(--notice-stack-height,0px))]">
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
          newChat={newChat}
          filterProject={requested.project}
          projects={projects}
          wide={wide}
          headingRef={headingRef}
          onBack={() => {
            setReturnKey(openKey ?? NEW_CHAT_KEY);
          }}
          onStart={watchStart}
        />
      )}
    </div>
  );
}
