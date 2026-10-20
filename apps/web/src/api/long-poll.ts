export type PollReply<Event> = { cursor: string; events: Event[] } | { reset: true; cursor: string };

export type LongPollOptions<Event> = {
  /** The first cursor. Absent, the first read asks for the current cursor. */
  after?: string;
  read: (after: string | undefined, signal: AbortSignal) => Promise<PollReply<Event>>;
  onEvents: (events: Event[]) => void;
  onReset: () => void;
  /** Called after each read: 0 after a success, else the number of failed reads in a row. */
  onStatus?: (failures: number) => void;
};

const FIRST_WAIT = 1_000;
const LONGEST_WAIT = 10_000;

/**
 * Reads a feed again as soon as each reply comes, and after a failure waits
 * longer each time, up to `LONGEST_WAIT`. The cursor moves before a handler
 * runs, so a handler that throws does not get the same events again, and
 * counts as a failed read.
 */
export function startLongPoll<Event>({
  after,
  read,
  onEvents,
  onReset,
  onStatus,
}: LongPollOptions<Event>): { stop(): void } {
  const controller = new AbortController();
  const { signal } = controller;
  let cursor = after;
  let wait = FIRST_WAIT;
  let failures = 0;
  let wake: (() => void) | undefined;

  function report(count: number): void {
    if (signal.aborted) {
      return;
    }
    try {
      onStatus?.(count);
    } catch {
      // A status handler cannot end the loop.
    }
  }

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);

      function done(): void {
        wake = undefined;
        resolve();
      }

      wake = () => {
        clearTimeout(timer);
        done();
      };
    });
  }

  async function run(): Promise<void> {
    while (!signal.aborted) {
      try {
        const reply = await read(cursor, signal);
        if (signal.aborted) {
          return;
        }

        cursor = reply.cursor;
        if ("reset" in reply) {
          onReset();
        } else if (reply.events.length > 0) {
          onEvents(reply.events);
        }
        wait = FIRST_WAIT;
        failures = 0;
        report(failures);
      } catch {
        if (signal.aborted) {
          return;
        }
        failures += 1;
        report(failures);
        await pause(wait);
        wait = Math.min(wait * 2, LONGEST_WAIT);
      }
    }
  }

  void run();

  return {
    stop() {
      controller.abort();
      wake?.();
    },
  };
}
