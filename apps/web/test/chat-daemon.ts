import { createClient, type Chat, type ChatEventsReply, type TransportReply } from "@tasma/protocol";
import { atSeq } from "./chat-fixtures";
import { heldBack, refusalReply, stubTransport, successReply } from "./helpers";

/** The path of the record of a chat of task SAGA-3. */
export function chatPath(chat = 2): string {
  return `/projects/SAGA/tasks/SAGA-3/chats/${chat}`;
}

export function eventsPath(after: number, chat = 2): string {
  return `${chatPath(chat)}/events?after=${after}`;
}

export function chatRecord(fields: Partial<Chat> = {}): Chat {
  return {
    task: "SAGA-3",
    chat: 2,
    step: "build",
    agent: "claude",
    folder: "/work/saga",
    created: atSeq(0),
    seq: 0,
    // No daemon gives it with `seq` 0. It makes a chat with no `seen` count as not seen.
    stateSeq: 1,
    state: "needs-you",
    ...fields,
  } as Chat;
}

/**
 * A daemon that holds each read of a chat log until the test answers it. An
 * answer holds the next read, after the cursor of the answer, the same way.
 * `replies` extends the map of `stubTransport`.
 */
export function stubChatLog(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  const stub = stubTransport(replies);
  const answers = new Map<string, (reply: TransportReply) => void>();

  function hold(after: number, chat = 2): void {
    const { reply, answer } = heldBack();
    stub.replies[eventsPath(after, chat)] = reply;
    answers.set(eventsPath(after, chat), answer);
  }

  hold(0);

  return {
    ...stub,
    client: createClient(stub.transport),
    hold,
    answer(after: number, data: ChatEventsReply, chat = 2): void {
      const answer = answers.get(eventsPath(after, chat));
      if (answer === undefined) {
        throw new Error(`no read after ${after} is held`);
      }
      answers.delete(eventsPath(after, chat));
      hold("reset" in data ? 0 : data.cursor, chat);
      answer(successReply(data));
    },
    /** Each read after `after` gets the data at once, and the read after its cursor is held. */
    serve(after: number, data: ChatEventsReply, chat = 2): void {
      stub.replies[eventsPath(after, chat)] = successReply(data);
      hold("reset" in data ? 0 : data.cursor, chat);
    },
    /** The held read after `after` and each read after it get a refusal, which the loop counts as a failed read. */
    refuse(after: number, chat = 2): void {
      const refusal = refusalReply(404, { kind: "store", code: "chat-not-found", message: `no chat ${chat}` });
      stub.replies[eventsPath(after, chat)] = refusal;
      answers.get(eventsPath(after, chat))?.(refusal);
      answers.delete(eventsPath(after, chat));
    },
    readsOf: (path: string) => stub.paths.filter((sent) => sent === path).length,
  };
}

export type ChatLogStub = ReturnType<typeof stubChatLog>;
