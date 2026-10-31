import { mutationOptions, useMutationState, type QueryClient } from "@tanstack/react-query";
import type { RegisteredRouter } from "@tanstack/react-router";
import {
  ProtocolError,
  type Chat,
  type ChatStart,
  type Client,
  type Diagnostic,
  type QuestionValue,
  type Success,
} from "@tasma/protocol";
import { CHAT_HEADING_SELECTOR, focusChatHeading } from "../../lib/focus-in-view";
import { latestOnTask, STEP_ACTION_SELECTOR } from "../../lib/step-action";
import { useNoticeStore } from "../../store/notices";
import { daemonKeys, type ChatPlace } from "../queries";
import { openWriteNotice, refusalWords, usePendingVariables, WriteError, type WriteFailure } from "./notices";

/** The texts of the warning notice after `already-answered`. */
export type ClosedNotice = { title: string; line: string };

/** The texts of the warning notice of an option write that the daemon did not save. */
export type SavedNotice = { title: string; line: string };

/** The texts of the warning notice of a restart that was not sent. */
export type SkippedNotice = { title: string; line: string };

export type ChatQuestionReply
  = | { action: "accept"; content: Readonly<Record<string, QuestionValue>> }
    | { action: "decline" };

/** One write into a chat. The variables carry the texts of the notices. */
export type ChatWrite = { failure: WriteFailure } & (
  /** `restartingLine`: the line of a refusal with `turn-running` while this window restarts the task from the chat. */
  | { kind: "message"; text: string; restartingLine: string }
  | { kind: "cancel" }
  | { kind: "permission"; request: string; optionId: string; closed: ClosedNotice }
  | { kind: "question"; request: string; answer: ChatQuestionReply; closed: ClosedNotice }
  | { kind: "option"; configId: string; value: string; saved: SavedNotice }
);

export type ChatOptionWrite = Extract<ChatWrite, { kind: "option" }>;

const CHAT_FAILURE_KEY_PREFIX = "chat-write-failure:";

/**
 * The client id of this window, in the events that its writes cause, so the
 * log tells the writes of two windows apart. A reload gets a new one.
 */
export const CHAT_CLIENT = `app-${[...crypto.getRandomValues(new Uint8Array(4))]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("")}`;

export function chatWriteKey({ tag, task, chat }: ChatPlace) {
  return [...daemonKeys.chat(tag, task, chat), "write"] as const;
}

/** One notice for each chat and kind of write, so a new failure replaces the last one. */
export function chatFailureKey({ tag, task, chat }: ChatPlace, kind: ChatWrite["kind"]): string {
  return `${CHAT_FAILURE_KEY_PREFIX}${tag}/${task}/${String(chat)}:${kind}`;
}

/** The code of the refusal that a write failed with, also inside a `WriteError`. */
export function chatRefusalCode(error: unknown): string | undefined {
  const cause = error instanceof WriteError ? error.cause : error;
  return cause instanceof ProtocolError ? cause.failure.code : undefined;
}

async function send(
  client: Client,
  { tag, task, chat }: ChatPlace,
  write: ChatWrite,
): Promise<Success<Chat> | undefined> {
  const body = { client: CHAT_CLIENT };

  switch (write.kind) {
    case "message":
      await client.sendChatMessage(tag, task, chat, { ...body, text: write.text });
      return undefined;
    case "cancel":
      await client.cancelChatTurn(tag, task, chat, body);
      return undefined;
    case "permission":
      await client.answerChatPermission(tag, task, chat, write.request, { ...body, optionId: write.optionId });
      return undefined;
    case "question":
      await client.answerChatQuestion(tag, task, chat, write.request, { ...write.answer, ...body });
      return undefined;
    case "option":
      return client.setChatOption(tag, task, chat, { ...body, configId: write.configId, value: write.value });
  }
}

/** `option-not-saved` keeps the file in `path`, which `noticeWords` leaves out. */
function savedWords(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map(({ path, message }) => (path === undefined ? message : `${path}: ${message}`));
}

/** A restart of the task that replaces the chat is pending in this window. */
function restartPending(queryClient: QueryClient, { tag, task, chat }: ChatPlace): boolean {
  return queryClient.getMutationCache()
    .findAll({ mutationKey: chatStartKey(), exact: true, status: "pending" })
    .some(({ state }) => {
      const start = state.variables as StartChat | undefined;
      return start?.tag === tag && start.id === task && start.restart === chat;
    });
}

/**
 * The writes into one chat. The log shows their result, so a write changes no
 * cache. No scope: a Stop does not wait for a write in flight, and the daemon
 * puts the commands of one chat in order.
 */
export function chatWriteOptions(queryClient: QueryClient, client: Client, place: ChatPlace) {
  return mutationOptions<Success<Chat> | undefined, WriteError, ChatWrite>({
    mutationKey: chatWriteKey(place),
    mutationFn: async (write) => {
      try {
        return await send(client, place, write);
      } catch (cause) {
        throw new WriteError(cause);
      }
    },
    // A write whose answer is lost can be done already.
    retry: 0,
    onSuccess: (answer, write) => {
      const key = chatFailureKey(place, write.kind);
      const diagnostics = answer?.diagnostics ?? [];

      if (write.kind === "option" && diagnostics.length > 0) {
        const { title, line } = write.saved;
        openWriteNotice({ key, form: "warning", title, line, words: savedWords(diagnostics) });
        return;
      }
      useNoticeStore.getState().closeNotice(key);
    },
    onError: (error, write) => {
      const key = chatFailureKey(place, write.kind);
      const words = [refusalWords(error)];

      if ((write.kind === "permission" || write.kind === "question") && chatRefusalCode(error) === "already-answered") {
        openWriteNotice({ key, form: "warning", title: write.closed.title, line: write.closed.line, words });
        return;
      }
      const line = write.kind === "message" && chatRefusalCode(error) === "turn-running" && restartPending(queryClient, place)
        ? write.restartingLine
        : write.failure.line(error);
      openWriteNotice({ key, form: "failure", title: write.failure.title, line, words });
    },
  });
}

/**
 * A move of `seen` of one chat to a `seq`. The `chat` feed event of the move
 * makes the lists read again, so the write changes no cache and shows no
 * notice. Its key is not under `chatWriteKey`, so no pending write shows it.
 */
export function chatSeenOptions(client: Client, { tag, task, chat }: ChatPlace) {
  return mutationOptions<Success<Chat>, Error, number>({
    mutationKey: [...daemonKeys.chat(tag, task, chat), "seen"],
    mutationFn: (seq) => client.markChatSeen(tag, task, chat, { seq, client: CHAT_CLIENT }),
    retry: 0,
  });
}

/** A start of the chat of a step. The variables carry the texts of the failure notice. */
export type StartChat = {
  tag: string;
  id: string;
  /** The step that the action shows. The daemon runs the step that it holds. */
  step: string;
  from: "task" | "card";
  /** The chat that a restart replaces. Without it, the start gives back the chat that the step has. */
  restart?: number;
  failure: WriteFailure;
};

/** Under the prefix `usePendingVariables` reads. */
export function chatStartKey() {
  return [...daemonKeys.projects(), "chat-start"] as const;
}

export function chatStartFailureTitle(step: string, id: string): string {
  return `The ${step} chat of ${id} did not start`;
}

export function chatRestartFailureTitle(step: string, id: string): string {
  return `The ${step} chat of ${id} did not restart`;
}

function chatStartFailureKey(id: string): string {
  return `chat-start-failure:${id}`;
}

function chatRestartSkippedKey(id: string): string {
  return `chat-restart-skipped:${id}`;
}

/** The warning of a restart that was not sent, because its chat is no longer the chat of its step. */
export function openRestartSkipped(id: string, { title, line }: SkippedNotice): void {
  openWriteNotice({ key: chatRestartSkippedKey(id), form: "warning", title, line, words: [] });
}

/**
 * Focus is where a start leaves it: on a part of the step action, on `<main>`
 * itself or on `<body>`. A restart also leaves it on the heading of the panel
 * that shows the chat it replaces.
 */
function focusWaits(router: RegisteredRouter, { restart }: StartChat): boolean {
  const active = document.activeElement;

  if (active === null || active === document.body || active.matches("main") || active.closest(STEP_ACTION_SELECTOR) !== null) {
    return true;
  }
  return restart !== undefined
    && router.latestLocation.search.chat === String(restart)
    && active.matches(CHAT_HEADING_SELECTOR);
}

type Panel = "opened" | "shown" | null;

/**
 * Opens the chat in the panel when the task view of the start shows and focus
 * waits: "opened" by a navigation, "shown" when the panel shows it already.
 */
async function openPanel(router: RegisteredRouter, start: StartChat, chat: number): Promise<Panel> {
  const { tag, id, from } = start;
  const params = { project: tag, task: id };

  if (!latestOnTask(router, tag, id) || !focusWaits(router, start)) {
    return null;
  }
  if (router.latestLocation.search.chat === String(chat)) {
    focusChatHeading();
    return "shown";
  }
  // Resolves once the panel has rendered.
  await router.navigate({ to: "/tasks/$project/$task", params, search: { chat: String(chat) }, replace: from === "card" });
  return "opened";
}

function startWords(name: string, { chat, started }: ChatStart, panel: Panel, restart: boolean): string | null {
  if (chat.state === "failed") {
    return `${name} failed.`;
  }
  // The heading of the panel is the same for the old chat and the new one.
  if (restart) {
    return `${name} restarted.`;
  }
  if (panel === null) {
    return started ? `${name} started.` : `${name} is in its chats.`;
  }
  // A panel that opens speaks its heading. One that shows the chat already says nothing new.
  return panel === "shown" && !started ? `${name} is in its chats.` : null;
}

/**
 * The start of the chat of the current step of a task. No scope: a first start
 * can take seconds, and the one queue holds the writes of all projects. The
 * write speaks for its own start on every screen.
 */
export function chatStartOptions(queryClient: QueryClient, client: Client, router: RegisteredRouter) {
  return mutationOptions<ChatStart, WriteError, StartChat>({
    mutationKey: chatStartKey(),
    mutationFn: async ({ tag, id, restart }) => {
      const input = restart === undefined ? { client: CHAT_CLIENT } : { client: CHAT_CLIENT, restart: true };

      try {
        return (await client.startChat(tag, id, input)).data;
      } catch (cause) {
        throw new WriteError(cause);
      }
    },
    // A start whose answer is lost may have started a chat, and a restart sent again stops it.
    retry: 0,
    onMutate: ({ id, step, restart }) => {
      useNoticeStore.getState().closeNotice(chatRestartSkippedKey(id));
      useNoticeStore.getState().announce(`${restart === undefined ? "Starting" : "Restarting"} the ${step} chat of ${id}`);
    },
    onSuccess: async (answer, start) => {
      const { tag, id } = start;
      useNoticeStore.getState().closeNotice(chatStartFailureKey(id));
      // Awaited, so the list holds the chat before the panel opens.
      await queryClient.invalidateQueries({ queryKey: daemonKeys.taskChats(tag, id), exact: true });
      const panel = await openPanel(router, start, answer.chat.chat);
      const words = startWords(`The ${answer.chat.step} chat of ${id}`, answer, panel, start.restart !== undefined);

      if (words !== null) {
        useNoticeStore.getState().announce(words);
      }
    },
    onError: (error, { id, failure }) => {
      openWriteNotice({
        key: chatStartFailureKey(id),
        form: "failure",
        title: failure.title,
        line: failure.line(error),
        words: [refusalWords(error)],
      });
    },
  });
}

/** The pending option writes of the chat, in the order they were sent. */
export function usePendingChatOptions(place: ChatPlace): ChatOptionWrite[] {
  return usePendingVariables<ChatWrite>(chatWriteKey(place))
    .map(({ variables }) => variables)
    .filter((write) => write.kind === "option");
}

export function usePendingChatStart(id: string): StartChat | undefined {
  return usePendingVariables<StartChat>(chatStartKey())
    .map(({ variables }) => variables)
    .findLast((start) => start.id === id);
}

/** The answered chat of the last start of the task that succeeded, when that chat failed. */
export function useFailedChatStart(id: string): Pick<Chat, "chat" | "state"> | undefined {
  const answers = useMutationState({
    filters: { mutationKey: chatStartKey(), status: "success" },
    select: ({ state: { variables, data } }) => ({ start: variables as StartChat, answer: data as ChatStart }),
  });
  const last = answers.findLast(({ start }) => start.id === id)?.answer.chat;

  return last?.state === "failed" ? { chat: last.chat, state: last.state } : undefined;
}
