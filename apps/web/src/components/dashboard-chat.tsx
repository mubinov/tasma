import { useQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { ChatListItem } from "@tasma/protocol";
import { useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { chatItemQuery, chatListQuery, type ChatFilter } from "../api/queries";
import { opensHere, tagOf } from "../lib/board";
import { chatListItems, sameChat, type OpenChat } from "../lib/chat-list-announcements";
import { chatAgentName, isChatMissing } from "../lib/chat-messages";
import { focusInView } from "../lib/focus-in-view";
import { ArrowLeftIcon } from "../lib/icons";
import { useFocusLost } from "../lib/use-focus-lost";
import { usePendingFocus } from "../lib/use-pending-focus";
import { ChatBody, StateMark } from "./chat-panel";
import { BUTTON_CLASS } from "./control-classes";

const route = getRouteApi("/");

/** The width of the kit thread, which the header and the status line keep. */
const COLUMN_CLASS = "mx-auto w-full max-w-[44rem]";

type DashboardChatProps = {
  /** The filter of the list on the screen. */
  filter: ChatFilter;
  open: OpenChat | undefined;
  wide: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** Called when "Chats" closes the chat. */
  onBack: () => void;
};

/** The chat side of the dashboard: the open chat, or a short text. */
export function DashboardChat({ filter, open, wide, headingRef, onBack }: DashboardChatProps): ReactNode {
  const { client } = route.useRouteContext();
  const { data } = useSuspenseInfiniteQuery(chatListQuery(client, filter));
  const items = chatListItems(data.pages);

  if (open === undefined) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center bg-bg px-6 pb-(--notice-stack-height)">
        {items.length > 0 && <p className="text-base text-subtle">Select a chat in the list.</p>}
      </div>
    );
  }

  return (
    <ChatSide
      open={open}
      listed={items.find((item) => sameChat(item, open))}
      wide={wide}
      headingRef={headingRef}
      onBack={onBack}
    />
  );
}

type ChatSideProps = Omit<DashboardChatProps, "open" | "filter"> & {
  open: OpenChat;
  /** The item of the open chat in the loaded pages. */
  listed: ChatListItem | undefined;
};

function ChatSide({ open, listed, wide, headingRef, onBack }: ChatSideProps): ReactNode {
  const { client } = route.useRouteContext();
  const { task, chat } = open;
  const tag = tagOf(task);
  const read = useQuery({ ...chatItemQuery(client, task, chat), enabled: listed === undefined });
  const missing = isChatMissing(read.error);
  const found = listed ?? (missing ? undefined : read.data?.data);
  // Kept while the item is read again, so the header does not lose its lines.
  const [lastFound, setLastFound] = useState(found);
  const headingId = useId();
  const pendingFocus = usePendingFocus();

  if (found !== undefined && found !== lastFound) {
    setLastFound(found);
  }

  const item = found ?? (missing || lastFound === undefined || !sameChat(lastFound, open) ? undefined : lastFound);

  // "Chats" and "Open task" can go away with the focus: after a resize, a live update or a failed read.
  function focusHeading(): void {
    pendingFocus(() => {
      focusInView(headingRef.current);
    });
  }

  return (
    <section aria-labelledby={headingId} className="flex h-full min-w-0 flex-1 flex-col bg-bg pb-(--notice-stack-height)">
      <div className="border-b border-line">
        <div className={`${COLUMN_CLASS} flex items-start gap-3 px-6 py-3`}>
          <div className="min-w-0 flex-1">
            {!wide && <ChatsLink onBack={onBack} onFocusLost={focusHeading} />}
            <h2 ref={headingRef} id={headingId} tabIndex={-1} className="font-chrome text-base font-semibold">
              <span className="font-mono text-xs font-normal text-dim wrap-anywhere">{task}</span>
              {item !== undefined && ` ${item.title}`}
            </h2>
            {item !== undefined && (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="text-subtle">{`${chatAgentName(item.agent)} · ${item.step} · Chat ${String(chat)}`}</span>
                {item.status !== undefined && <StateMark status={item.status} />}
              </p>
            )}
          </div>
          {item !== undefined && <OpenTaskLink tag={tag} task={task} onFocusLost={focusHeading} />}
        </div>
      </div>
      <ChatBody tag={tag} task={task} chat={chat} headingRef={headingRef} lineClassName={COLUMN_CLASS} />
    </section>
  );
}

function ChatsLink({ onBack, onFocusLost }: { onBack: () => void; onFocusLost: () => void }): ReactNode {
  const ref = useRef<HTMLAnchorElement>(null);

  useFocusLost(ref, onFocusLost);

  return (
    <Link
      ref={ref}
      from="/"
      to="/"
      search={(previous) => ({ ...previous, task: undefined, chat: undefined })}
      // A partial match is active on every address of the dashboard.
      activeOptions={{ exact: true }}
      replace
      resetScroll={false}
      onClick={(event) => {
        if (opensHere(event)) {
          onBack();
        }
      }}
      className="mb-2 inline-flex items-center gap-1.5 text-sm text-dim hover:text-text"
    >
      <ArrowLeftIcon size={16} aria-hidden="true" />
      Chats
    </Link>
  );
}

function OpenTaskLink({ tag, task, onFocusLost }: { tag: string; task: string; onFocusLost: () => void }): ReactNode {
  const ref = useRef<HTMLAnchorElement>(null);

  useFocusLost(ref, onFocusLost);

  return (
    <Link ref={ref} to="/tasks/$project/$task" params={{ project: tag, task }} className={`${BUTTON_CLASS} shrink-0`}>
      Open task
    </Link>
  );
}
