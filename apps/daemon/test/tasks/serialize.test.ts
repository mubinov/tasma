import { describe, expect, it } from "vitest";
import { createKey, taskKey, WriteQueue } from "../../src/tasks/serialize.js";

/** A promise a test resolves itself, so no assertion waits on a timer. */
function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("WriteQueue", () => {
  it("holds a write back until every write that entered before it under the key has ended", async () => {
    const queue = new WriteQueue();
    const first = held();
    const ran: string[] = [];

    const held1 = queue.run("one", async () => {
      ran.push("first");
      await first.promise;
    });
    const held2 = queue.run("one", () => {
      ran.push("second");
      return Promise.resolve();
    });
    await Promise.resolve();

    expect(ran).toEqual(["first"]);
    first.release();
    await Promise.all([held1, held2]);
    expect(ran).toEqual(["first", "second"]);
  });

  it("lets a write under another key run while one key is held", async () => {
    const queue = new WriteQueue();
    const first = held();
    const ran: string[] = [];

    const blocked = queue.run("one", async () => {
      ran.push("one");
      await first.promise;
    });
    await queue.run("two", () => {
      ran.push("two");
      return Promise.resolve();
    });

    expect(ran).toEqual(["one", "two"]);
    first.release();
    await blocked;
  });

  it("answers with the refusal of the write and hands the turn to the next one", async () => {
    const queue = new WriteQueue();

    const refused = queue.run("one", () => Promise.reject(new Error("the store refused")));
    const next = queue.run("one", () => Promise.resolve("written"));

    await expect(refused).rejects.toThrow("the store refused");
    await expect(next).resolves.toBe("written");
  });

  it("drops a key once the last write under it has ended", async () => {
    const queue = new WriteQueue();
    const first = held();

    const running = queue.run("one", () => first.promise);

    expect(queue.size).toBe(1);
    first.release();
    await running;
    expect(queue.size).toBe(0);
  });
});

describe("a write over more than one key", () => {
  it("holds a write under either of the keys it names", async () => {
    const queue = new WriteQueue();
    const first = held();
    const started = held();
    const ran: string[] = [];

    const both = queue.runAll(["two", "one"], async () => {
      ran.push("both");
      started.release();
      await first.promise;
    });
    // The turn of the second key is taken once the first is granted, so a write
    // that arrives before that runs ahead of this one rather than behind it.
    await started.promise;
    const behind = [
      queue.run("one", () => {
        ran.push("one");
        return Promise.resolve();
      }),
      queue.run("two", () => {
        ran.push("two");
        return Promise.resolve();
      }),
    ];
    await Promise.resolve();

    expect(ran).toEqual(["both"]);
    first.release();
    await Promise.all([both, ...behind]);
    expect(ran.slice(1).sort()).toEqual(["one", "two"]);
  });

  it("takes one pair of keys in one order, whichever order each write states them in", async () => {
    const queue = new WriteQueue();

    const answers = await Promise.all([
      queue.runAll(["one", "two"], () => Promise.resolve("first")),
      queue.runAll(["two", "one"], () => Promise.resolve("second")),
    ]);

    expect(answers).toEqual(["first", "second"]);
    expect(queue.size).toBe(0);
  });

  it("takes one turn for a key stated twice", async () => {
    const queue = new WriteQueue();

    await expect(queue.runAll(["one", "one"], () => Promise.resolve("written"))).resolves.toBe("written");

    expect(queue.size).toBe(0);
  });
});

describe("the keys the queue is driven by", () => {
  it("keys one task apart from another, from another project, and from the creates of its own", () => {
    expect(taskKey("TASM", "TASM-1")).toBe(taskKey("TASM", "TASM-1"));
    expect(taskKey("TASM", "TASM-1")).not.toBe(taskKey("TASM", "TASM-2"));
    expect(taskKey("TASM", "TASM-1")).not.toBe(taskKey("OTHER", "TASM-1"));
    expect(createKey("TASM")).not.toBe(taskKey("TASM", "TASM-1"));
    expect(createKey("TASM")).not.toBe(createKey("OTHER"));
  });
});
