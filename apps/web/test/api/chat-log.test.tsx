import { createClient, type ChatEventsReply, type TransportReply } from "@tasma/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatLog } from "../../src/api/chat-log";
import { CHAT_VIEW_START, foldChatEntries } from "../../src/lib/chat-fold";
import { TEXT_LOG } from "../chat-fixtures";
import { heldBack, refusalReply, stubTransport, successReply } from "../helpers";

function eventsPath(after: number, chat = 2): string {
  return `/projects/SAGA/tasks/SAGA-3/chats/${chat}/events?after=${after}`;
}

/**
 * A daemon that holds each read of a chat log until the test answers it. An
 * answer holds the next read, after the cursor of the answer, the same way.
 */
function stubChatLog() {
  const stub = stubTransport();
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
      hold("reset" in data ? 0 : data.cursor, chat);
      answer(successReply(data));
    },
    /** Each read after `after` gets the data at once, and the read after its cursor is held. */
    serve(after: number, data: ChatEventsReply, chat = 2): void {
      stub.replies[eventsPath(after, chat)] = successReply(data);
      hold("reset" in data ? 0 : data.cursor, chat);
    },
    /** Each read after `after` gets a refusal, which the loop counts as a failed read. */
    refuse(after: number, chat = 2): void {
      stub.replies[eventsPath(after, chat)] = refusalReply(404, {
        kind: "store",
        code: "chat-not-found",
        message: `no chat ${chat}`,
      });
    },
    readsOf: (path: string) => stub.paths.filter((sent) => sent === path).length,
  };
}

type ChatLogStub = ReturnType<typeof stubChatLog>;

type Props = { client: ChatLogStub["client"]; chat: number; since: number };

function renderChatLog(log: ChatLogStub, since: number) {
  return renderHook(({ client, chat, since: known }: Props) => useChatLog(client, "SAGA", "SAGA-3", chat, known), {
    initialProps: { client: log.client, chat: 2, since },
  });
}

async function readStarted(log: ChatLogStub, path: string, count = 1): Promise<void> {
  await waitFor(() => {
    expect(log.readsOf(path)).toBe(count);
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("folds the entries of the first read, and reads again after the cursor of the reply", async () => {
  const log = stubChatLog();
  const { result } = renderChatLog(log, 3);
  await readStarted(log, eventsPath(0));

  log.answer(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });

  await waitFor(() => {
    expect(result.current.view).toEqual(foldChatEntries(CHAT_VIEW_START, TEXT_LOG.slice(0, 3)));
  });
  await readStarted(log, eventsPath(3));
});

it("becomes ready when a read reaches since, and not before", async () => {
  const log = stubChatLog();
  const { result } = renderChatLog(log, 5);
  await readStarted(log, eventsPath(0));
  expect(result.current.ready).toBe(false);

  log.answer(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });
  await waitFor(() => {
    expect(result.current.view.seq).toBe(3);
  });
  expect(result.current.ready).toBe(false);

  log.answer(3, { cursor: 5, entries: TEXT_LOG.slice(3, 5) });
  await waitFor(() => {
    expect(result.current.ready).toBe(true);
  });
  expect(result.current.view.seq).toBe(5);
});

it("becomes ready after an empty reply when since is above the end of the log", async () => {
  const log = stubChatLog();
  const { result } = renderChatLog(log, 9);
  await readStarted(log, eventsPath(0));

  log.answer(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });
  await readStarted(log, eventsPath(3));
  expect(result.current.ready).toBe(false);

  log.answer(3, { cursor: 3, entries: [] });
  await waitFor(() => {
    expect(result.current.ready).toBe(true);
  });
  expect(result.current.view.seq).toBe(3);
});

it("is ready at once when since is 0", () => {
  const log = stubChatLog();
  const { result } = renderChatLog(log, 0);

  expect(result.current).toEqual({ view: CHAT_VIEW_START, ready: true, failures: 0 });
});

it("stays ready when since grows, from 0 and after a read reached it", async () => {
  const log = stubChatLog();
  const { result, rerender } = renderChatLog(log, 0);
  await readStarted(log, eventsPath(0));

  rerender({ client: log.client, chat: 2, since: 3 });
  expect(result.current.ready).toBe(true);

  log.answer(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });
  await waitFor(() => {
    expect(result.current.view.seq).toBe(3);
  });
  rerender({ client: log.client, chat: 2, since: 8 });

  expect(result.current.ready).toBe(true);
  expect(log.readsOf(eventsPath(0))).toBe(1);
});

it("is not made ready by an empty reply that comes after its loop stopped", async () => {
  const first = stubChatLog();
  const second = stubChatLog();
  const { result, rerender } = renderChatLog(first, 5);
  await readStarted(first, eventsPath(0));

  rerender({ client: second.client, chat: 2, since: 5 });
  await readStarted(second, eventsPath(0));
  expect(first.requests[0]?.signal?.aborted).toBe(true);

  second.answer(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });
  await waitFor(() => {
    expect(result.current.view.seq).toBe(3);
  });
  first.answer(0, { cursor: 0, entries: [] });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(result.current.ready).toBe(false);
  expect(result.current.view.seq).toBe(3);
});

it("drops the state of the old client at once, and keeps no failure count of its loop", async () => {
  const first = stubChatLog();
  const second = stubChatLog();
  const { result, rerender } = renderChatLog(first, 3);
  await readStarted(first, eventsPath(0));
  first.answer(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });
  first.refuse(3);
  await waitFor(() => {
    expect(result.current).toMatchObject({ ready: true, failures: 1 });
  });

  rerender({ client: second.client, chat: 2, since: 3 });

  expect(result.current).toEqual({ view: CHAT_VIEW_START, ready: false, failures: 0 });
  await readStarted(second, eventsPath(0));
  second.answer(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });
  await waitFor(() => {
    expect(result.current.ready).toBe(true);
  });
  expect(result.current).toEqual({
    view: foldChatEntries(CHAT_VIEW_START, TEXT_LOG.slice(0, 3)),
    ready: true,
    failures: 0,
  });
});

it("adds the entries that a held read gets", async () => {
  const log = stubChatLog();
  const { result } = renderChatLog(log, 2);
  await readStarted(log, eventsPath(0));
  log.answer(0, { cursor: 2, entries: TEXT_LOG.slice(0, 2) });
  await readStarted(log, eventsPath(2));

  log.answer(2, { cursor: 6, entries: TEXT_LOG.slice(2, 6) });

  await waitFor(() => {
    expect(result.current.view).toEqual(foldChatEntries(CHAT_VIEW_START, TEXT_LOG.slice(0, 6)));
  });
});

it("starts the view again on a reset, and reads the log again from the start with no double", async () => {
  const log = stubChatLog();
  const { result } = renderChatLog(log, 3);
  await readStarted(log, eventsPath(0));
  log.answer(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });
  await waitFor(() => {
    expect(result.current.ready).toBe(true);
  });
  await readStarted(log, eventsPath(3));

  log.answer(3, { reset: true, cursor: 0 });
  await waitFor(() => {
    expect(result.current).toEqual({ view: CHAT_VIEW_START, ready: false, failures: 0 });
  });
  await readStarted(log, eventsPath(0), 2);

  log.answer(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });
  await waitFor(() => {
    expect(result.current.ready).toBe(true);
  });
  expect(result.current.view).toEqual(foldChatEntries(CHAT_VIEW_START, TEXT_LOG.slice(0, 3)));
});

it("counts the failed reads in a row, and sets 0 after a successful read", async () => {
  vi.useFakeTimers();
  const log = stubChatLog();
  log.refuse(0);
  const { result } = renderChatLog(log, 1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(result.current.failures).toBe(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(result.current.failures).toBe(2);

  log.serve(0, { cursor: 1, entries: TEXT_LOG.slice(0, 1) });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });

  expect(result.current).toMatchObject({ ready: true, failures: 0 });
  expect(result.current.view.seq).toBe(1);
});

it("aborts the held read when the component unmounts", async () => {
  const log = stubChatLog();
  const { unmount } = renderChatLog(log, 3);
  await readStarted(log, eventsPath(0));
  const signal = log.requests[0]?.signal;
  expect(signal?.aborted).toBe(false);

  unmount();

  expect(signal?.aborted).toBe(true);
});

it("drops the view of the old chat at once, and reads the new chat from the start", async () => {
  const log = stubChatLog();
  log.hold(0, 3);
  const { result, rerender } = renderChatLog(log, 3);
  await readStarted(log, eventsPath(0));
  log.answer(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });
  await waitFor(() => {
    expect(result.current.ready).toBe(true);
  });

  rerender({ client: log.client, chat: 3, since: 4 });

  expect(result.current).toEqual({ view: CHAT_VIEW_START, ready: false, failures: 0 });
  await readStarted(log, eventsPath(0, 3));
  expect(log.requests[1]?.signal?.aborted).toBe(true);
});
