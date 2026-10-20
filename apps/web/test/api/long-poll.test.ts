import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLongPoll, type PollReply } from "../../src/api/long-poll";

type Read = {
  after: string | undefined;
  signal: AbortSignal;
  answer: (reply: PollReply<string>) => void;
  fail: (error: unknown) => void;
};

/** A `read` whose every call waits until the test answers or fails it. */
function heldReads() {
  const reads: Read[] = [];

  function read(after: string | undefined, signal: AbortSignal): Promise<PollReply<string>> {
    return new Promise((resolve, reject) => {
      reads.push({ after, signal, answer: resolve, fail: reject });
    });
  }

  return { reads, read };
}

/** Runs the promise jobs that a settled read starts, with no time passing. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function last(reads: Read[]): Read {
  const read = reads.at(-1);
  if (read === undefined) {
    throw new Error("no read was made");
  }
  return read;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startLongPoll", () => {
  it("asks for the current cursor first and then reads after the cursor of each reply", async () => {
    const { reads, read } = heldReads();
    startLongPoll({ read, onEvents: () => {}, onReset: () => {} });

    expect(reads.map((call) => call.after)).toEqual([undefined]);

    last(reads).answer({ cursor: "c1", events: [] });
    await settle();
    last(reads).answer({ cursor: "c2", events: ["one"] });
    await settle();

    expect(reads.map((call) => call.after)).toEqual([undefined, "c1", "c2"]);
  });

  it("starts after the cursor it is given", () => {
    const { reads, read } = heldReads();
    startLongPoll({ after: "0", read, onEvents: () => {}, onReset: () => {} });

    expect(reads.map((call) => call.after)).toEqual(["0"]);
  });

  it("hands the events of a reply over and skips a reply with none", async () => {
    const { reads, read } = heldReads();
    const onEvents = vi.fn();
    startLongPoll({ read, onEvents, onReset: () => {} });

    last(reads).answer({ cursor: "c1", events: [] });
    await settle();
    last(reads).answer({ cursor: "c2", events: ["one", "two"] });
    await settle();

    expect(onEvents.mock.calls).toEqual([[["one", "two"]]]);
  });

  it("calls onReset on a reset and reads after the cursor of the reset", async () => {
    const { reads, read } = heldReads();
    const onEvents = vi.fn();
    const onReset = vi.fn();
    startLongPoll({ after: "old", read, onEvents, onReset });

    last(reads).answer({ reset: true, cursor: "c9" });
    await settle();

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onEvents).not.toHaveBeenCalled();
    expect(last(reads).after).toBe("c9");
  });

  it("waits 1, 2, 4, 8 and then 10 seconds between failed reads, with the same cursor", async () => {
    const { reads, read } = heldReads();
    startLongPoll({ after: "c1", read, onEvents: () => {}, onReset: () => {} });

    for (const wait of [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
      const count = reads.length;
      last(reads).fail(new Error("connection refused"));
      await settle();

      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(reads).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads).toHaveLength(count + 1);
    }

    expect(new Set(reads.map((call) => call.after))).toEqual(new Set(["c1"]));
  });

  it("waits 1 second again after a failure that follows a reply", async () => {
    const { reads, read } = heldReads();
    startLongPoll({ after: "c1", read, onEvents: () => {}, onReset: () => {} });

    last(reads).fail(new Error("connection refused"));
    await vi.advanceTimersByTimeAsync(1_000);
    last(reads).fail(new Error("connection refused"));
    await vi.advanceTimersByTimeAsync(2_000);
    last(reads).answer({ cursor: "c2", events: [] });
    await settle();
    const count = reads.length;
    last(reads).fail(new Error("connection refused"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reads).toHaveLength(count + 1);
    expect(last(reads).after).toBe("c2");
  });

  it("reads after the new cursor, after a wait, when a handler throws", async () => {
    const { reads, read } = heldReads();
    startLongPoll({
      after: "c1",
      read,
      onEvents: () => {
        throw new Error("a mapper failed");
      },
      onReset: () => {},
    });

    last(reads).answer({ cursor: "c2", events: ["one"] });
    await settle();
    expect(reads).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads).toHaveLength(2);
    expect(last(reads).after).toBe("c2");
  });

  it("aborts the held read on stop and calls nothing after it", async () => {
    const { reads, read } = heldReads();
    const onEvents = vi.fn();
    const onReset = vi.fn();
    const poll = startLongPoll({ after: "c1", read, onEvents, onReset });
    const held = last(reads);

    poll.stop();
    expect(held.signal.aborted).toBe(true);

    held.answer({ cursor: "c2", events: ["one"] });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(onEvents).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
    expect(reads).toHaveLength(1);
  });

  it("ends quietly when the held read fails after stop", async () => {
    const { reads, read } = heldReads();
    const poll = startLongPoll({ after: "c1", read, onEvents: () => {}, onReset: () => {} });

    poll.stop();
    last(reads).fail(new DOMException("The operation was aborted.", "AbortError"));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(reads).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("makes no further read when stopped during a wait", async () => {
    const { reads, read } = heldReads();
    const poll = startLongPoll({ after: "c1", read, onEvents: () => {}, onReset: () => {} });

    last(reads).fail(new Error("connection refused"));
    await settle();
    expect(vi.getTimerCount()).toBe(1);

    poll.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(reads).toHaveLength(1);
  });

  it("does nothing on a second stop", () => {
    const { reads, read } = heldReads();
    const poll = startLongPoll({ after: "c1", read, onEvents: () => {}, onReset: () => {} });
    const onAbort = vi.fn();
    last(reads).signal.addEventListener("abort", onAbort);

    poll.stop();
    poll.stop();

    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});

describe("startLongPoll onStatus", () => {
  it("reports 0 after a reply with events, an empty reply and a reset", async () => {
    const { reads, read } = heldReads();
    const onStatus = vi.fn();
    startLongPoll({ after: "c1", read, onEvents: () => {}, onReset: () => {}, onStatus });

    last(reads).answer({ cursor: "c2", events: ["one"] });
    await settle();
    last(reads).answer({ cursor: "c2", events: [] });
    await settle();
    last(reads).answer({ reset: true, cursor: "c0" });
    await settle();

    expect(onStatus.mock.calls).toEqual([[0], [0], [0]]);
  });

  it("counts the failed reads in a row, and reports 0 after the next success", async () => {
    const { reads, read } = heldReads();
    const onStatus = vi.fn();
    startLongPoll({ after: "c1", read, onEvents: () => {}, onReset: () => {}, onStatus });

    last(reads).fail(new Error("connection refused"));
    await vi.advanceTimersByTimeAsync(1_000);
    last(reads).fail(new Error("connection refused"));
    await vi.advanceTimersByTimeAsync(2_000);
    last(reads).fail(new Error("connection refused"));
    await vi.advanceTimersByTimeAsync(4_000);
    last(reads).answer({ cursor: "c2", events: [] });
    await settle();
    last(reads).fail(new Error("connection refused"));
    await settle();

    expect(onStatus.mock.calls).toEqual([[1], [2], [3], [0], [1]]);
  });

  it("reports the failure before the wait starts", async () => {
    const { reads, read } = heldReads();
    const onStatus = vi.fn();
    startLongPoll({ after: "c1", read, onEvents: () => {}, onReset: () => {}, onStatus });

    last(reads).fail(new Error("connection refused"));
    await settle();

    expect(onStatus.mock.calls).toEqual([[1]]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("counts a handler that throws as a failed read", async () => {
    const { reads, read } = heldReads();
    const onStatus = vi.fn();
    startLongPoll({
      after: "c1",
      read,
      onEvents: () => {
        throw new Error("a mapper failed");
      },
      onReset: () => {},
      onStatus,
    });

    last(reads).answer({ cursor: "c2", events: ["one"] });
    await settle();

    expect(onStatus.mock.calls).toEqual([[1]]);
  });

  it("goes on reading when onStatus throws, after a success and after a failure", async () => {
    const { reads, read } = heldReads();
    const onEvents = vi.fn();
    startLongPoll({
      after: "c1",
      read,
      onEvents,
      onReset: () => {},
      onStatus: () => {
        throw new Error("a status handler failed");
      },
    });

    last(reads).answer({ cursor: "c2", events: ["one"] });
    await settle();
    expect(reads).toHaveLength(2);
    expect(last(reads).after).toBe("c2");

    last(reads).fail(new Error("connection refused"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads).toHaveLength(3);

    last(reads).answer({ cursor: "c3", events: ["two"] });
    await settle();
    expect(onEvents.mock.calls).toEqual([[["one"]], [["two"]]]);
    expect(reads).toHaveLength(4);
  });

  it("reports nothing after stop, whether the held read answers or fails", async () => {
    const { reads, read } = heldReads();
    const onStatus = vi.fn();
    const answered = startLongPoll({ after: "c1", read, onEvents: () => {}, onReset: () => {}, onStatus });
    answered.stop();
    last(reads).answer({ cursor: "c2", events: ["one"] });

    const failed = startLongPoll({ after: "c1", read, onEvents: () => {}, onReset: () => {}, onStatus });
    failed.stop();
    last(reads).fail(new Error("connection refused"));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(onStatus).not.toHaveBeenCalled();
  });

  it("reports nothing when a handler stops the loop", async () => {
    const { reads, read } = heldReads();
    const onStatus = vi.fn();
    const poll = startLongPoll({
      after: "c1",
      read,
      onEvents: () => {
        poll.stop();
      },
      onReset: () => {},
      onStatus,
    });

    last(reads).answer({ cursor: "c2", events: ["one"] });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(onStatus).not.toHaveBeenCalled();
    expect(reads).toHaveLength(1);
  });
});
