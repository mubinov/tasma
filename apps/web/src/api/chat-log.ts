import type { ChatEntry, Client } from "@tasma/protocol";
import { useEffect, useEffectEvent, useState } from "react";
import { CHAT_VIEW_START, foldChatEntries, type ChatView } from "../lib/chat-fold";
import { startLongPoll } from "./long-poll";

export type ChatLog = {
  view: ChatView;
  /**
   * True when the view has caught up with the log: `since` is 0, or a
   * successful read left `view.seq` at `since` or above, or came back with no
   * entries. False at the start and again after a reset, until that is true again.
   */
  ready: boolean;
  /** Failed reads in a row: 0 after a successful read. */
  failures: number;
  /** The resets of the log since the read of this chat started. Each one starts the view again. */
  resets: number;
};

/** A chat log with the inputs of the loop that reads it. */
type KeyedLog = ChatLog & { client: Client; key: string };

function keyOf(tag: string, task: string, chat: number): string {
  return JSON.stringify([tag, task, chat]);
}

function startOf(client: Client, key: string, ready: boolean): KeyedLog {
  return { client, key, view: CHAT_VIEW_START, ready, failures: 0, resets: 0 };
}

/**
 * The live log of one chat, folded into messages. It reads the log from the
 * start when the component mounts or the chat or the client changes, and stops
 * when the component unmounts. `since` is the `seq` of the log that the caller
 * knows, `Chat.seq` of the chat record.
 */
export function useChatLog(client: Client, tag: string, task: string, chat: number, since: number): ChatLog {
  const key = keyOf(tag, task, chat);
  const [state, setState] = useState(() => startOf(client, key, since === 0));
  const reaches = useEffectEvent((seq: number) => seq >= since);

  let log = state;
  if (log.client !== client || log.key !== key) {
    log = startOf(client, key, since === 0);
    setState(log);
  }

  useEffect(() => {
    let current = startOf(client, keyOf(tag, task, chat), reaches(CHAT_VIEW_START.seq));

    function publish(change: Partial<ChatLog>): void {
      current = { ...current, ...change };
      setState(current);
    }

    const poll = startLongPoll<ChatEntry>({
      after: "0",
      read: async (after, signal) => {
        const { data } = await client.readChatEvents(tag, task, chat, Number(after), { signal });
        if ("reset" in data) {
          return { reset: true, cursor: String(data.cursor) };
        }
        // A late reply of a stopped loop must not mark the log of the next one.
        if (data.entries.length === 0 && !signal.aborted && !current.ready) {
          publish({ ready: true });
        }
        return { cursor: String(data.cursor), events: data.entries };
      },
      onEvents: (entries) => {
        const view = foldChatEntries(current.view, entries);
        publish({ view, ready: current.ready || reaches(view.seq) });
      },
      onReset: () => {
        publish({ view: CHAT_VIEW_START, ready: false, resets: current.resets + 1 });
      },
      onStatus: (failures) => {
        if (failures !== current.failures) {
          publish({ failures });
        }
      },
    });

    return () => {
      poll.stop();
    };
  }, [client, tag, task, chat]);

  return { view: log.view, ready: log.ready || since === 0, failures: log.failures, resets: log.resets };
}
