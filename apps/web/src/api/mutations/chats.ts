import { mutationOptions } from "@tanstack/react-query";
import { ProtocolError, type Client, type QuestionValue } from "@tasma/protocol";
import { useNoticeStore } from "../../store/notices";
import { daemonKeys, type ChatPlace } from "../queries";
import { openWriteNotice, refusalWords, WriteError, type WriteFailure } from "./notices";

/** The texts of the warning notice after `already-answered`. */
export type ClosedNotice = { title: string; line: string };

export type ChatQuestionReply
  = | { action: "accept"; content: Readonly<Record<string, QuestionValue>> }
    | { action: "decline" };

/** One write into a chat. The variables carry the texts of the notices. */
export type ChatWrite = { failure: WriteFailure } & (
  | { kind: "message"; text: string }
  | { kind: "cancel" }
  | { kind: "permission"; request: string; optionId: string; closed: ClosedNotice }
  | { kind: "question"; request: string; answer: ChatQuestionReply; closed: ClosedNotice }
);

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

async function send(client: Client, { tag, task, chat }: ChatPlace, write: ChatWrite): Promise<void> {
  const body = { client: CHAT_CLIENT };

  switch (write.kind) {
    case "message":
      await client.sendChatMessage(tag, task, chat, { ...body, text: write.text });
      return;
    case "cancel":
      await client.cancelChatTurn(tag, task, chat, body);
      return;
    case "permission":
      await client.answerChatPermission(tag, task, chat, write.request, { ...body, optionId: write.optionId });
      return;
    case "question":
      await client.answerChatQuestion(tag, task, chat, write.request, { ...write.answer, ...body });
  }
}

/**
 * The writes into one chat. The log shows their result, so a write changes no
 * cache. No scope: a Stop does not wait for a write in flight, and the daemon
 * puts the commands of one chat in order.
 */
export function chatWriteOptions(client: Client, place: ChatPlace) {
  return mutationOptions<void, WriteError, ChatWrite>({
    mutationKey: chatWriteKey(place),
    mutationFn: async (write) => {
      try {
        await send(client, place, write);
      } catch (cause) {
        throw new WriteError(cause);
      }
    },
    // A write whose answer is lost can be done already.
    retry: 0,
    onSuccess: (_data, write) => {
      useNoticeStore.getState().closeNotice(chatFailureKey(place, write.kind));
    },
    onError: (error, write) => {
      const key = chatFailureKey(place, write.kind);
      const words = [refusalWords(error)];

      if (write.kind !== "message" && write.kind !== "cancel" && chatRefusalCode(error) === "already-answered") {
        openWriteNotice({ key, form: "warning", title: write.closed.title, line: write.closed.line, words });
        return;
      }
      openWriteNotice({ key, form: "failure", title: write.failure.title, line: write.failure.line(error), words });
    },
  });
}
