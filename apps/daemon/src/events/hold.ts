// The long-poll hold: a wait that a request stands in until something it reads
// may have changed. The hold carries no state of its own, so the caller reads its
// own state again after each wait.

/**
 * The longest a request is held. `test/macos.test.ts` keeps it at least 5 s
 * below the forward's timeout in the macOS shell, which counts from the start of
 * the request and answers 502 when it runs out.
 */
export const HOLD_MS = 25_000;

export type Hold = {
  /** Resolves at the release after the next `notify`, at the end of the hold, or at `close`. */
  wait(): Promise<void>;
  /** Releases every wait in the next turn of the event loop, so a burst of changes ends in one release. */
  notify(): void;
  /** Releases every wait, and makes each later wait resolve at once. */
  close(): void;
};

export function createHold(options: { holdMs: number }): Hold {
  const { holdMs } = options;
  const waiting = new Set<() => void>();
  let scheduled = false;
  let closed = false;

  function releaseAll(): void {
    const released = [...waiting];
    waiting.clear();
    for (const release of released) release();
  }

  return {
    wait() {
      if (closed) return Promise.resolve();

      return new Promise<void>((resolve) => {
        const release = (): void => {
          clearTimeout(timer);
          waiting.delete(release);
          resolve();
        };
        const timer = setTimeout(release, holdMs);
        timer.unref();
        waiting.add(release);
      });
    },

    notify() {
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        releaseAll();
      });
    },

    close() {
      closed = true;
      releaseAll();
    },
  };
}
