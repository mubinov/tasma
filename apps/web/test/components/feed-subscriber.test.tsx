import { QueryObserver, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { createClient, type FeedEvent, type TransportReply } from "@tasma/protocol";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { createAppQueryClient } from "../../src/api/client";
import { FEED_MAPPINGS, type FeedMappings } from "../../src/api/feed-events";
import { appKeys, daemonKeys, taskQuery, tasksQuery } from "../../src/api/queries";
import { FeedSubscriber } from "../../src/components/feed-subscriber";
import { heldBack, stubTransport, successReply } from "../helpers";

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

afterEach(() => {
  cleanup();
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
