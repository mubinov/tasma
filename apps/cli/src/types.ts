/** Anything a byte can be written to. Structural, so a test collects what a stream would print. */
export type Sink = { write(text: string): unknown };

/** The two streams a command may write to, injected so nothing below the entry point reads a global. */
export type Io = { stdout: Sink; stderr: Sink };

export type Command = { name: string; summary: string; run(args: string[], io: Io): number };
