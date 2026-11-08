import { createClient, type Chat, type ChatEventsReply, type ProjectChat, type TransportReply } from "@tasma/protocol";
import { atSeq } from "./chat-fixtures";
import { heldBack, refusalReply, stubTransport, successReply } from "./helpers";

/** The path of the record of a chat of task SAGA-3. */
export function chatPath(chat = 2): string {
  return `/projects/SAGA/tasks/SAGA-3/chats/${chat}`;
}

export function eventsPath(after: number, chat = 2): string {
  return `${chatPath(chat)}/events?after=${after}`;
}

/** The path of the record of a chat of project SAGA. */
export function projectChatPath(chat = 2): string {
  return `/projects/SAGA/chats/${chat}`;
}

export function projectEventsPath(after: number, chat = 2): string {
  return `${projectChatPath(chat)}/events?after=${after}`;
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

export function projectChatRecord(fields: Partial<ProjectChat> = {}): ProjectChat {
  return {
    chat: 2,
    title: "Plan the release",
    agent: "claude",
    folder: "/work/saga",
    created: atSeq(0),
    seq: 0,
    stateSeq: 1,
    state: "needs-you",
    ...fields,
  } as ProjectChat;
}

/**
 * A daemon that holds each read of a chat log until the test answers it. An
 * answer holds the next read, after the cursor of the answer, the same way.
 * `replies` extends the map of `stubTransport`, and `logPath` gives the path of a
 * read of the log.
 */
export function stubChatLog(
  replies: Record<string, TransportReply | Promise<TransportReply>> = {},
  logPath: typeof eventsPath = eventsPath,
) {
  const stub = stubTransport(replies);
  const answers = new Map<string, (reply: TransportReply) => void>();

  function hold(after: number, chat = 2): void {
    const { reply, answer } = heldBack();
    stub.replies[logPath(after, chat)] = reply;
    answers.set(logPath(after, chat), answer);
  }

  hold(0);

  return {
    ...stub,
    client: createClient(stub.transport),
    hold,
    answer(after: number, data: ChatEventsReply, chat = 2): void {
      const answer = answers.get(logPath(after, chat));
      if (answer === undefined) {
        throw new Error(`no read after ${after} is held`);
      }
      answers.delete(logPath(after, chat));
      hold("reset" in data ? 0 : data.cursor, chat);
      answer(successReply(data));
    },
    /** Each read after `after` gets the data at once, and the read after its cursor is held. */
    serve(after: number, data: ChatEventsReply, chat = 2): void {
      stub.replies[logPath(after, chat)] = successReply(data);
      hold("reset" in data ? 0 : data.cursor, chat);
    },
    /** The held read after `after` and each read after it get a refusal, which the loop counts as a failed read. */
    refuse(after: number, chat = 2): void {
      const refusal = refusalReply(404, { kind: "store", code: "chat-not-found", message: `no chat ${chat}` });
      stub.replies[logPath(after, chat)] = refusal;
      answers.get(logPath(after, chat))?.(refusal);
      answers.delete(logPath(after, chat));
    },
    readsOf: (path: string) => stub.paths.filter((sent) => sent === path).length,
  };
}

export type ChatLogStub = ReturnType<typeof stubChatLog>;
