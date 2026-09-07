import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { quietOnBrokenPipe } from "../src/stream.js";

/** A failure a stream reports, as the kernel names it. */
function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code });
}

describe("quietOnBrokenPipe", () => {
  it("swallows the failure a reader that closed early leaves", () => {
    const stream = new EventEmitter();

    quietOnBrokenPipe(stream);

    expect(() => stream.emit("error", failure("EPIPE"))).not.toThrow();
  });

  // No reader asked for one of these, so it stays the uncaught failure it was.
  it("leaves every other failure to throw", () => {
    const stream = new EventEmitter();

    quietOnBrokenPipe(stream);

    expect(() => stream.emit("error", failure("ENOSPC"))).toThrow("write ENOSPC");
  });
});
