// The change feed of one daemon run: the last events in memory, a cursor per
// event, and a long-poll read after a cursor.
//
// The feed is live state, not history. The run id in the cursor changes at each
// start, so a client of an earlier run gets `reset` and reads its data again.

import { randomBytes } from "node:crypto";
import type { EventsReply, FeedEvent } from "@tasma/protocol";
import { createHold, HOLD_MS } from "./hold.js";

/** How many of the last events the feed keeps. A cursor older than these gets `reset`. */
const FEED_SIZE = 1024;

/**
 * How long after a read returns the feed still counts a client as reading it.
 * The web app reads again at once after each reply, so this covers the gap
 * between two reads.
 */
const LISTEN_MS = 30_000;

const RUN_BYTES = 6;

/** The sequence part of a cursor in the one form the feed writes: a decimal integer with no leading zero. */
const SEQUENCE_FORM = /^(?:0|[1-9]\d*)$/;

export type Publish = (event: FeedEvent) => void;

export type Feed = {
  /** Stores one event and releases the held reads. Dropped after `close`. */
  publish: Publish;
  /** The events after a cursor. A read of the current cursor holds until the next event or the end of the hold. */
  read(after: string | undefined): Promise<EventsReply>;
  /** Answers every held read at once, and makes later reads answer without a hold. */
  close(): void;
  /**
   * Whether a client reads the feed: a read is held now, or a read returned less
   * than `LISTEN_MS` ago. A closed feed has none.
   */
  listening(): boolean;
};

export function createFeed(options: { holdMs?: number; size?: number } = {}): Feed {
  const size = options.size ?? FEED_SIZE;
  const hold = createHold({ holdMs: options.holdMs ?? HOLD_MS });
  const run = randomBytes(RUN_BYTES).toString("hex");
  const prefix = `${run}-`;
  /** The kept events, oldest first. The last one has the sequence `sequence`. */
  const events: FeedEvent[] = [];
  let sequence = 0;
  let closed = false;
  let holding = 0;
  let returnedAt: number | undefined;

  function current(): string {
    return `${prefix}${sequence}`;
  }

  /** The sequence a cursor of this run names, or `undefined` for any other text. */
  function sequenceOf(after: string): number | undefined {
    if (!after.startsWith(prefix)) return undefined;
    const stated = after.slice(prefix.length);
    return SEQUENCE_FORM.test(stated) ? Number(stated) : undefined;
  }

  /** The reply for a known sequence: the events after it, or `reset` where one of them is dropped. */
  function replyAfter(known: number): EventsReply {
    const before = sequence - events.length;
    if (known < before) return { reset: true, cursor: current() };
    return { cursor: current(), events: events.slice(known - before) };
  }

  async function answer(after: string | undefined): Promise<EventsReply> {
    if (after === undefined) return { cursor: current(), events: [] };

    const known = sequenceOf(after);
    if (known === undefined || known > sequence) return { reset: true, cursor: current() };
    if (known < sequence) return replyAfter(known);

    holding += 1;
    await hold.wait();
    holding -= 1;
    return replyAfter(known);
  }

  return {
    publish(event) {
      if (closed) return;
      sequence += 1;
      events.push(event);
      if (events.length > size) events.shift();
      hold.notify();
    },

    async read(after) {
      const reply = await answer(after);
      returnedAt = performance.now();
      return reply;
    },

    close() {
      closed = true;
      hold.close();
    },

    listening() {
      if (closed) return false;
      return holding > 0 || (returnedAt !== undefined && performance.now() - returnedAt < LISTEN_MS);
    },
  };
}
