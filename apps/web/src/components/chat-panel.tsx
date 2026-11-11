import { Button } from "@base-ui/react/button";
import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  useThreadViewport,
  type AppendMessage,
  type QueueItemState,
} from "@assistant-ui/react";
import { Thread, type ThreadComponents } from "@kit/components/assistant-ui/elements/thread.aui";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { chatBusy, turnRuns, type Chat, type ChatStatus, type Client, type ProjectChat } from "@tasma/protocol";
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useChatLog } from "../api/chat-log";
import { chatQuery, type ChatPlace } from "../api/queries";
import { chatRequestOf } from "../lib/chat-approval";
import type { ChatMessage } from "../lib/chat-fold";
import { chatAgentName, chatStateText, chatThreadMessage, isChatMissing, messageText } from "../lib/chat-messages";
import { WarningIcon, XIcon } from "../lib/icons";
import { CHAT_HEADING_MARK, CHAT_HEADING_SELECTOR, focusInView, KIT_INPUT } from "../lib/focus-in-view";
import { sayStartedWords } from "../lib/started-chat";
import { useChatOptionPicks, type ChatOptionPicks } from "../lib/use-chat-option-picks";
import { chatOpenMessageId, chatUserSeq, useChatScroll, type ChatScrollInput } from "../lib/use-chat-scroll";
import { useChatSeen, type SeenWatch } from "../lib/use-chat-seen";
import { useChatThreadFocus } from "../lib/use-chat-thread-focus";
import { useChatWrites } from "../lib/use-chat-writes";
import { focusDropped, useFocusLost } from "../lib/use-focus-lost";
import { chatDraft, subscribeChatDraft, useChatDraftStore, type ChatDraftPlace } from "../store/chat-drafts";
import { useUiStore } from "../store/ui";
import { ChatOptionMenu, ChatPickerRow } from "./chat-option-menu";
import { ChatDataViews, ChatEmpty, ChatToolGroup, ChatToolView } from "./chat-tool";
import { BUTTON_CLASS, ICON_BUTTON_CLASS } from "./control-classes";
import { Tooltip } from "./tooltip";

type ChatPanelProps = {
  tag: string;
  task: string;
  chat: number;
  /** The header shows the state. A busy chat shows it also when this is false. */
  marked: boolean;
  onClose: () => void;
  /** Move focus to the panel heading when the panel mounts. A host sets it when the user opens a chat. */
  focusOnMount?: boolean;
};

/** What the panel shows of the log that its transcript reads. `busy` is from `chatBusy`. */
type LogState = { status: ChatStatus; busy: boolean; ready: boolean; failures: number };

type RoundProps = ChatPlace & {
  headingRef: RefObject<HTMLHeadingElement | null>;
  onLog: (log: LogState) => void;
  onReset: () => void;
};

type TranscriptProps = RoundProps & { client: Client; record: Chat | ProjectChat };

/** What the transcript knows of `SeenWatch`. The tracker reads the viewport. */
type SeenInput = Omit<SeenWatch, "viewport">;

/** The open place of one round of the transcript. */
type ChatOpening = Pick<ChatScrollInput, "openId" | "lastId">;

/** What the transcript knows of `ChatScrollInput`. The scroll component reads the rest from the kit. */
type ScrollInput = ChatOpening & Pick<ChatScrollInput, "userSeq" | "ownTurn" | "onFollow">;

/** What `ChatTranscript` gives the composer slot through `extras` of the runtime, from the ready view on. */
type ComposerExtras = ChatOptionPicks & {
  seenWatch: SeenInput;
  scroll: ScrollInput;
  onFocusLost: () => void;
};

function isComposerExtras(extras: unknown): extras is ComposerExtras {
  return typeof extras === "object" && extras !== null && "pick" in extras;
}

/** It sits inside the thread viewport, so it can read the scroll box of the thread. */
function ChatSeenTracker(watch: SeenInput): null {
  const viewport = useThreadViewport((s) => s.element.viewport);

  useChatSeen({ ...watch, viewport });
  return null;
}

/** It sits inside the thread viewport, so it can read the scroll box and the messages of the thread. */
function ChatScroll(input: ScrollInput): null {
  const viewport = useThreadViewport((s) => s.element.viewport);
  const scrollToBottom = useThreadViewport((s) => s.scrollToBottom);
  const messages = useAuiState((s) => s.thread.messages);
  const atEnd = useThreadViewport((s) => s.isAtBottom);

  useChatScroll({ ...input, viewport, scrollToBottom, messages, atEnd });
  return null;
}

/**
 * The seen tracker, the scroll and the pickers in the composer. Their data
 * comes through the runtime extras, so `THREAD_COMPONENTS` stays one object: a
 * new one would change the context that every message of the thread reads.
 */
function ChatComposerStart(): ReactNode {
  const extras = useAuiState((s) => s.thread.extras);

  if (!isComposerExtras(extras)) {
    return null;
  }

  const { picks, pick, onFocusLost, seenWatch, scroll } = extras;
  return (
    <>
      <ChatSeenTracker {...seenWatch} />
      <ChatScroll {...scroll} />
      {picks.length > 0 && (
        <ChatPickerRow>
          {picks.map(({ option, hidden, pending }) => (
            <ChatOptionMenu
              key={option.category}
              option={option}
              hidden={hidden}
              pending={pending}
              onPick={(value) => {
                pick(option, value);
              }}
              onFocusLost={onFocusLost}
            />
          ))}
        </ChatPickerRow>
      )}
    </>
  );
}

const THREAD_COMPONENTS: ThreadComponents = {
  ToolFallback: ChatToolView,
  ToolGroup: ChatToolGroup,
  Welcome: ChatEmpty,
  ComposerStart: ChatComposerStart,
};

const NO_MESSAGES: readonly ChatMessage[] = [];

const NO_QUEUE_ITEMS: readonly QueueItemState[] = [];

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

function ChatPanelBody({ tag, task, chat, marked, onClose, focusOnMount = false }: ChatPanelProps): ReactNode {
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
            {log?.ready === true && (marked || log.busy) && <StateMark status={log.status} />}
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
  { client, tag, task, chat, record, headingRef, onLog, onReset }: TranscriptProps,
): ReactNode {
  const { view, ready: caughtUp, failures, resets } = useChatLog(client, tag, task, chat, record.seq);
  const ready = caughtUp && resets === 0;
  const { status, ownTurn } = view.fold;
  const running = turnRuns(view.fold);
  const statusKey = JSON.stringify(status);
  const busy = chatBusy(view.fold);
  const { agent, folder } = record;
  const [opening, setOpening] = useState<ChatOpening | null>(null);
  const [autoScroll, setAutoScroll] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);

  // One time per round: a later change of `seen`, `busy` or the messages does not move the open place.
  if (ready && opening === null) {
    setOpening({
      openId: chatOpenMessageId(view.messages, record.seen, busy),
      lastId: view.messages.at(-1)?.id,
    });
  }

  const place = { tag, task, chat };
  const writes = useChatWrites(place);
  // The message shows from its `user` event; a failed send puts its text back in the draft.
  const sendQueued = (message: AppendMessage) => {
    writes.send(messageText(message)).catch(() => undefined);
  };
  const optionPicks = useChatOptionPicks({ tag, task, chat, view, agent, ready, write: writes.pick });
  const extras: ComposerExtras | undefined = opening === null
    ? undefined
    : {
        ...optionPicks,
        seenWatch: { tag, task, chat, seq: view.seq, seen: record.seen, busy },
        scroll: { ...opening, userSeq: chatUserSeq(view.messages), ownTurn, onFollow: setAutoScroll },
        onFocusLost: () => {
          focusInView(headingRef.current);
        },
      };
  const runtime = useExternalStoreRuntime({
    // One view for the whole log: the thread mounts before the kit store takes the ready view, and a
    // message that the thread first sees as running shows its text only after the open scroll.
    messages: ready ? view.messages : NO_MESSAGES,
    convertMessage: (message: ChatMessage) => chatThreadMessage(message, folder),
    // The whole turn, also while it waits at a request: the kit shows Stop when the message input is empty.
    // A job wait shows no Stop.
    isRunning: ready && running,
    // With a queue, the kit sends each message here and never to `onNew`, also during a turn.
    queue: {
      items: NO_QUEUE_ITEMS,
      steerItems: NO_QUEUE_ITEMS,
      enqueue: sendQueued,
      steer: sendQueued,
      move: () => undefined,
      edit: () => undefined,
      remove: () => undefined,
    },
    onNew: (message) => writes.send(messageText(message)),
    onCancel: () => writes.cancel(),
    onRespondToToolApproval: (options) => writes.answer(chatRequestOf(view, options.approvalId), options),
    extras,
  });
  const report = useEffectEvent(() => {
    onLog({ status, busy, ready, failures });
  });
  const endRound = useEffectEvent(onReset);

  // The thread mounts after the runtime took the ready view, so the first `isRunning` of a busy chat
  // is no run start for its listeners. The kit delivers an event in a microtask, to the listeners at
  // that time. This microtask comes after that delivery.
  useEffect(() => {
    if (ready) {
      queueMicrotask(() => {
        setRuntimeReady(true);
      });
    }
  }, [ready]);

  useEffect(() => {
    report();
  }, [statusKey, busy, ready, failures]);

  useEffect(() => {
    if (resets > 0) {
      endRound();
    }
  }, [resets]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatDataViews tag={tag} task={task} chat={chat} />
      <ChatDraft place={place} />
      {ready && runtimeReady && <ChatThread place={place} headingRef={headingRef} autoScroll={autoScroll} />}
    </AssistantRuntimeProvider>
  );
}

/** Keeps the composer text and the draft of the place the same, both ways, from the mount on. */
export function ChatDraft({ place }: { place: ChatDraftPlace }): null {
  const aui = useAui();

  useEffect(() => {
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
  }, [aui, place]);

  return null;
}

/** The focus and the words of a start from the New chat view, when the composer of its chat shows. */
function useStartedChat(
  { tag, task, chat }: ChatPlace,
  threadRef: RefObject<HTMLElement | null>,
): void {
  // StrictMode runs the effect again after the cleanup of `useFocusLost` moved the focus to the heading.
  const focusAgainRef = useRef(false);
  const take = useEffectEvent(() => {
    const ui = useUiStore.getState();
    const started = ui.startedChat;
    const taken = task === undefined && started?.tag === tag && started.chat === chat;
    const focus = taken ? started.focus : focusAgainRef.current;

    focusAgainRef.current = taken && started.focus;
    if (focus && (focusDropped() || document.activeElement!.matches(CHAT_HEADING_SELECTOR))) {
      focusInView(threadRef.current!.querySelector<HTMLElement>(KIT_INPUT));
    }
    if (taken) {
      sayStartedWords();
      ui.setStartedChat(null);
    }
  });

  useEffect(() => {
    take();
  }, []);
}

/** The kit thread. When a reset removes it with focus inside, focus moves to the panel heading. */
function ChatThread(
  { place, headingRef, autoScroll }: {
    place: ChatPlace;
    headingRef: RefObject<HTMLHeadingElement | null>;
    autoScroll: boolean;
  },
): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const focusHeading = (): void => {
    focusInView(headingRef.current);
  };
  const focusEvents = useChatThreadFocus(ref, focusHeading);

  useFocusLost(ref, focusHeading);
  useStartedChat(place, ref);

  return (
    <div ref={ref} {...focusEvents} className="min-h-0 flex-1">
      <Thread autoFocus={false} components={THREAD_COMPONENTS} autoScroll={autoScroll} />
    </div>
  );
}
