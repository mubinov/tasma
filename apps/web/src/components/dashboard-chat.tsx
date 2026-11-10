import { Menu } from "@base-ui/react/menu";
import { useQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { AnyChatListItem, ProjectSummary } from "@tasma/protocol";
import { useId, useReducer, useRef, useState, type ReactNode, type RefObject } from "react";
import { usePendingChatStart } from "../api/mutations";
import { chatItemQuery, chatListQuery, taskChatsQuery, taskQuery, workflowQuery, type ChatFilter } from "../api/queries";
import { tagOf } from "../lib/board";
import { chatKey, chatListItems, sameChat, type OpenChat } from "../lib/chat-list-announcements";
import { chatAgentName, isChatMissing } from "../lib/chat-messages";
import type { FinalFocus } from "../lib/final-focus";
import { CHAT_HEADING_MARK, focusInView } from "../lib/focus-in-view";
import { ArrowClockwiseIcon, CircleNotchIcon, DotsThreeVerticalIcon } from "../lib/icons";
import { actionStep, STEP_ACTION_MARK, stepAction } from "../lib/step-action";
import { useChatStart } from "../lib/use-chat-start";
import { useFocusLost } from "../lib/use-focus-lost";
import { usePendingFocus } from "../lib/use-pending-focus";
import { ChatBody, StateMark } from "./chat-panel";
import { ChatsLink } from "./chats-link";
import { BUTTON_CLASS, CHAT_COLUMN_CLASS, ICON_BUTTON_CLASS, MENU_ITEM_CLASS, POPUP_CLASS, POSITIONER_CLASS } from "./control-classes";
import { NewChat } from "./new-chat";
import { RestartDialog } from "./restart-dialog";
import { Tooltip } from "./tooltip";

const route = getRouteApi("/");

const CHAT_MENU_CLASS = `shrink-0 ${ICON_BUTTON_CLASS} aria-disabled:hover:border-line aria-disabled:hover:text-dim`;

type DashboardChatProps = {
  /** The filter of the list on the screen. */
  filter: ChatFilter;
  open: OpenChat | undefined;
  /** The New chat view shows. */
  newChat: boolean;
  /** The project of the filter of the address. */
  filterProject: string | undefined;
  projects: readonly ProjectSummary[];
  wide: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** Called when "Chats" closes the chat or the New chat view. */
  onBack: () => void;
  /** Called at Send of the New chat view. */
  onStart: (tag: string) => void;
};

/** The chat side of the dashboard: the New chat view, the open chat, or a short text. */
export function DashboardChat(
  { filter, open, newChat, filterProject, projects, wide, headingRef, onBack, onStart }: DashboardChatProps,
): ReactNode {
  const { client } = route.useRouteContext();
  const { data } = useSuspenseInfiniteQuery(chatListQuery(client, filter));
  const items = chatListItems(data.pages);

  if (newChat) {
    return (
      <NewChat
        filterProject={filterProject}
        projects={projects}
        wide={wide}
        headingRef={headingRef}
        onBack={onBack}
        onStart={onStart}
      />
    );
  }

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

type ChatMenuState = { step: string; restarting: boolean };

/**
 * The Chat menu of a chat that "Open <step>" opens, or null. A pending start or
 * restart of the task allows no second one, so while one is pending only the
 * chat that it replaces has the menu, whatever the reads show: the list can
 * hold the new chat before the answer.
 */
function useChatMenu(tag: string, task: string, chat: number): ChatMenuState | null {
  const { client } = route.useRouteContext();
  const taskRead = useQuery(taskQuery(client, tag, task));
  const workflow = taskRead.data?.data.frontmatter.workflow;
  const workflowRead = useQuery({ ...workflowQuery(client, workflow ?? ""), enabled: workflow !== undefined });
  const chatsRead = useQuery(taskChatsQuery(client, tag, task));
  const pending = usePendingChatStart(task);

  if (pending !== undefined) {
    return pending.restart === chat ? { step: pending.step, restarting: true } : null;
  }
  // Not `data`: a read that fails again keeps the data of the last one.
  if (!taskRead.isSuccess || !workflowRead.isSuccess || !chatsRead.isSuccess) {
    return null;
  }

  const step = actionStep(taskRead.data.data.frontmatter, workflowRead.data?.data);
  const action = step === null ? null : stepAction(step, chatsRead.data.data);

  return action?.kind === "open" && action.chat === chat ? { step: action.step, restarting: false } : null;
}

type RestartAsk = { tag: string; id: string; step: string; chat: number; open: boolean };

type ChatSideProps = Pick<DashboardChatProps, "wide" | "headingRef" | "onBack"> & {
  open: OpenChat;
  /** The item of the open chat in the loaded pages. */
  listed: AnyChatListItem | undefined;
};

function chatLine(item: AnyChatListItem): string {
  return [chatAgentName(item.agent), ...("task" in item ? [item.step] : []), `Chat ${String(item.chat)}`].join(" · ");
}

function ChatSide({ open, listed, wide, headingRef, onBack }: ChatSideProps): ReactNode {
  const { client } = route.useRouteContext();
  const { task, chat } = open;
  const tag = open.task === undefined ? open.tag : tagOf(open.task);
  const read = useQuery({ ...chatItemQuery(client, tag, task, chat), enabled: listed === undefined });
  const missing = isChatMissing(read.error);
  const found = listed ?? (missing ? undefined : read.data?.data);
  // Kept while the item is read again, so the header does not lose its lines.
  const [lastFound, setLastFound] = useState(found);
  const headingId = useId();
  const pendingFocus = usePendingFocus();
  // The menu can go away in a render of `TaskChatMenu` alone, and a pending focus runs only in a commit of this one.
  const [, commitAgain] = useReducer((commits: number) => commits + 1, 0);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [restartAsk, setRestartAsk] = useState<RestartAsk | null>(null);
  const restartFocusRef = useRef<FinalFocus>(null);

  if (found !== undefined && found !== lastFound) {
    setLastFound(found);
  }

  const item = found ?? (missing || lastFound === undefined || !sameChat(lastFound, open) ? undefined : lastFound);

  // "Chats", "Open task" and the Chat menu can go away with the focus: after a resize, a live update or a failed read.
  function focusHeading(): void {
    pendingFocus(() => {
      focusInView(headingRef.current);
    });
  }

  function closeRestart(ask: RestartAsk): void {
    restartFocusRef.current = menuRef.current ?? headingRef.current;
    setRestartAsk({ ...ask, open: false });
  }

  return (
    <section aria-labelledby={headingId} className="flex h-full min-w-0 flex-1 flex-col bg-bg pb-(--notice-stack-height)">
      <div className="border-b border-line">
        <div className={`${CHAT_COLUMN_CLASS} flex items-start gap-3 px-6 py-3`}>
          <div className="min-w-0 flex-1">
            {!wide && <ChatsLink onBack={onBack} onFocusLost={focusHeading} />}
            <h2 ref={headingRef} id={headingId} tabIndex={-1} {...CHAT_HEADING_MARK} className="font-chrome text-base font-semibold">
              <span className="font-mono text-xs font-normal text-dim wrap-anywhere">{task ?? tag}</span>
              {item !== undefined && ` ${item.title}`}
            </h2>
            {item !== undefined && (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="text-subtle">{chatLine(item)}</span>
                {item.status !== undefined && <StateMark status={item.status} />}
              </p>
            )}
          </div>
          {item !== undefined && task !== undefined && (
            <OpenTaskLink tag={tag} task={task} onFocusLost={focusHeading} />
          )}
          {task !== undefined && (
            <TaskChatMenu
              tag={tag}
              task={task}
              chat={chat}
              buttonRef={menuRef}
              onRestart={(step) => {
                setRestartAsk({ tag, id: task, step, chat, open: true });
              }}
              onFocusLost={() => {
                focusHeading();
                commitAgain();
              }}
            />
          )}
        </div>
      </div>
      <ChatBody tag={tag} task={task} chat={chat} headingRef={headingRef} lineClassName={CHAT_COLUMN_CLASS} />
      {restartAsk !== null && (
        <ChatRestartDialog
          ask={restartAsk}
          finalFocus={restartFocusRef}
          onClose={() => {
            closeRestart(restartAsk);
          }}
        />
      )}
    </section>
  );
}

type TaskChatMenuProps = {
  tag: string;
  task: string;
  chat: number;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onRestart: (step: string) => void;
  onFocusLost: () => void;
};

/** Its own component so that a chat of a project reads no task, no workflow and no chat list of a task. */
function TaskChatMenu({ tag, task, chat, buttonRef, onRestart, onFocusLost }: TaskChatMenuProps): ReactNode {
  const menu = useChatMenu(tag, task, chat);

  return menu !== null && (
    <ChatMenu
      key={chatKey({ task, chat })}
      {...menu}
      buttonRef={buttonRef}
      onRestart={() => {
        onRestart(menu.step);
      }}
      onFocusLost={onFocusLost}
    />
  );
}

type ChatMenuProps = ChatMenuState & {
  buttonRef: RefObject<HTMLButtonElement | null>;
  onRestart: () => void;
  onFocusLost: () => void;
};

/**
 * The step action of the dashboard. Base UI's menu trigger has no
 * `focusableWhenDisabled`, so a waiting trigger stays enabled, which keeps the
 * focus on it, and refuses to open.
 */
function ChatMenu({ step, restarting, buttonRef, onRestart, onFocusLost }: ChatMenuProps): ReactNode {
  const [open, setOpen] = useState(false);

  useFocusLost(buttonRef, onFocusLost, open);

  return (
    <Menu.Root
      highlightItemOnHover={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next && !restarting);
      }}
    >
      {/* A tooltip that the end of the wait finds open must not keep saying that it waits. */}
      <Tooltip content={restarting ? `Restarting ${step}` : "Chat menu"} canOpen={() => restarting}>
        <Menu.Trigger
          ref={buttonRef}
          {...STEP_ACTION_MARK}
          aria-label={restarting ? "Chat menu, restarting" : "Chat menu"}
          aria-disabled={restarting || undefined}
          className={CHAT_MENU_CLASS}
        >
          {restarting
            ? <CircleNotchIcon size={16} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
            : <DotsThreeVerticalIcon size={16} aria-hidden="true" />}
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className={POSITIONER_CLASS}>
          <Menu.Popup className={`max-w-(--available-width) min-w-52 ${POPUP_CLASS}`}>
            <Menu.Item onClick={onRestart} className={MENU_ITEM_CLASS}>
              <ArrowClockwiseIcon size={14} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 wrap-anywhere">{`Restart ${step}`}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

type ChatRestartDialogProps = {
  ask: RestartAsk;
  finalFocus: RefObject<FinalFocus>;
  onClose: () => void;
};

/** Asks about the chat of its `ask`, also when another chat opens under the dialog. */
function ChatRestartDialog({ ask, finalFocus, onClose }: ChatRestartDialogProps): ReactNode {
  const { tag, id, step, chat, open } = ask;
  const start = useChatStart(tag, id);

  return (
    <RestartDialog
      open={open}
      tag={tag}
      id={id}
      step={step}
      chat={chat}
      onCancel={onClose}
      onConfirm={() => {
        onClose();
        start(step, "dashboard", chat);
      }}
      finalFocus={finalFocus}
    />
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
