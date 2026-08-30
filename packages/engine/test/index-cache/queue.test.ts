import { describe, expect, it } from "vitest";
import { Gate, PathQueue } from "../../src/index-cache/queue.js";

/** A promise the test settles by hand, so an operation can be held mid-flight. */
function held(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("PathQueue", () => {
  it("runs an operation that arrives on an idle path at once", async () => {
    const queue = new PathQueue();
    const ran: string[] = [];

    await queue.run("a", async () => {
      ran.push("first");
    });

    expect(ran).toEqual(["first"]);
  });

  it("holds a second operation on one path until the first has finished", async () => {
    const queue = new PathQueue();
    const ran: string[] = [];
    const first = held();

    const running = queue.run("a", async () => {
      await first.promise;
      ran.push("first");
    });
    const queued = queue.run("a", async () => {
      ran.push("second");
    });
    await Promise.resolve();

    expect(ran).toEqual([]);

    first.release();
    await Promise.all([running, queued]);

    expect(ran).toEqual(["first", "second"]);
  });

  it("joins a third request to the one already queued, rather than reading a third time", async () => {
    const queue = new PathQueue();
    const ran: string[] = [];
    const first = held();

    const running = queue.run("a", () => first.promise);
    const queued = queue.run("a", async () => {
      ran.push("second");
    });
    const joined = queue.run("a", async () => {
      ran.push("third");
    });

    expect(joined).toBe(queued);

    first.release();
    await Promise.all([running, queued, joined]);

    expect(ran).toEqual(["second"]);
  });

  it("queues an operation that arrives once the queued one is running", async () => {
    const queue = new PathQueue();
    const ran: string[] = [];
    const first = held();
    const second = held();

    const running = queue.run("a", () => first.promise);
    const queued = queue.run("a", async () => {
      ran.push("second");
      await second.promise;
    });
    first.release();
    await running;
    await Promise.resolve();
    const last = queue.run("a", async () => {
      ran.push("third");
    });
    second.release();
    await Promise.all([queued, last]);

    expect(ran).toEqual(["second", "third"]);
  });

  it("runs two paths at the same time", async () => {
    const queue = new PathQueue();
    const ran: string[] = [];
    const first = held();

    const one = queue.run("a", async () => {
      await first.promise;
      ran.push("a");
    });
    await queue.run("b", async () => {
      ran.push("b");
    });

    expect(ran).toEqual(["b"]);

    first.release();
    await one;

    expect(ran).toEqual(["b", "a"]);
  });

  it("runs the next operation although the one before it failed", async () => {
    const queue = new PathQueue();
    const ran: string[] = [];
    const first = held();

    const failing = queue.run("a", async () => {
      await first.promise;
      throw new Error("the read failed");
    });
    const queued = queue.run("a", async () => {
      ran.push("second");
    });
    first.release();

    await expect(failing).rejects.toThrow("the read failed");
    await queued;

    expect(ran).toEqual(["second"]);
  });

  it("takes a path back to idle once its operations have finished", async () => {
    const queue = new PathQueue();
    const ran: string[] = [];

    await queue.run("a", async () => {
      ran.push("first");
    });
    await queue.run("a", async () => {
      ran.push("second");
    });

    expect(ran).toEqual(["first", "second"]);
  });
});

describe("Gate", () => {
  it("runs an operation that arrives while the gate is open at once", async () => {
    const gate = new Gate(2);

    expect(await gate.run(async () => "read")).toBe("read");
  });

  it("holds every operation over the limit until a slot comes free", async () => {
    const gate = new Gate(2);
    const ran: number[] = [];
    const first = held();

    const running = [1, 2, 3, 4].map((number) =>
      gate.run(async () => {
        ran.push(number);
        await first.promise;
      }),
    );
    await Promise.resolve();

    expect(ran).toEqual([1, 2]);

    first.release();
    await Promise.all(running);

    expect(ran).toEqual([1, 2, 3, 4]);
  });

  it("hands the slot of an operation that failed to the next one", async () => {
    const gate = new Gate(1);
    const ran: string[] = [];

    const failing = gate.run(async () => {
      throw new Error("the read failed");
    });
    const queued = gate.run(async () => {
      ran.push("second");
    });

    await expect(failing).rejects.toThrow("the read failed");
    await queued;

    expect(ran).toEqual(["second"]);
  });

  it("takes the gate back to idle once its operations have finished", async () => {
    const gate = new Gate(1);
    const ran: string[] = [];

    await gate.run(async () => void ran.push("first"));
    await gate.run(async () => void ran.push("second"));

    expect(ran).toEqual(["first", "second"]);
  });
});
