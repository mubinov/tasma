import { QueryObserver, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { createClient, type FeedEvent, type TransportReply } from "@tasma/protocol";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createAppQueryClient } from "../../src/api/client";
import { FEED_MAPPINGS, type FeedMappings } from "../../src/api/feed-events";
import { FEED_NOTICE_KEY } from "../../src/api/feed-notice";
import { appKeys, daemonKeys, taskQuery, tasksQuery } from "../../src/api/queries";
import { DAEMON_URL } from "../../src/api/transport";
import { FeedSubscriber } from "../../src/components/feed-subscriber";
import { useNoticeStore } from "../../src/store/notices";
import { heldBack, refusalReply, stubTransport, successReply } from "../helpers";

const TASK = "/projects/SAGA/tasks/SAGA-1";
const OTHER_TASK = "/projects/SAGA/tasks/SAGA-2";
const LISTING = "/projects/SAGA/tasks";

/**
 * A daemon whose feed answers the first read with the cursor `c0` and holds
 * every read after it until the test answers. Each answer names the next
 * cursor, `c1`, `c2` and so on.
 */
function stubFeed() {
  const stub = stubTransport({
    "/events": successReply({ cursor: "c0", events: [] }),
    [TASK]: successReply({}),
    [OTHER_TASK]: successReply({}),
    [LISTING]: successReply({}),
  });
  let count = 0;
  let held = hold(0);

  function hold(index: number): (reply: TransportReply) => void {
    const { reply, answer } = heldBack();
    stub.replies[`/events?after=c${index}`] = reply;
    return answer;
  }

  function answer(data: unknown): void {
    const current = held;
    count += 1;
    held = hold(count);
    current(successReply(data));
  }

  return {
    ...stub,
    client: createClient(stub.transport),
    send: (events: unknown[]) => {
      answer({ cursor: `c${count + 1}`, events });
    },
    reset: () => {
      answer({ reset: true, cursor: `c${count + 1}` });
    },
    /** Answers the held read with `first`, and each read again of its cursor with `then`, until `holdNext`. */
    fail: (first: TransportReply, then: TransportReply = first) => {
      const current = held;
      stub.replies[`/events?after=c${count}`] = then;
      current(first);
    },
    /** Holds the next read of the current cursor until the test answers. */
    holdNext: () => {
      held = hold(count);
    },
    requestsOf: (path: string) => stub.paths.filter((sent) => sent === path).length,
  };
}

type Feed = ReturnType<typeof stubFeed>;

/** Keeps a query active, the way a mounted screen does. */
function observe(observer: { subscribe: (listener: () => void) => () => void }): void {
  onTestFinished(observer.subscribe(() => {}));
}

function invalidated(queryClient: QueryClient, key: QueryKey): boolean | undefined {
  return queryClient.getQueryState(key)?.isInvalidated;
}

async function mount(feed: Feed, queryClient: QueryClient, mappings?: FeedMappings) {
  const view = render(<FeedSubscriber queryClient={queryClient} client={feed.client} mappings={mappings} />);
  await waitFor(() => {
    expect(feed.paths).toContain("/events?after=c0");
  });
  return view;
}

function feedNotices() {
  return useNoticeStore.getState().notices.filter(({ key }) => key === FEED_NOTICE_KEY);
}

/** Moves the clock past the waits of the loop. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Three failed reads in a row: the held read, then a read after 1 s and one after 2 s more. */
async function failThrice(feed: Feed): Promise<void> {
  feed.fail({ status: 502 }, refusalReply(400, { kind: "daemon", code: "malformed-request", message: "after is not a cursor" }));
  await wait(1_000);
  expect(feedNotices()).toEqual([]);
  await wait(2_000);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("refetches the task of a task event and its listing, and not another task of the project", async () => {
  const feed = stubFeed();
  const queryClient = createAppQueryClient();
  observe(new QueryObserver(queryClient, taskQuery(feed.client, "SAGA", "SAGA-1")));
  observe(new QueryObserver(queryClient, taskQuery(feed.client, "SAGA", "SAGA-2")));
  observe(new QueryObserver(queryClient, tasksQuery(feed.client, "SAGA")));
  await mount(feed, queryClient);

  const event: FeedEvent = { kind: "task", tag: "SAGA", id: "SAGA-1", change: "changed" };
  feed.send([event, event]);

  await waitFor(() => {
    expect(feed.paths).toContain("/events?after=c1");
    expect(feed.requestsOf(TASK)).toBe(2);
    expect(feed.requestsOf(LISTING)).toBe(2);
  });
  expect(feed.requestsOf(OTHER_TASK)).toBe(1);
});

it("invalidates every daemon query on a reset, and not the update of the app", async () => {
  const feed = stubFeed();
  const queryClient = createAppQueryClient();
  queryClient.setQueryData(daemonKeys.health(), {});
  queryClient.setQueryData(daemonKeys.project("SAGA"), {});
  queryClient.setQueryData(daemonKeys.workflowRead("review"), {});
  queryClient.setQueryData(appKeys.update(), null);
  await mount(feed, queryClient);

  feed.reset();

  await waitFor(() => {
    expect(feed.paths).toContain("/events?after=c1");
  });
  expect(invalidated(queryClient, daemonKeys.health())).toBe(true);
  expect(invalidated(queryClient, daemonKeys.project("SAGA"))).toBe(true);
  expect(invalidated(queryClient, daemonKeys.workflowRead("review"))).toBe(true);
  expect(invalidated(queryClient, appKeys.update())).toBe(false);
});

it("invalidates a key that only the mapping table it is given names", async () => {
  const feed = stubFeed();
  const queryClient = createAppQueryClient();
  const mappings: FeedMappings = {
    ...FEED_MAPPINGS,
    task: (event) => [...FEED_MAPPINGS.task(event), { queryKey: ["outside"] }],
  };
  queryClient.setQueryData(["outside"], {});
  await mount(feed, queryClient, mappings);

  feed.send([{ kind: "task", tag: "SAGA", id: "SAGA-1", change: "created" }]);

  await waitFor(() => {
    expect(invalidated(queryClient, ["outside"])).toBe(true);
  });
});

it("aborts its held read when it unmounts", async () => {
  const feed = stubFeed();
  const view = await mount(feed, createAppQueryClient());
  const held = feed.requests.find((request) => request.path === "/events?after=c0");

  expect(held?.signal?.aborted).toBe(false);
  view.unmount();

  expect(held?.signal?.aborted).toBe(true);
});

it("skips an event of a kind it does not know and reads on at once", async () => {
  const feed = stubFeed();
  const queryClient = createAppQueryClient();
  queryClient.setQueryData(daemonKeys.project("SAGA"), {});
  await mount(feed, queryClient);

  feed.send([{ kind: "future", tag: "SAGA" }]);

  // A handler that throws makes the loop wait a second before the next read.
  await waitFor(
    () => {
      expect(feed.paths).toContain("/events?after=c1");
    },
    { timeout: 500 },
  );
  expect(invalidated(queryClient, daemonKeys.project("SAGA"))).toBe(false);
});

it("opens the feed notice after three failed reads in a row, and closes it with a spoken line on the next success", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const feed = stubFeed();
  await mount(feed, createAppQueryClient());

  await failThrice(feed);
  expect(feedNotices()).toMatchObject([
    { title: "Tasma does not get changes", words: [`${DAEMON_URL} · HTTP 502 · GET /events answered with no envelope`] },
  ]);

  feed.holdNext();
  await wait(4_000);
  feed.send([]);
  await wait(100);

  expect(feedNotices()).toEqual([]);
  expect(useNoticeStore.getState().announced.filter(({ words }) => words === "Tasma gets changes again.")).toHaveLength(1);
});

it("closes the feed notice when it unmounts", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const feed = stubFeed();
  const view = await mount(feed, createAppQueryClient());
  await failThrice(feed);
  expect(feedNotices()).toHaveLength(1);

  view.unmount();

  expect(feedNotices()).toEqual([]);
});
