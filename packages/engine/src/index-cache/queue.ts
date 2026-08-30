/**
 * At most a fixed number of operations at one time, whoever asked for them.
 *
 * A queue that orders one path bounds nothing across paths: a burst of events
 * names a different file each time, and every operation of the index holds a
 * file handle and a buffer while it runs. Without a bound, one `git checkout` in
 * the tasks directory would open a descriptor per task file at the same moment,
 * and a read that then failed on the descriptor limit of the process would be
 * recorded as a file that cannot be read.
 */
export class Gate {
  readonly #limit: number;
  readonly #waiting: (() => void)[] = [];
  #running = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#limit) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else this.#running += 1;
    try {
      return await operation();
    } finally {
      // The slot is handed to the next one waiting rather than released and
      // taken again, so an operation that arrives meanwhile cannot pass it.
      const next = this.#waiting.shift();
      if (next === undefined) this.#running -= 1;
      else next();
    }
  }
}

/**
 * One operation per path at a time, and at most one waiting behind it.
 *
 * Every operation of the index reads the file it names, so two that overlap can
 * land in the wrong order and leave the map holding frontmatter that is already
 * stale. Chaining them makes the last request the one that decides. A request
 * that arrives while one is already waiting joins it rather than adding another:
 * the waiting operation has not read anything yet, so its read answers both.
 */
export class PathQueue {
  readonly #running = new Map<string, Promise<void>>();
  readonly #queued = new Map<string, Promise<void>>();

  run(path: string, operation: () => Promise<void>): Promise<void> {
    const queued = this.#queued.get(path);
    if (queued !== undefined) return queued;
    const running = this.#running.get(path);
    if (running === undefined) return this.#start(path, operation);
    // A failure of the operation before it decides nothing about this one, which
    // reads the file for itself.
    const next = running.catch(() => undefined).then(() => {
      this.#queued.delete(path);
      return this.#start(path, operation);
    });
    this.#queued.set(path, next);
    return next;
  }

  #start(path: string, operation: () => Promise<void>): Promise<void> {
    // The one queued behind it starts from here, so the path is idle again
    // before anything can take its place.
    const run = operation().finally(() => this.#running.delete(path));
    this.#running.set(path, run);
    return run;
  }
}
