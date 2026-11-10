import { mutationOptions, useMutationState, type QueryClient } from "@tanstack/react-query";
import type { RegisteredRouter } from "@tanstack/react-router";
import {
  ProtocolError,
  type Chat,
  type ChatStart,
  type Client,
  type Diagnostic,
  type ProjectChat,
  type ProjectChatStart,
  type QuestionValue,
  type Success,
} from "@tasma/protocol";
import { CHAT_HEADING_SELECTOR, focusChatHeading, NEW_CHAT_SELECTOR } from "../../lib/focus-in-view";
import { searchWords } from "../../lib/match-ranges";
import { sayStartedWords } from "../../lib/started-chat";
import { latestOnTask, STEP_ACTION_SELECTOR } from "../../lib/step-action";
import { chatFilterOf } from "../../lib/use-chat-filter";
import { focusDropped } from "../../lib/use-focus-lost";
import { NEW_CHAT_DRAFT, chatDraft, useChatDraftStore } from "../../store/chat-drafts";
import { useNoticeStore } from "../../store/notices";
import { useUiStore, type StartedChat } from "../../store/ui";
import { chatListQuery, chatPlaceText, chatRecordKey, daemonKeys, projectsQuery, type ChatFilter, type ChatPlace } from "../queries";
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

export function chatWriteKey(place: ChatPlace) {
  return [...chatRecordKey(place), "write"] as const;
}

/** One notice for each chat and kind of write, so a new failure replaces the last one. */
export function chatFailureKey(place: ChatPlace, kind: ChatWrite["kind"]): string {
  return `${CHAT_FAILURE_KEY_PREFIX}${chatPlaceText(place)}:${kind}`;
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
): Promise<Success<Chat | ProjectChat> | undefined> {
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
  return mutationOptions<Success<Chat | ProjectChat> | undefined, WriteError, ChatWrite>({
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
 * A move of `seen` of one chat to a `seq`. The `chat` or `project-chat` feed
 * event of the move makes the lists read again, so the write changes no cache
 * and shows no notice. Its key is not under `chatWriteKey`, so no pending write
 * shows it.
 */
export function chatSeenOptions(client: Client, place: ChatPlace) {
  const { tag, task, chat } = place;

  return mutationOptions<Success<Chat | ProjectChat>, Error, number>({
    mutationKey: [...chatRecordKey(place), "seen"],
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
  from: "task" | "card" | "dashboard";
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
 * itself or on `<body>`. A restart also leaves it on the heading that shows the
 * chat it replaces.
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

async function openOnDashboard(router: RegisteredRouter, start: StartChat, chat: number): Promise<Panel> {
  const { task, chat: shown } = router.latestLocation.search;

  if (task !== start.id || shown !== String(start.restart) || !focusWaits(router, start)) {
    return null;
  }
  await router.navigate({ to: "/", search: (previous) => ({ ...previous, chat: String(chat) }), replace: true, resetScroll: false });
  focusChatHeading();
  return "opened";
}

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
  // The heading is the same for the old chat and the new one.
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
      // Awaited, so the list holds the chat before it opens.
      await queryClient.invalidateQueries({ queryKey: daemonKeys.taskChats(tag, id), exact: true });
      const open = start.from === "dashboard" ? openOnDashboard : openPanel;
      const panel = await open(router, start, answer.chat.chat);
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

export type NewChatStart = { tag: string; text: string };

export type ProjectChatStartWrite = { start: NewChatStart; failure: WriteFailure };

const PROJECT_CHAT_START_FAILURE_KEY = "project-chat-start-failure";

/** Under the prefix `usePendingVariables` reads. */
export function projectChatStartKey() {
  return [...daemonKeys.projects(), "project-chat-start"] as const;
}

function newChatShown({ latestLocation: { pathname, search } }: RegisteredRouter): boolean {
  return pathname === "/" && search.new === "1";
}

/** The filter parts of an address that do not hide a chat with this tag and title, by the rule of the daemon. */
function filterShowing({ project, q }: ChatFilter, tag: string, title: string): ChatFilter {
  const text = `${tag}\n${title}`.toLowerCase();

  return {
    project: project === tag ? project : undefined,
    q: q !== undefined && searchWords(q).every((word) => text.includes(word)) ? q : undefined,
  };
}

function clearedWords(before: ChatFilter, after: ChatFilter): string | null {
  const projectCleared = before.project !== after.project;
  const searchCleared = before.q !== after.q;

  if (projectCleared && searchCleared) {
    return "The project filter and the search were cleared.";
  }
  if (projectCleared) {
    return "The project filter was cleared.";
  }
  return searchCleared ? "The search was cleared." : null;
}

function focusIsInNewChat(): boolean {
  return focusDropped() || document.activeElement!.closest(NEW_CHAT_SELECTOR) !== null;
}

type OpenedChat = { tag: string; chat: number; title: string; words: string; cleared: string | null };

/** The view gives its address to the new chat, and the text typed during the wait moves to it. */
async function openNewChat(router: RegisteredRouter, { tag, chat, title, words, cleared }: OpenedChat): Promise<void> {
  const focus = focusIsInNewChat();
  const place = { tag, task: undefined, chat };

  useUiStore.getState().setStartedChat({ tag, chat, focus, words: cleared === null ? words : `${words} ${cleared}` });
  await router.navigate({
    to: "/",
    search: (previous) => ({
      ...previous,
      ...filterShowing(previous, tag, title),
      tag,
      chat: String(chat),
      task: undefined,
      new: undefined,
    }),
    replace: true,
    resetScroll: false,
  });
  useChatDraftStore.getState().setDraft(place, chatDraft(NEW_CHAT_DRAFT));
  useChatDraftStore.getState().setDraft(NEW_CHAT_DRAFT, "");

  if (focus) {
    // The chat may have taken the focus already, when its composer shows before the navigation ends.
    if (useUiStore.getState().startedChat !== null) {
      focusChatHeading();
    }
    return;
  }
  // With a new filter, the screen says the words before the count of the new list.
  if (cleared === null) {
    sayStartedWords();
  }
}

/**
 * The start of a chat of a project from the New chat view. The answer opens the
 * chat when the view still shows, and the list holds it before it opens.
 */
export function projectChatStartOptions(queryClient: QueryClient, client: Client, router: RegisteredRouter) {
  return mutationOptions<ProjectChatStart, WriteError, ProjectChatStartWrite>({
    mutationKey: projectChatStartKey(),
    mutationFn: async ({ start: { tag, text } }) => {
      try {
        return (await client.startProjectChat(tag, { text, client: CHAT_CLIENT })).data;
      } catch (cause) {
        throw new WriteError(cause);
      }
    },
    // Each call makes a new chat.
    retry: 0,
    onMutate: ({ start: { tag } }) => {
      useNoticeStore.getState().closeNotice(PROJECT_CHAT_START_FAILURE_KEY);
      useNoticeStore.getState().announce(`Starting a chat in ${tag}`);
    },
    onSuccess: async ({ chat: { chat, title, state } }, { start: { tag } }) => {
      const ui = useUiStore.getState();
      const words = `Chat ${String(chat)} of ${tag} ${state === "failed" ? "failed" : "started"}.`;
      const shown = newChatShown(router);
      const { search } = router.latestLocation;
      const projects = queryClient.getQueryData(projectsQuery(client).queryKey)?.data ?? [];
      const before = chatFilterOf(search, projects);
      const after = chatFilterOf(filterShowing(search, tag, title), projects);
      const cleared = shown ? clearedWords(before, after) : null;
      const started: StartedChat = { tag, chat, focus: false, words };

      ui.noteChatStartAnswer(Date.now());
      ui.setLastChatProject(tag);
      if (shown) {
        ui.setStartedChat(started);
      }
      await queryClient.invalidateQueries({ queryKey: daemonKeys.chats() });
      if (cleared !== null) {
        await queryClient.infiniteQuery({ ...chatListQuery(client, after), staleTime: 0 }).catch(() => undefined);
      }
      if (!shown) {
        useNoticeStore.getState().announce(words);
        return;
      }
      // Another place took the started chat when the user left the view during the reads. A view opened again is not
      // the view of this start.
      if (newChatShown(router) && useUiStore.getState().startedChat === started) {
        await openNewChat(router, { tag, chat, title, words, cleared });
      }
    },
    onError: (error, { start: { text }, failure }) => {
      useUiStore.getState().setChatStartWatch(null);
      useChatDraftStore.getState().returnToDraft(NEW_CHAT_DRAFT, text);
      openWriteNotice({
        key: PROJECT_CHAT_START_FAILURE_KEY,
        form: "failure",
        title: failure.title,
        line: failure.line(error),
        words: [refusalWords(error)],
      });
    },
  });
}

export function usePendingProjectChatStart(): ProjectChatStartWrite | undefined {
  return usePendingVariables<ProjectChatStartWrite>(projectChatStartKey()).at(-1)?.variables;
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
