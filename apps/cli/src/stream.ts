// What the CLI does with its standard streams beyond plain reads and writes:
// the reader of an output that closed before the writing was done, and an input
// read through its events rather than its async iteration.

import type { Source } from "./types.js";

/** A stream as this rule reads one: something that reports its failures rather than throwing them at the write. */
export type Reporting = { on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown };

/**
 * Lets a stream end quietly where its reader closed it.
 *
 * A write to a pipe is asynchronous, so a reader that closes early — the shape
 * `tasma task view <id> | head` takes — leaves the failure as an event on the
 * stream, and with nothing listening the event is an uncaught throw: a paged
 * read of a task would end in a stack trace rather than the page it asked for.
 * Every other failure still throws, since no reader asked for it.
 */
export function quietOnBrokenPipe(stream: Reporting): void {
  stream.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
  });
}

/**
 * A stream as the event read takes one: the three events that carry its bytes,
 * its end and its failure, and the pause that stops it flowing.
 */
export type Emitting = {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  off(event: "end", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  pause(): unknown;
};

/**
 * A stream read to its end through its `data`, `end` and `error` events.
 *
 * Nothing listens until the first `next()`, because a `data` listener starts
 * the stream flowing. Removing that listener does not stop the flow, so a read
 * that stops early pauses the stream. The chunks queue without a cap until they
 * are read.
 */
export async function* readThroughEvents(stream: Emitting): Source {
  const queue: (Uint8Array | string)[] = [];
  let ended = false;
  let failure: { error: Error } | undefined;
  let wake: (() => void) | undefined;

  const signal = (): void => {
    wake?.();
    wake = undefined;
  };
  const onData = (chunk: Uint8Array | string): void => {
    queue.push(chunk);
    signal();
  };
  const onEnd = (): void => {
    ended = true;
    signal();
  };
  const onError = (error: Error): void => {
    failure = { error };
    signal();
  };

  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("error", onError);

  try {
    for (;;) {
      if (failure !== undefined) throw failure.error;

      const chunk = queue.shift();

      if (chunk !== undefined) {
        yield chunk;
      } else if (ended) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
  } finally {
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("error", onError);
    stream.pause();
  }
}
