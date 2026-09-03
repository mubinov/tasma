// The turn two writes take when they reach one file at once.
//
// A write route is `host.open` → `index.<write>` → the store's
// read-modify-write, and nothing between the read of the file and the rename
// that replaces it re-checks what is on disk. Two writes that overlap read one
// snapshot, and the later rename carries the earlier one away: both callers are
// answered with a receipt and only one change survives. An added comment is
// worse than a field — the id comes off the snapshot, so both callers are given
// the same one and the loser holds a receipt for a comment no file carries.
//
// The daemon is the first caller that can overlap two writes. The CLI drives the
// same engine one write per invocation, which is why the store was never asked
// to order them.

/**
 * A first-in, first-out queue over each key: a write runs after every write that
 * entered before it under that key, and writes under different keys never wait
 * for one another.
 *
 * This is not the engine's `PathQueue`. That one coalesces the waiters on a path
 * into a single run, which is what a read-back of the disk wants and what a
 * write cannot have: the coalesced write would be the one that never happens.
 */
export class WriteQueue {
  readonly #turns = new Map<string, Promise<void>>();

  /**
   * How many keys the queue holds. A key is dropped once the last write under it
   * ends, so an idle queue holds none: the keys are ids a caller names, and a
   * queue that kept them would grow by one for every task ever written.
   */
  get size(): number {
    return this.#turns.size;
  }

  /**
   * Runs one write in its turn and answers exactly as the write did, refusal
   * included. The turn is taken when this is called rather than when the write
   * ahead ends, which is what makes the order the order of arrival.
   */
  async run<T>(key: string, write: () => Promise<T>): Promise<T> {
    const ahead = this.#turns.get(key);
    let ended!: () => void;
    const turn = new Promise<void>((resolve) => {
      ended = resolve;
    });
    this.#turns.set(key, turn);
    // A turn ends whichever way its write ended, so a wait never carries the
    // refusal of the write ahead to this caller.
    await ahead;
    try {
      return await write();
    } finally {
      ended();
      if (this.#turns.get(key) === turn) this.#turns.delete(key);
    }
  }
}

/**
 * The key the writes of one task share, which is the file they all rewrite. A
 * path is decoded before it is captured, so the separator is the one character a
 * segment cannot spell without percent-encoding; a pair that shared a key even so
 * would cost each other a turn, never a write.
 */
export function taskKey(project: string, id: string): string {
  return `task\u0000${project}\u0000${id}`;
}

/**
 * The key every create of one project shares. A create writes a file no id yet
 * names and takes its number from the project's one counter: the exclusive
 * create that consumes the counter recovers from a single collision and refuses
 * on the second, so overlapping creates refuse each other rather than lose a
 * file.
 */
export function createKey(project: string): string {
  return `create\u0000${project}`;
}
