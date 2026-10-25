import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { startRescans } from "../../src/events/rescan.js";

const TICK_MS = 20_000;

/** A tree and a host that record each call, and a feed whose answer the test sets. */
function parts(): {
  calls: string[];
  feed: { listening(): boolean };
  tree: { rescan(): Promise<void> };
  host: { repairDue(): Promise<void> };
  setListening: (value: boolean) => void;
} {
  const calls: string[] = [];
  let listening = true;
  return {
    calls,
    feed: { listening: () => listening },
    tree: {
      rescan: async () => {
        calls.push("rescan");
      },
    },
    host: {
      repairDue: async () => {
        calls.push("repairDue");
      },
    },
    setListening: (value) => (listening = value),
  };
}

describe("the rescan tick", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("rescans the tree and then repairs the projects that are due, only while a client reads the feed", async () => {
    const { calls, feed, tree, host, setListening } = parts();
    const rescans = startRescans({ feed, tree, host });
    onTestFinished(() => rescans.close());

    setListening(false);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(calls).toEqual([]);
    setListening(true);
    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(calls).toEqual(["rescan", "repairDue"]);
  });

  it("does nothing at a tick that comes while the last one runs", async () => {
    const { calls, feed, host } = parts();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const tree = {
      rescan: async () => {
        calls.push("rescan");
        await held;
      },
    };
    const rescans = startRescans({ feed, tree, host });
    onTestFinished(() => rescans.close());

    await vi.advanceTimersByTimeAsync(TICK_MS * 3);
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["rescan", "repairDue"]);
  });

  it("goes on to the repair and to the next tick when a call rejects", async () => {
    const calls: string[] = [];
    const tree = {
      rescan: () => {
        calls.push("rescan");
        return Promise.reject(new Error("the read failed"));
      },
    };
    const host = {
      repairDue: () => {
        calls.push("repairDue");
        return Promise.reject(new Error("the repair failed"));
      },
    };
    const rescans = startRescans({ feed: { listening: () => true }, tree, host });
    onTestFinished(() => rescans.close());

    await vi.advanceTimersByTimeAsync(TICK_MS * 2);

    expect(calls).toEqual(["rescan", "repairDue", "rescan", "repairDue"]);
  });

  it("stops at close, after the tick in flight", async () => {
    const { calls, feed, host } = parts();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const tree = {
      rescan: async () => {
        calls.push("rescan");
        await held;
      },
    };
    const rescans = startRescans({ feed, tree, host });
    await vi.advanceTimersByTimeAsync(TICK_MS);

    let closed = false;
    const closing = rescans.close().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    release();
    await closing;
    await vi.advanceTimersByTimeAsync(TICK_MS * 2);

    expect(calls).toEqual(["rescan", "repairDue"]);
  });

  it("takes the interval it is given", async () => {
    const { calls, feed, tree, host } = parts();
    const rescans = startRescans({ feed, tree, host, intervalMs: 50 });
    onTestFinished(() => rescans.close());

    await vi.advanceTimersByTimeAsync(50);

    expect(calls).toEqual(["rescan", "repairDue"]);
  });
});
