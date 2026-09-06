/** Anything a byte can be written to. Structural, so a test collects what a stream would print. */
export type Sink = { write(text: string): unknown };

/** The two streams a command may write to, injected so nothing below the entry point reads a global. */
export type Io = { stdout: Sink; stderr: Sink };

/**
 * Which daemon a command acts on: the one an address named, or the one serving
 * the tree under `home`.
 *
 * `stated` names the channel the address arrived through, so a verb that refuses
 * an address can say which one to remove. A tree target carries its home rather
 * than a path, because a verb reads the record and signals the process behind
 * it, and both are derived from the home.
 */
export type Target
  = | { kind: "explicit"; url: string; stated: "--daemon" | "TASMA_DAEMON_URL" }
    | { kind: "tree"; home: string };

/**
 * One command, or one verb below a noun: the two have the same shape, so one
 * dispatcher serves both levels.
 *
 * The target is resolved once above and handed down, so no command resolves an
 * address of its own.
 */
export type Command = {
  name: string;
  summary: string;
  run(args: string[], io: Io, target: Target): Promise<number>;
};
