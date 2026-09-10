/** Anything a byte can be written to. Structural, so a test collects what a stream would print. */
export type Sink = { write(text: string): unknown };

/** Anything bytes or text can be read from to its end. Node's `Readable` is one. */
export type Source = AsyncIterable<Uint8Array | string>;

/** The three streams a command may use, injected so nothing below the entry point reads a global. */
export type Io = { stdin: Source; stdout: Sink; stderr: Sink };

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

/** What a verb's parser is given, and what its usage block is read against. */
export type Options = Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>;

/**
 * One verb's arguments, as the one description its parser and its usage block
 * are both read against: a flag added to the table and left out of the block is
 * a flag the CLI accepts and documents nowhere.
 */
export type Usage = { help: string[]; options: Options };

/**
 * One command, or one verb below a noun: the two have the same shape, so one
 * dispatcher serves both levels.
 *
 * The target is resolved once above and handed down, so no command resolves an
 * address of its own. So is the working directory, which is empty where the
 * entry point could not read one; a verb that reads it says so itself, and the
 * rest take it without declaring it.
 *
 * A noun carries the verbs below it and parses no argument of its own; a verb
 * carries its arguments and holds no verb. Both are read off the registry, so
 * the set of verbs and the documentation of each have one place to be stated.
 */
export type Command = {
  name: string;
  summary: string;
  run(args: string[], io: Io, target: Target, cwd: string): Promise<number>;
  verbs?: Command[];
  usage?: Usage;
};
