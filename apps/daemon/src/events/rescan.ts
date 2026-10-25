// The rescan tick: while a client reads the feed, a read of the whole tree and a
// repair of the projects that are due, for the watch events that are lost or
// never come.

import type { TreeWatch } from "@tasma/engine";
import type { ProjectHost } from "../projects/host.js";
import type { Feed } from "./feed.js";

/** How often the tick runs while a client reads the feed. */
const RESCAN_MS = 20_000;

export type Rescans = {
  /** Stops the ticks and waits for the one in flight. */
  close(): Promise<void>;
};

export function startRescans(options: {
  feed: Pick<Feed, "listening">;
  tree: Pick<TreeWatch, "rescan">;
  host: Pick<ProjectHost, "repairDue">;
  intervalMs?: number;
}): Rescans {
  const { feed, tree, host } = options;
  let running: Promise<void> | undefined;

  async function tick(): Promise<void> {
    await tree.rescan().catch(() => undefined);
    await host.repairDue().catch(() => undefined);
  }

  const timer = setInterval(() => {
    if (running !== undefined || !feed.listening()) return;
    running = tick().finally(() => (running = undefined));
  }, options.intervalMs ?? RESCAN_MS);
  timer.unref();

  return {
    async close() {
      clearInterval(timer);
      await running;
    },
  };
}
