import { Button } from "@base-ui/react/button";
import { AssistantRuntimeProvider, useAui, useExternalStoreRuntime, type AppendMessage } from "@assistant-ui/react";
import { Thread, type ThreadComponents } from "@kit/components/assistant-ui/elements/thread.aui";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { Chat, ChatStatus, Client } from "@tasma/protocol";
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useChatLog } from "../api/chat-log";
import { chatQuery, type ChatPlace } from "../api/queries";
import { chatRequestOf } from "../lib/chat-approval";
import type { ChatMessage, ChatView } from "../lib/chat-fold";
import {
  chatAgentName,
  chatAnnouncements,
  chatStateText,
  chatThreadMessage,
  isChatMissing,
} from "../lib/chat-messages";
import { WarningIcon, XIcon } from "../lib/icons";
import { CHAT_HEADING_MARK, focusInView } from "../lib/focus-in-view";
import { useChatWrites } from "../lib/use-chat-writes";
import { useFocusLost } from "../lib/use-focus-lost";
import { chatDraft, subscribeChatDraft, useChatDraftStore } from "../store/chat-drafts";
import { useNoticeStore } from "../store/notices";
import { ChatDataViews, ChatEmpty, ChatToolGroup, ChatToolView } from "./chat-tool";
import { BUTTON_CLASS, ICON_BUTTON_CLASS } from "./control-classes";
import { Tooltip } from "./tooltip";

type ChatPanelProps = {
  tag: string;
  task: string;
  chat: number;
  onClose: () => void;
  /** Move focus to the panel heading when the panel mounts. A host sets it when the user opens a chat. */
  focusOnMount?: boolean;
};

/** What the panel shows of the log that its transcript reads. */
type LogState = { status: ChatStatus; ready: boolean; failures: number };

type RoundProps = ChatPlace & {
  headingRef: RefObject<HTMLHeadingElement | null>;
  onLog: (log: LogState) => void;
  onReset: () => void;
};

const THREAD_COMPONENTS: ThreadComponents = {
  ToolFallback: ChatToolView,
  ToolGroup: ChatToolGroup,
  Welcome: ChatEmpty,
};

function messageText(message: AppendMessage): string {
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export function StateMark({ status }: { status: ChatStatus }): ReactNode {
  const text = chatStateText(status);

  switch (status.state) {
    case "working":
      return (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-running" />
          {text}
        </span>
      );
    case "needs-you":
      return (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-signal" />
          {text}
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1.5">
          <WarningIcon size={14} aria-hidden="true" className="shrink-0 text-signal" />
          {text}
        </span>
      );
    case "continued-outside":
      return <span className="text-subtle">{text}</span>;
  }
}

function statusText(failed: boolean, missing: boolean, log: LogState | null): string {
  if (failed) {
    return missing ? "This chat does not exist." : "The chat cannot be read.";
  }
  if (log !== null && log.failures >= 2) {
    return "The chat cannot be read now. Tasma tries again.";
  }
  return log?.ready === true ? "" : "Loading the chat";
}

/**
 * One chat, live: its record, its state and its transcript. It knows nothing
 * of its host, which places it and closes it.
 */
export function ChatPanel(props: ChatPanelProps): ReactNode {
  // Another chat starts with none of the state of the last one, also in a host that keeps the panel mounted.
  return <ChatPanelBody key={JSON.stringify([props.tag, props.task, props.chat])} {...props} />;
}

function ChatPanelBody({ tag, task, chat, onClose, focusOnMount = false }: ChatPanelProps): ReactNode {
  // Any host can place the panel, so it takes the clients from the router.
  const { client, queryClient } = useRouter().options.context;
  const read = useQuery(chatQuery(client, tag, task, chat), queryClient);
  const record = read.data?.data;
  const [log, setLog] = useState<LogState | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const takeHeadingFocus = useEffectEvent(() => {
    if (focusOnMount) {
      focusInView(headingRef.current);
    }
  });

  useEffect(() => {
    takeHeadingFocus();
  }, []);

  return (
    <section aria-labelledby={headingId} className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3 border-b border-line px-6 py-3">
        <div className="min-w-0 flex-1">
          <h2
            ref={headingRef}
            id={headingId}
            tabIndex={-1}
            {...CHAT_HEADING_MARK}
            className="font-chrome text-base font-semibold wrap-anywhere"
          >
            {record === undefined ? `Chat ${String(chat)}` : `${chatAgentName(record.agent)} · ${record.step}`}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {record !== undefined && <span className="text-subtle">{`Chat ${String(chat)}`}</span>}
            {log?.ready === true && <StateMark status={log.status} />}
          </p>
        </div>
        <Tooltip content="Close the chat">
          <Button type="button" aria-label="Close the chat" onClick={onClose} className={ICON_BUTTON_CLASS}>
            <XIcon size={16} aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      <ChatBody tag={tag} task={task} chat={chat} headingRef={headingRef} onLog={setLog} />
    </section>
  );
}

type ChatBodyProps = ChatPlace & {
  /** The heading of the host, where the focus goes when an element of the body that has it goes away. */
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** Gets the log state of the transcript, null while no log runs. */
  onLog?: (log: LogState | null) => void;
  /** Added to the classes of the status line and of its Try again. */
  lineClassName?: string;
};

/**
 * The status line, the transcript and the announcements of one chat, live,
 * under the header of its host. The host lays it out in a flex column.
 */
export function ChatBody(props: ChatBodyProps): ReactNode {
  return <ChatBodyOfChat key={JSON.stringify([props.tag, props.task, props.chat])} {...props} />;
}

function ChatBodyOfChat({ tag, task, chat, headingRef, onLog, lineClassName = "" }: ChatBodyProps): ReactNode {
  const { client, queryClient } = useRouter().options.context;
  const read = useQuery(chatQuery(client, tag, task, chat), queryClient);
  // The log state of the current round of the transcript, null until its log runs.
  const [log, setLog] = useState<LogState | null>(null);
  const [round, setRound] = useState(0);
  const missing = isChatMissing(read.error);
  // After the log starts, a failed read of the record shows only when it says that the chat does not exist.
  const failed = read.error !== null && (log === null || missing);

  function changeLog(next: LogState | null): void {
    setLog(next);
    onLog?.(next);
  }

  function restart(): void {
    changeLog(null);
    setRound(round + 1);
  }

  return (
    <>
      <p role="status" className={`px-6 py-2 text-sm text-subtle empty:py-0 ${lineClassName}`}>{statusText(failed, missing, log)}</p>
      {failed && !missing && (
        <RetryButton
          headingRef={headingRef}
          className={lineClassName}
          onRetry={() => {
            void read.refetch();
          }}
        />
      )}
      <ChatRound
        key={round}
        tag={tag}
        task={task}
        chat={chat}
        headingRef={headingRef}
        onLog={changeLog}
        onReset={restart}
      />
    </>
  );
}

type RetryButtonProps = { headingRef: RefObject<HTMLHeadingElement | null>; className: string; onRetry: () => void };

/** Any read of the record can remove the button, also one the user did not start. Focus then goes to the heading. */
function RetryButton({ headingRef, className, onRetry }: RetryButtonProps): ReactNode {
  const ref = useRef<HTMLButtonElement>(null);

  useFocusLost(ref, () => {
    focusInView(headingRef.current);
  });

  return (
    <div className={`px-6 pb-2 ${className}`}>
      <Button
        ref={ref}
        type="button"
        onClick={() => {
          focusInView(headingRef.current);
          onRetry();
        }}
        className={BUTTON_CLASS}
      >
        Try again
      </Button>
    </div>
  );
}

/**
 * One round of the transcript, which a reset of the log ends. Its log starts
 * with a record read after the round began: a cached record, or one read
 * before a reset, can hold an old `seq`.
 */
function ChatRound(props: RoundProps): ReactNode {
  const { client, queryClient } = useRouter().options.context;
  const { tag, task, chat } = props;
  const read = useQuery({ ...chatQuery(client, tag, task, chat), refetchOnMount: "always" }, queryClient);
  const [started, setStarted] = useState(false);

  // A failed read also counts as fetched.
  if (!started && read.isFetchedAfterMount && read.isSuccess) {
    setStarted(true);
  }

  return started && <ChatTranscript {...props} client={client} record={read.data!.data} />;
}

function ChatTranscript(
  { client, tag, task, chat, record, headingRef, onLog, onReset }: RoundProps & { client: Client; record: Chat },
): ReactNode {
  const { view, ready: caughtUp, failures, resets } = useChatLog(client, tag, task, chat, record.seq);
  const ready = caughtUp && resets === 0;
  const { status, turn } = view.fold;
  const statusKey = JSON.stringify(status);
  const { agent, folder } = record;
  const beforeRef = useRef<ChatView | null>(null);
  const writes = useChatWrites({ tag, task, chat });
  const runtime = useExternalStoreRuntime({
    messages: view.messages,
    convertMessage: (message: ChatMessage) => chatThreadMessage(message, folder),
    // The whole turn, also while it waits at a request: the kit shows Stop and no Send.
    isRunning: turn,
    // The kit `canSend` does not read `isRunning`, and the daemon refuses a message during a turn.
    isSendDisabled: turn,
    onNew: (message) => writes.send(messageText(message)),
    onCancel: () => writes.cancel(),
    onRespondToToolApproval: (options) => writes.answer(chatRequestOf(view, options.approvalId), options),
  });
  const report = useEffectEvent(() => {
    onLog({ status, ready, failures });
  });
  const endRound = useEffectEvent(onReset);

  useEffect(() => {
    report();
  }, [statusKey, ready, failures]);

  useEffect(() => {
    if (resets > 0) {
      endRound();
    }
  }, [resets]);

  // The state of the chat when the log becomes ready is not news: only what
  // changes after that is announced.
  useEffect(() => {
    if (!ready) {
      beforeRef.current = null;
      return;
    }

    const before = beforeRef.current;
    beforeRef.current = view;
    if (before !== null) {
      for (const words of chatAnnouncements(before, view, agent)) {
        useNoticeStore.getState().announce(words);
      }
    }
  }, [ready, view, agent]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatDataViews tag={tag} task={task} chat={chat} />
      <ChatDraft tag={tag} task={task} chat={chat} />
      {ready && <ChatThread headingRef={headingRef} />}
    </AssistantRuntimeProvider>
  );
}

/** Keeps the composer text of the chat and its draft the same, both ways, from the mount on. */
function ChatDraft({ tag, task, chat }: ChatPlace): null {
  const aui = useAui();

  useEffect(() => {
    const place = { tag, task, chat };
    const fill = (draft: string): void => {
      if (draft !== aui.composer.getState().text) {
        aui.composer.setText(draft);
      }
    };

    fill(chatDraft(place));
    const stopDraft = subscribeChatDraft(place, fill);
    const stopComposer = aui.subscribe(() => {
      useChatDraftStore.getState().setDraft(place, aui.composer.getState().text);
    });
    return () => {
      stopDraft();
      stopComposer();
    };
  }, [aui, tag, task, chat]);

  return null;
}

/** The kit thread. When a reset removes it with focus inside, focus moves to the panel heading. */
function ChatThread({ headingRef }: { headingRef: RefObject<HTMLHeadingElement | null> }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);

  useFocusLost(ref, () => {
    focusInView(headingRef.current);
  });

  return (
    <div ref={ref} className="min-h-0 flex-1">
      <Thread autoFocus={false} components={THREAD_COMPONENTS} />
    </div>
  );
}
