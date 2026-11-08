// The routes over the chats of one task and the project chats of one project:
// the list of the chats of a task, the start of the chat of the current step,
// the start of a project chat, one chat, a long-poll read of the log of one
// chat after a cursor, and the commands of a client on a chat: a message, a
// cancel, an answer, a pick of a config option and a move of `seen`.

import { routes } from "@tasma/protocol";
import type {
  Chat,
  ChatCancelInput,
  ChatEventsReply,
  ChatMessageInput,
  ChatOptionChange,
  ChatSeenInput,
  ChatStart,
  ChatStartInput,
  Diagnostic,
  PermissionAnswer,
  ProjectChat,
  ProjectChatStart,
  QuestionAnswer,
  QuestionValue,
  Route,
  Success,
} from "@tasma/protocol";
import { DaemonError } from "../http/failure.js";
import type { HandlerRequest, RouteEntry } from "../http/router.js";
import { assertNoQuery, readChatEventsQuery } from "../tasks/filter.js";
import type { AnyLiveChat, ChatRegistry } from "./registry.js";
import type { ChatRunner } from "./runner.js";
import type { StepChats } from "./start.js";

/** The most bytes of entries in one reply. A reply always holds at least one entry, however large. */
const CHAT_REPLY_BYTES = 1024 * 1024;

const CHAT_NUMBER = /^[1-9]\d*$/;

const CLIENT_MAX_LENGTH = 100;

type Accept = Extract<QuestionAnswer, { action: "accept" }>;

type Decline = Extract<QuestionAnswer, { action: "decline" }>;

const MESSAGE_KEYS = Object.keys({ text: true, client: true } satisfies Record<keyof ChatMessageInput, true>);

const CANCEL_KEYS = Object.keys({ client: true } satisfies Record<keyof ChatCancelInput, true>);

const START_KEYS = Object.keys({ client: true } satisfies Record<keyof Omit<ChatStartInput, "restart">, true>);

const RESTART_KEYS = Object.keys({ client: true, restart: true } satisfies Record<keyof ChatStartInput, true>);

const PERMISSION_KEYS = Object.keys({ optionId: true, client: true } satisfies Record<keyof PermissionAnswer, true>);

const ACCEPT_KEYS = Object.keys({ action: true, content: true, client: true } satisfies Record<keyof Accept, true>);

const DECLINE_KEYS = Object.keys({ action: true, client: true } satisfies Record<keyof Decline, true>);

const OPTION_KEYS = Object.keys(
  { configId: true, value: true, client: true } satisfies Record<keyof ChatOptionChange, true>,
);

const SEEN_KEYS = Object.keys({ seq: true, client: true } satisfies Record<keyof ChatSeenInput, true>);

type FindChat = (request: HandlerRequest) => Promise<AnyLiveChat>;

type PerChatRoutes = Record<
  "read" | "events" | "message" | "cancel" | "permission" | "question" | "option" | "seen",
  Route
>;

/** The chat a path names. Any other text is 0, which `assertChatNumber` refuses as no chat. */
export function chatOf(segment: string): number {
  const chat = Number(segment);
  return CHAT_NUMBER.test(segment) && Number.isSafeInteger(chat) ? chat : 0;
}

function malformed(message: string): DaemonError {
  return new DaemonError("malformed-request", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw malformed("the request body must be a JSON object");
  return body;
}

/** Refuses a body whose keys are not exactly `keys`. */
function assertKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  const given = Object.keys(body);
  if (given.length !== keys.length || !keys.every((key) => Object.hasOwn(body, key))) {
    throw malformed(`the request body takes exactly the keys ${keys.map((key) => `"${key}"`).join(", ")}`);
  }
}

function clientOf(body: Record<string, unknown>): string {
  const { client } = body;
  if (typeof client !== "string" || client.length < 1 || client.length > CLIENT_MAX_LENGTH) {
    throw malformed(`"client" takes a string of 1 to ${CLIENT_MAX_LENGTH} characters`);
  }
  return client;
}

function isQuestionValue(value: unknown): value is QuestionValue {
  if (Array.isArray(value)) return value.every((item) => typeof item === "string");
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function readMessage(raw: unknown): ChatMessageInput {
  const body = objectBody(raw);
  assertKeys(body, MESSAGE_KEYS);
  const { text } = body;
  if (typeof text !== "string" || !/\S/.test(text)) {
    throw malformed('"text" takes a string with at least one character that is not whitespace');
  }
  return { text, client: clientOf(body) };
}

function readCancel(raw: unknown): ChatCancelInput {
  const body = objectBody(raw);
  assertKeys(body, CANCEL_KEYS);
  return { client: clientOf(body) };
}

function readStart(raw: unknown): ChatStartInput {
  const body = objectBody(raw);
  const restarting = Object.hasOwn(body, "restart");
  assertKeys(body, restarting ? RESTART_KEYS : START_KEYS);
  const client = clientOf(body);
  if (!restarting) return { client };
  const { restart } = body;
  if (typeof restart !== "boolean") throw malformed('"restart" takes true or false');
  return { client, restart };
}

function readPermissionAnswer(raw: unknown): PermissionAnswer {
  const body = objectBody(raw);
  assertKeys(body, PERMISSION_KEYS);
  const { optionId } = body;
  if (typeof optionId !== "string" || optionId === "") throw malformed('"optionId" takes a non-empty string');
  return { optionId, client: clientOf(body) };
}

function readQuestionAnswer(raw: unknown): QuestionAnswer {
  const body = objectBody(raw);
  const { action } = body;
  if (action === "decline") {
    assertKeys(body, DECLINE_KEYS);
    return { action, client: clientOf(body) };
  }
  if (action !== "accept") throw malformed('"action" takes "accept" or "decline"');
  assertKeys(body, ACCEPT_KEYS);
  const { content } = body;
  if (!isObject(content) || !Object.values(content).every(isQuestionValue)) {
    throw malformed('"content" takes an object whose values are strings, numbers, booleans or arrays of strings');
  }
  return { action, content: content as Accept["content"], client: clientOf(body) };
}

function readOptionChange(raw: unknown): ChatOptionChange {
  const body = objectBody(raw);
  assertKeys(body, OPTION_KEYS);
  const { configId, value } = body;
  if (typeof configId !== "string" || configId === "") throw malformed('"configId" takes a non-empty string');
  if (typeof value !== "string" || value === "") throw malformed('"value" takes a non-empty string');
  return { configId, value, client: clientOf(body) };
}

function readSeenInput(raw: unknown): ChatSeenInput {
  const body = objectBody(raw);
  assertKeys(body, SEEN_KEYS);
  const { seq } = body;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) throw malformed('"seq" takes a non-negative integer');
  return { seq, client: clientOf(body) };
}

/**
 * The entries after `after`, or a hold until the next one. The check of the
 * `seq` and the start of the wait run in one synchronous step, so an append
 * between them is never lost.
 */
async function readAfter(find: () => Promise<AnyLiveChat>, after: number): Promise<ChatEventsReply> {
  let live = await find();
  if (after === live.chat.seq) {
    await live.wait();
    live = await find();
  }
  const { seq } = live.chat;
  if (after > seq) return { reset: true, cursor: 0 };
  if (after === seq) return { cursor: after, entries: [] };
  // Never empty: the log gives at least one entry where one exists.
  const entries = await live.read(after, CHAT_REPLY_BYTES);
  return { cursor: entries.at(-1)!.seq, entries };
}

export function chatRoutes(chats: ChatRegistry, runner: ChatRunner, starts: StepChats): RouteEntry[] {
  function perChatRoutes(find: FindChat, names: PerChatRoutes): RouteEntry[] {
    /**
     * Checks the query and the body before it gets the chat, and answers the
     * chat after the command, with the diagnostics that the command gives.
     */
    function command<T>(
      read: (body: unknown) => T,
      run: (live: AnyLiveChat, input: T, request: HandlerRequest) => Promise<Diagnostic[] | void>,
    ) {
      return async (request: HandlerRequest): Promise<Success<Chat | ProjectChat>> => {
        assertNoQuery(request.query);
        const input = read(request.body);
        const live = await find(request);
        const diagnostics = (await run(live, input, request)) ?? [];
        return { data: live.chat, diagnostics };
      };
    }

    return [
      {
        route: names.read,
        handler: async (request): Promise<Success<Chat | ProjectChat>> => {
          assertNoQuery(request.query);
          const live = await find(request);
          return { data: live.chat, diagnostics: live.diagnostics };
        },
      },
      {
        route: names.events,
        // No diagnostics, so a long-poll loop does not get the same finding at each reply.
        handler: async (request): Promise<Success<ChatEventsReply>> => {
          const { after } = readChatEventsQuery(request.query);
          return { data: await readAfter(() => find(request), after), diagnostics: [] };
        },
      },
      {
        route: names.message,
        handler: command(readMessage, (live, input) => runner.message(live, input)),
      },
      {
        route: names.cancel,
        handler: command(readCancel, (live, input) => runner.cancel(live, input)),
      },
      {
        route: names.permission,
        handler: command(readPermissionAnswer, (live, answer, request) =>
          runner.answerPermission(live, request.params.request!, answer)),
      },
      {
        route: names.question,
        handler: command(readQuestionAnswer, (live, answer, request) =>
          runner.answerQuestion(live, request.params.request!, answer)),
      },
      {
        route: names.option,
        handler: command(readOptionChange, (live, change) => runner.setOption(live, change)),
      },
      {
        route: names.seen,
        handler: command(readSeenInput, (live, input) => live.setSeen(input.seq)),
      },
    ];
  }

  return [
    {
      route: routes.listChats,
      handler: async (request): Promise<Success<Chat[]>> => {
        assertNoQuery(request.query);
        const listed = await chats.list(request.params.project!, request.params.id!);
        return { data: listed.chats.map((live) => live.chat), diagnostics: listed.diagnostics };
      },
    },
    {
      route: routes.startChat,
      handler: async (request): Promise<Success<ChatStart>> => {
        assertNoQuery(request.query);
        const { client, restart } = readStart(request.body);
        const { project, id } = request.params;
        const { live, started, diagnostics } = await starts.start(project!, id!, client, restart === true);
        return { data: { chat: live.chat, started }, diagnostics };
      },
    },
    {
      route: routes.startProjectChat,
      handler: async (request): Promise<Success<ProjectChatStart>> => {
        assertNoQuery(request.query);
        const input = readMessage(request.body);
        const live = await starts.startProject(request.params.project!, input);
        return { data: { chat: live.chat }, diagnostics: live.diagnostics };
      },
    },
    ...perChatRoutes(
      (request) => chats.get(request.params.project!, request.params.id!, chatOf(request.params.chat!)),
      {
        read: routes.readChat,
        events: routes.readChatEvents,
        message: routes.sendChatMessage,
        cancel: routes.cancelChatTurn,
        permission: routes.answerChatPermission,
        question: routes.answerChatQuestion,
        option: routes.setChatOption,
        seen: routes.markChatSeen,
      },
    ),
    ...perChatRoutes(
      (request) => chats.getProjectChat(request.params.project!, chatOf(request.params.chat!)),
      {
        read: routes.readProjectChat,
        events: routes.readProjectChatEvents,
        message: routes.sendProjectChatMessage,
        cancel: routes.cancelProjectChatTurn,
        permission: routes.answerProjectChatPermission,
        question: routes.answerProjectChatQuestion,
        option: routes.setProjectChatOption,
        seen: routes.markProjectChatSeen,
      },
    ),
  ];
}
