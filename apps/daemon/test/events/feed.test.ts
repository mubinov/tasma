import { describe, expect, it } from "vitest";
import type { EventsReply, FeedEvent } from "@tasma/protocol";
import { createFeed } from "../../src/events/feed.js";
import type { Feed } from "../../src/events/feed.js";
import { createHold } from "../../src/events/hold.js";

/** A hold no test outlasts, for a read that a publish or a close has to end. */
const LONG_HOLD_MS = 10_000;

function taskEvent(id: string): FeedEvent {
  return { kind: "task", tag: "ALPHA", id, change: "changed" };
}

/** The run id the cursor of a feed carries. */
async function runOf(feed: Feed): Promise<string> {
  const { cursor } = await feed.read(undefined);
  return cursor.slice(0, cursor.lastIndexOf("-"));
}

/** Whether a promise is still pending once the turns that are already queued have run. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  const winner = await Promise.race([promise, new Promise((resolve) => setImmediate(() => resolve(marker)))]);
  return winner === marker;
}

describe("createHold", () => {
  it("releases every wait together in the turn after a notify", async () => {
    const hold = createHold({ holdMs: LONG_HOLD_MS });
    const first = hold.wait();
    const second = hold.wait();
    let released = false;
    void first.then(() => (released = true));

    hold.notify();
    hold.notify();
    await Promise.resolve();

    expect(released).toBe(false);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("ends a wait at the end of the hold", async () => {
    const hold = createHold({ holdMs: 20 });
    const began = performance.now();

    await hold.wait();

    expect(performance.now() - began).toBeGreaterThanOrEqual(15);
  });

  it("releases every wait at a close, and holds no wait after it", async () => {
    const hold = createHold({ holdMs: LONG_HOLD_MS });
    const held = hold.wait();

    hold.close();

    await expect(held).resolves.toBeUndefined();
    expect(await pending(hold.wait())).toBe(false);
  });
});

describe("a read of the feed", () => {
  it("answers the first cursor of a run and no events when it states no cursor", async () => {
    const feed = createFeed();

    const reply = await feed.read(undefined);

    expect(reply).toEqual({ cursor: expect.stringMatching(/^[0-9a-f]{12}-0$/) as string, events: [] });
  });

  it("makes a new run id for each feed", async () => {
    expect(await runOf(createFeed())).not.toBe(await runOf(createFeed()));
  });

  it("answers the events after a known cursor at once, in publish order", async () => {
    const feed = createFeed();
    const run = await runOf(feed);
    feed.publish(taskEvent("ALPHA-1"));
    feed.publish(taskEvent("ALPHA-2"));
    feed.publish(taskEvent("ALPHA-3"));

    await expect(feed.read(`${run}-1`)).resolves.toEqual({
      cursor: `${run}-3`,
      events: [taskEvent("ALPHA-2"), taskEvent("ALPHA-3")],
    });
  });

  it("answers reset for the cursor of another run", async () => {
    const feed = createFeed();
    const other = await createFeed().read(undefined);
    feed.publish(taskEvent("ALPHA-1"));

    await expect(feed.read(other.cursor)).resolves.toEqual({ reset: true, cursor: `${await runOf(feed)}-1` });
  });

  it("answers reset for a cursor ahead of the sequence", async () => {
    const feed = createFeed();
    const run = await runOf(feed);
    feed.publish(taskEvent("ALPHA-1"));

    await expect(feed.read(`${run}-2`)).resolves.toEqual({ reset: true, cursor: `${run}-1` });
  });

  it("answers reset for a cursor older than the events it keeps, and keeps the newest", async () => {
    const feed = createFeed({ size: 2 });
    const run = await runOf(feed);
    feed.publish(taskEvent("ALPHA-1"));
    feed.publish(taskEvent("ALPHA-2"));
    feed.publish(taskEvent("ALPHA-3"));

    await expect(feed.read(`${run}-0`)).resolves.toEqual({ reset: true, cursor: `${run}-3` });
    await expect(feed.read(`${run}-1`)).resolves.toEqual({
      cursor: `${run}-3`,
      events: [taskEvent("ALPHA-2"), taskEvent("ALPHA-3")],
    });
  });

  it.each([
    ["text with no run id", (run: string) => `bogus-${run.length}`],
    ["an empty value", () => ""],
    ["a run id alone", (run: string) => run],
    ["a run id and a separator alone", (run: string) => `${run}-`],
    ["a sequence with a leading zero", (run: string) => `${run}-01`],
    ["a negative sequence", (run: string) => `${run}--1`],
    ["a sequence with a fraction", (run: string) => `${run}-0.0`],
    ["a sequence followed by text", (run: string) => `${run}-0x`],
  ])("answers reset for %s", async (_case, cursorOf) => {
    const feed = createFeed();
    const run = await runOf(feed);

    await expect(feed.read(cursorOf(run))).resolves.toEqual({ reset: true, cursor: `${run}-0` });
  });

  it("holds a read of the current cursor until the next publish, and answers that event", async () => {
    const feed = createFeed({ holdMs: LONG_HOLD_MS });
    const run = await runOf(feed);
    const held = feed.read(`${run}-0`);

    expect(await pending(held)).toBe(true);
    feed.publish(taskEvent("ALPHA-1"));

    await expect(held).resolves.toEqual({ cursor: `${run}-1`, events: [taskEvent("ALPHA-1")] });
  });

  it("answers the same cursor and no events at the end of the hold", async () => {
    const feed = createFeed({ holdMs: 20 });
    const { cursor } = await feed.read(undefined);

    await expect(feed.read(cursor)).resolves.toEqual({ cursor, events: [] });
  });

  it("answers every event of one turn in one reply, to every held read together", async () => {
    const feed = createFeed({ holdMs: LONG_HOLD_MS });
    const run = await runOf(feed);
    const held = [feed.read(`${run}-0`), feed.read(`${run}-0`)];

    feed.publish(taskEvent("ALPHA-1"));
    feed.publish(taskEvent("ALPHA-2"));

    const expected: EventsReply = { cursor: `${run}-2`, events: [taskEvent("ALPHA-1"), taskEvent("ALPHA-2")] };
    await expect(Promise.all(held)).resolves.toEqual([expected, expected]);
  });

  it("answers reset to a held read whose events the buffer dropped before the release", async () => {
    const feed = createFeed({ holdMs: LONG_HOLD_MS, size: 1 });
    const run = await runOf(feed);
    const held = feed.read(`${run}-0`);

    feed.publish(taskEvent("ALPHA-1"));
    feed.publish(taskEvent("ALPHA-2"));

    await expect(held).resolves.toEqual({ reset: true, cursor: `${run}-2` });
  });
});

describe("a closed feed", () => {
  it("answers every held read at once, and holds no read after the close", async () => {
    const feed = createFeed({ holdMs: LONG_HOLD_MS });
    const { cursor } = await feed.read(undefined);
    const held = feed.read(cursor);

    feed.close();

    await expect(held).resolves.toEqual({ cursor, events: [] });
    await expect(feed.read(cursor)).resolves.toEqual({ cursor, events: [] });
  });

  it("drops a publish", async () => {
    const feed = createFeed();
    const { cursor } = await feed.read(undefined);

    feed.close();
    feed.publish(taskEvent("ALPHA-1"));

    await expect(feed.read(cursor)).resolves.toEqual({ cursor, events: [] });
  });
});
