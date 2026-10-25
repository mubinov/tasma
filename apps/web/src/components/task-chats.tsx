import { Link } from "@tanstack/react-router";
import type { Chat } from "@tasma/protocol";
import { useId, type ReactNode } from "react";
import { chatStateText } from "../lib/chat-messages";
import { fullChatTime, shortChatTime } from "../lib/chat-time";
import { focusChatHeading } from "../lib/focus-in-view";
import { useMinute } from "../lib/use-minute";
import { StateMark } from "./chat-panel";
import { SELECTED_ROW_CLASS } from "./control-classes";

type TaskChatsProps = {
  tag: string;
  task: string;
  /** As read, oldest first. */
  chats: readonly Chat[];
  /** The status of the task is not final, so the newest chat shows its state. */
  stateful: boolean;
  openChat: number | undefined;
};

type ChatRowProps = {
  tag: string;
  task: string;
  chat: Chat;
  showState: boolean;
  open: boolean;
  now: number;
};

function ChatRow({ tag, task, chat, showState, open, now }: ChatRowProps): ReactNode {
  const { step, created } = chat;
  const label = [step, ...(showState ? [chatStateText(chat)] : []), fullChatTime(created)];

  return (
    <Link
      to="/tasks/$project/$task"
      params={{ project: tag, task }}
      search={{ chat: String(chat.chat) }}
      resetScroll={false}
      aria-label={label.join(", ")}
      aria-current={open ? "page" : undefined}
      onClick={(event) => {
        // The address would not change, so the panel would not take focus by itself.
        if (open) {
          event.preventDefault();
          focusChatHeading();
        }
      }}
      className={`relative flex min-w-0 items-center gap-3 px-3 py-2 text-text hover:bg-surface-2 focus-visible:-outline-offset-2 ${open ? SELECTED_ROW_CLASS : ""}`}
    >
      <span className="min-w-0 truncate font-mono text-sm">{step}</span>
      <span className="ml-auto flex shrink-0 items-center gap-3 text-xs">
        {showState && <StateMark status={chat} />}
        <time dateTime={created} className="text-dim">{shortChatTime(created, now)}</time>
      </span>
    </Link>
  );
}

/** The chats of a task, newest first. Only the newest chat shows a state. */
export function TaskChats({ tag, task, chats, stateful, openChat }: TaskChatsProps): ReactNode {
  const headingId = useId();
  const now = useMinute();

  if (chats.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby={headingId} data-find-skip="" className="mt-8 max-w-2xl">
      {/* The space separates the words in speech; flex drops it from the layout. */}
      <h2 id={headingId} className="flex items-baseline font-chrome text-lg font-semibold">
        Chats
        {" "}
        <span className="ml-1.5 text-xs-plus font-normal text-dim">{chats.length}</span>
      </h2>
      {/* The role is stated rather than inherited: list-style: none drops it in WebKit. */}
      <ul role="list" className="mt-2 overflow-hidden rounded-card border border-line bg-surface">
        {chats.toReversed().map((chat, index) => (
          <li key={chat.chat} className={index > 0 ? "border-t border-line" : undefined}>
            <ChatRow
              tag={tag}
              task={task}
              chat={chat}
              showState={stateful && index === 0}
              open={chat.chat === openChat}
              now={now}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
