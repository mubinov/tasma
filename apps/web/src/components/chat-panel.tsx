import { Button } from "@base-ui/react/button";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import { Thread, type ThreadComponents } from "@kit/components/assistant-ui/elements/thread.aui";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ProtocolError, type Chat, type ChatStatus, type Client } from "@tasma/protocol";
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useChatLog } from "../api/chat-log";
import { chatQuery } from "../api/queries";
import type { ChatMessage, ChatView } from "../lib/chat-fold";
import { chatAgentName, chatAnnouncements, chatOutsideName, chatThreadMessage } from "../lib/chat-messages";
import { WarningIcon, XIcon } from "../lib/icons";
import { focusInView } from "../lib/focus-in-view";
import { useFocusLost } from "../lib/use-focus-lost";
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

type ChatPlace = { tag: string; task: string; chat: number };

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

function refuseMessage(): Promise<void> {
  return Promise.reject(new Error("The chat panel sends no messages."));
}

function isChatNotFound(error: Error | null): boolean {
  return error instanceof ProtocolError && error.failure.code === "chat-not-found";
}

function StateMark({ status }: { status: ChatStatus }): ReactNode {
  switch (status.state) {
    case "working":
      return (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-running" />
          Agent works
        </span>
      );
    case "needs-you":
      return (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-signal" />
          Needs you
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1.5">
          <WarningIcon size={14} aria-hidden="true" className="shrink-0 text-signal" />
          Failed
        </span>
      );
    case "continued-outside":
      return <span className="text-subtle">{`Continued in ${chatOutsideName(status.where)}`}</span>;
  }
}

function statusText(failed: boolean, notFound: boolean, log: LogState | null): string {
  if (failed) {
    return notFound ? "This chat does not exist." : "The chat cannot be read.";
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
  // The log state of the current round of the transcript, null until its log runs.
  const [log, setLog] = useState<LogState | null>(null);
  const [round, setRound] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const notFound = isChatNotFound(read.error);
  const failed = log === null && read.error !== null;
  const takeHeadingFocus = useEffectEvent(() => {
    if (focusOnMount) {
      focusInView(headingRef.current);
    }
  });

  useEffect(() => {
    takeHeadingFocus();
  }, []);

  function restart(): void {
    setLog(null);
    setRound(round + 1);
  }

  return (
    <section aria-labelledby={headingId} className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3 border-b border-line px-6 py-3">
        <div className="min-w-0 flex-1">
          <h2 ref={headingRef} id={headingId} tabIndex={-1} className="font-chrome text-base font-semibold wrap-anywhere">
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
      <p role="status" className="px-6 py-2 text-sm text-subtle empty:py-0">{statusText(failed, notFound, log)}</p>
      {failed && !notFound && (
        <RetryButton
          headingRef={headingRef}
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
        onLog={setLog}
        onReset={restart}
      />
    </section>
  );
}

type RetryButtonProps = { headingRef: RefObject<HTMLHeadingElement | null>; onRetry: () => void };

/** Any read of the record can remove the button, also one the user did not start. Focus then goes to the heading. */
function RetryButton({ headingRef, onRetry }: RetryButtonProps): ReactNode {
  const ref = useRef<HTMLButtonElement>(null);

  useFocusLost(ref, () => {
    focusInView(headingRef.current);
  });

  return (
    <div className="px-6 pb-2">
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
  const { status } = view.fold;
  const statusKey = JSON.stringify(status);
  const { agent, folder } = record;
  const beforeRef = useRef<ChatView | null>(null);
  const runtime = useExternalStoreRuntime({
    messages: view.messages,
    convertMessage: (message: ChatMessage) => chatThreadMessage(message, folder),
    isRunning: status.state === "working",
    isDisabled: true,
    onNew: refuseMessage,
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
      <ChatDataViews />
      {ready && <ChatThread headingRef={headingRef} />}
    </AssistantRuntimeProvider>
  );
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
