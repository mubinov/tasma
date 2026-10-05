import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { quietOnBrokenPipe, readThroughEvents } from "../src/stream.js";

/** A failure a stream reports, as the kernel names it. */
function failure(syscall: "read" | "write", code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${syscall} ${code}`), { code });
}

/** A stream the tests emit the events of by hand. */
function emitter(): EventEmitter & { pause(): void } {
  return Object.assign(new EventEmitter(), { pause: () => {} });
}

/** How many listeners each of the three events the read uses holds. */
function listeners(stream: EventEmitter): number[] {
  return ["data", "end", "error"].map((event) => stream.listenerCount(event));
}

/** The next result of an iterator, with the events it waits on emitted once the call has started the read. */
function nextAfter<T>(iterator: AsyncIterator<T>, emit: () => void): Promise<IteratorResult<T>> {
  const pending = iterator.next();

  emit();

  return pending;
}

describe("quietOnBrokenPipe", () => {
  it("swallows the failure a reader that closed early leaves", () => {
    const stream = new EventEmitter();

    quietOnBrokenPipe(stream);

    expect(() => stream.emit("error", failure("write", "EPIPE"))).not.toThrow();
  });

  // No reader asked for one of these, so it stays the uncaught failure it was.
  it("leaves every other failure to throw", () => {
    const stream = new EventEmitter();

    quietOnBrokenPipe(stream);

    expect(() => stream.emit("error", failure("write", "ENOSPC"))).toThrow("write ENOSPC");
  });
});

describe("readThroughEvents", () => {
  it("yields the chunks in the order they were emitted, and ends at the end event", async () => {
    const stream = emitter();
    const iterator = readThroughEvents(stream)[Symbol.asyncIterator]();
    const first = iterator.next();

    stream.emit("data", "one");
    stream.emit("data", Buffer.from("two"));
    stream.emit("end");

    expect(await first).toEqual({ done: false, value: "one" });
    expect(await iterator.next()).toEqual({ done: false, value: Buffer.from("two") });
    expect((await iterator.next()).done).toBe(true);
  });

  it("adds no listener until the first next()", () => {
    const stream = emitter();
    const iterator = readThroughEvents(stream)[Symbol.asyncIterator]();

    expect(listeners(stream)).toEqual([0, 0, 0]);

    void iterator.next();

    expect(listeners(stream)).toEqual([1, 1, 1]);
  });

  it("rejects a next() that waits when the error arrives, and removes its listeners", async () => {
    const stream = emitter();
    const iterator = readThroughEvents(stream)[Symbol.asyncIterator]();

    await expect(nextAfter(iterator, () => stream.emit("error", failure("read", "EIO")))).rejects.toThrow("read EIO");

    expect(listeners(stream)).toEqual([0, 0, 0]);
  });

  it("rejects the next call after an error, and drops the chunks still queued", async () => {
    const stream = emitter();
    const iterator = readThroughEvents(stream)[Symbol.asyncIterator]();

    expect(await nextAfter(iterator, () => stream.emit("data", "one"))).toEqual({ done: false, value: "one" });

    stream.emit("data", "two");
    stream.emit("error", failure("read", "EIO"));

    await expect(iterator.next()).rejects.toThrow("read EIO");
  });

  it("removes its listeners after the end event", async () => {
    const stream = emitter();
    const iterator = readThroughEvents(stream)[Symbol.asyncIterator]();

    await nextAfter(iterator, () => stream.emit("end"));

    expect(listeners(stream)).toEqual([0, 0, 0]);
  });

  it("removes its listeners and stops the stream when the loop stops early", async () => {
    const stream = new PassThrough();

    stream.write("one");

    for await (const chunk of readThroughEvents(stream)) {
      expect(String(chunk)).toBe("one");
      break;
    }

    expect(listeners(stream)).toEqual([0, 0, 0]);
    expect(stream.readableFlowing).toBe(false);
  });
});
