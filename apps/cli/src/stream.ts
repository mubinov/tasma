// What the CLI does about the one stream failure a caller chooses: the reader
// that closed before the writing was done.

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
