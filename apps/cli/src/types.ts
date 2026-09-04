/** Anything a byte can be written to. Structural, so a test collects what a stream would print. */
export type Sink = { write(text: string): unknown };

/** The two streams a command may write to, injected so nothing below the entry point reads a global. */
export type Io = { stdout: Sink; stderr: Sink };

/**
 * One command, or one verb below a noun: the two have the same shape, so one
 * dispatcher serves both levels.
 *
 * `daemonUrl` is resolved once above and handed down, so no command resolves an
 * address of its own.
 */
export type Command = {
  name: string;
  summary: string;
  run(args: string[], io: Io, daemonUrl: string): Promise<number>;
};
