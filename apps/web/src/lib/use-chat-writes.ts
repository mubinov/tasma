import type { RespondToToolApprovalOptions } from "@assistant-ui/react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { chatRefusalCode, chatWriteOptions, type ChatWrite } from "../api/mutations";
import type { ChatPlace } from "../api/queries";
import { useChatDraftStore } from "../store/chat-drafts";
import { permissionAnswer, questionAnswer, type ChatRequest } from "./chat-approval";
import { chatClosedNotice, chatFailure, chatOptionFailure, chatOptionSavedNotice } from "./write-failure";

export type ChatWrites = {
  /**
   * On a failure, puts the text back in the draft of the chat, which also
   * reaches a composer that mounted after the send, and rejects.
   */
  send: (text: string) => Promise<void>;
  /** Never rejects: the kit logs a rejected cancel, and the notice tells the failure. */
  cancel: () => Promise<void>;
  /**
   * Resolves on `already-answered` too: the log closes the request, so the kit
   * buttons stay locked. Another failure rejects with the text the kit shows.
   */
  answer: (request: ChatRequest | undefined, options: RespondToToolApprovalOptions) => Promise<void>;
  /**
   * Sets one config option. `name` is the name of the option, for its notices.
   * Resolves with the `seq` of the answer, or with nothing on a failure, which
   * the notice tells.
   */
  pick: (configId: string, value: string, name: string) => Promise<number | undefined>;
};

const NOT_SENT = "Not sent. The notice gives the reason.";

export function useChatWrites(place: ChatPlace): ChatWrites {
  const { client, queryClient } = useRouter().options.context;
  const { mutateAsync: write } = useMutation(chatWriteOptions(client, place), queryClient);

  async function send(text: string): Promise<void> {
    try {
      await write({ kind: "message", text, failure: chatFailure(place, "message") });
    } catch (error) {
      useChatDraftStore.getState().returnToDraft(place, text);
      // Not a `MessageNotSentError`, with which the kit would put the text back a second time.
      throw new Error(NOT_SENT, { cause: error });
    }
  }

  async function cancel(): Promise<void> {
    try {
      await write({ kind: "cancel", failure: chatFailure(place, "cancel") });
    } catch {
      // The failure notice is open.
    }
  }

  async function answer(request: ChatRequest | undefined, options: RespondToToolApprovalOptions): Promise<void> {
    if (request === undefined) {
      throw new Error("The request is not in the chat.");
    }

    const closed = chatClosedNotice(place);
    const variables: ChatWrite = request.kind === "permission"
      ? {
          kind: "permission",
          request: request.permission.request,
          optionId: permissionAnswer(options).optionId,
          failure: chatFailure(place, "permission"),
          closed,
        }
      : {
          kind: "question",
          request: request.question.request,
          answer: questionAnswer(request.question, options),
          failure: chatFailure(place, "question"),
          closed,
        };

    try {
      await write(variables);
    } catch (error) {
      if (chatRefusalCode(error) !== "already-answered") {
        throw new Error(NOT_SENT, { cause: error });
      }
    }
  }

  async function pick(configId: string, value: string, name: string): Promise<number | undefined> {
    try {
      const answer = await write({
        kind: "option",
        configId,
        value,
        failure: chatOptionFailure(place, name),
        saved: chatOptionSavedNotice(place, name),
      });
      return answer?.data.seq;
    } catch {
      return undefined;
    }
  }

  return { send, cancel, answer, pick };
}
