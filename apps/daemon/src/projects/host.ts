// One open index per project, and the discovery every route reads the tree
// through.
//
// The host is created by whoever owns the process and closed by it, so nothing
// below this file decides when a watch handle is released.

import {
  discoverProjects,
  endsLiveness,
  openIndexedProject,
  openProject,
  readProjectDeclaration,
  TaskStoreError,
} from "@tasma/engine";
import type { IndexedProject } from "@tasma/engine";
import type { ProjectSummary } from "@tasma/protocol";

/**
 * How many projects one listing reads the configuration of at a time. A tree
 * holds however many projects a user made, and each summary is two stats plus a
 * read of the project's own configuration file, so an unbounded listing would
 * hold a descriptor per project and reach the process limit on a large tree.
 */
const READ_LIMIT = 8;

/**
 * How long a project whose repair did not take is left alone before a read runs
 * another one. A repair is a full rescan — the directory, and the frontmatter of
 * every task file under it — while the causes it recovers from are the ones that
 * stand: an exhausted watch descriptor table does not clear because a request
 * arrived. Without the interval every read of such a project costs one rescan,
 * so a project of ten thousand tasks answers each of them with ten thousand file
 * opens.
 */
const REPAIR_INTERVAL_MS = 5000;

export type ProjectHost = {
  /** Every project of the tree, with the name and the path each one declares. */
  list(): Promise<ProjectSummary[]>;
  /** The open index for one tag, and whether it is still live. */
  open(tag: string): Promise<{ index: IndexedProject; live: boolean }>;
  /** Closes every open index. */
  close(): Promise<void>;
};

/**
 * One project the host holds open.
 *
 * The index is held as the promise of one rather than as the index itself: two
 * requests naming one tag can both arrive before the first open finishes, and a
 * plain index would let both open one, leaking a pair of watch handles.
 *
 * A class rather than a record, because the listener the open takes writes the
 * flag of the very instance the open is creating.
 */
class Held {
  live = true;
  /** The repair running over this index, so a second call joins it rather than starting another. */
  repair: Promise<void> | undefined;
  /**
   * When the last repair that ran to the end left the flag down, so the reads
   * that follow it inside the interval answer from what it found instead of
   * running one of their own. Cleared by a repair that took, whose flag stands
   * up and whose next loss has to be repaired at once.
   */
  repairedAt: number | undefined;
  readonly index: Promise<IndexedProject>;

  constructor(tag: string, root: string | undefined) {
    this.index = openIndexedProject(openProject({ project: tag, root }), {
      onDiagnostic: (diagnostic) => {
        if (endsLiveness(diagnostic.code)) this.live = false;
      },
    });
  }
}

/**
 * Retakes the watch of one index and leaves the flag stating the outcome.
 *
 * The flag is raised before the rescan and read back from the index after it,
 * which is what makes it honest. A watch that fails again is reported from
 * inside the rescan and the listener clears the flag a second time; a loss the
 * index already stood in reports nothing at all, because a loss reaches the
 * listener once per state the index lands in, so that half of the answer is read
 * from the index rather than inferred from its silence. The answer states
 * whether the repair worked, not that it was attempted.
 *
 * What is read back is whether the index follows the disk, never whether it
 * holds a tasks directory: a project that never had one holds none and follows
 * the disk perfectly, and it stays that way until its first write.
 */
async function runRepair(entry: Held, index: IndexedProject): Promise<void> {
  entry.live = true;
  try {
    await index.rescan();
    if (!index.followsDisk()) entry.live = false;
    entry.repairedAt = entry.live ? undefined : performance.now();
  } catch (error) {
    // A rescan that rejects took no watch and read no directory, and the
    // listener heard nothing of it, so the flag has to state that failure
    // itself. Left raised, it would make every later call skip the repair and
    // answer live for an index that stopped following the disk.
    entry.live = false;
    // It also did none of the work the interval exists to bound, and it hands
    // the caller a fault rather than an answer, so the call after it repairs.
    entry.repairedAt = undefined;
    throw error;
  } finally {
    // Cleared before the callers resume, so each of them reads a settled flag.
    entry.repair = undefined;
  }
}

/**
 * Whether a read of this project runs a repair: the flag is down, and no repair
 * that left it down has run inside the interval. The clock is the monotonic one,
 * so an interval outlives a change of the wall clock under the process.
 */
function dueForRepair(entry: Held, interval: number): boolean {
  if (entry.live) return false;
  return entry.repairedAt === undefined || performance.now() - entry.repairedAt >= interval;
}

/**
 * The projects of one tree, each opened on first use and held until the host is
 * closed.
 */
export function createProjectHost(options: {
  root?: string;
  /**
   * How long a project whose repair did not take is left alone, in
   * milliseconds. It is an option so that a test can decide whether a read falls
   * inside the interval or after it, rather than waiting one out.
   */
  repairInterval?: number;
}): ProjectHost {
  const root = options.root;
  const repairInterval = options.repairInterval ?? REPAIR_INTERVAL_MS;
  const held = new Map<string, Held>();
  let closing = false;

  /**
   * Refuses everything once the host is closing. The flag is what makes the
   * refusal work: clearing the map alone would let a later call re-run discovery
   * and open a fresh index on the way out.
   */
  function assertServing(): void {
    if (closing) {
      throw new TaskStoreError("index-closed", "this daemon is closing and answers for no project");
    }
  }

  /** Closes one index, or drops an open that never produced one. */
  async function drop(entry: Held): Promise<void> {
    const index = await entry.index.catch(() => undefined);
    await index?.close();
  }

  /**
   * The tags of the tree, having closed every held index whose project the tree
   * no longer holds. Both routes read the tree through this, so one directory
   * read answers three questions: which projects exist, which held index is
   * stale, and whether a tag names a project at all.
   */
  async function discover(): Promise<string[]> {
    const tags = await discoverProjects(root);
    const found = new Set(tags);
    // Which entries are stale is decided in one step, before anything is
    // awaited: a `Map` iterator visits what is inserted while it runs, so a
    // loop that awaited between the entries would close an index another call
    // opened against a tree this read never saw.
    const stale = [...held].filter(([tag]) => !found.has(tag));
    for (const [tag] of stale) held.delete(tag);
    await Promise.all(stale.map(([, entry]) => drop(entry)));
    return tags;
  }

  /**
   * One project of the listing, read from the project's own configuration file
   * alone: it is the one file that can state either field, and the shared user
   * file it does not read can neither contribute a value nor refuse the tree.
   *
   * A project this read fails on is listed by its tag alone and nothing is
   * reported: the listing answers which projects exist, and a finding about one
   * project's file belongs on that project's own resource, where it names one
   * file rather than arriving in a list of many.
   *
   * Every fault is taken that way, not the refusals of the store alone. The read
   * names this project's directory and this project's own configuration file and
   * nothing else, so a permission or a descriptor limit met under either of them
   * says as little about the rest of the tree as a file that will not parse — and
   * failing the whole listing over one project would answer nothing about the
   * healthy ones. Only a fault of the tree itself, which `discover` raises,
   * refuses the listing.
   */
  async function summarize(tag: string): Promise<ProjectSummary> {
    try {
      const { name, path } = await readProjectDeclaration({ project: tag, root });
      return { tag, name, path };
    } catch {
      return { tag };
    }
  }

  /**
   * The summaries of a whole tree, as many at a time as the read limit allows.
   * The workers share one iterator, so what is in flight is bounded by how many
   * of them there are rather than by how many projects the tree holds, and each
   * writes its answer under the position it took so the order of the tree is
   * kept. None of them can fail, because `summarize` answers for every fault it
   * meets, so a listing that returns leaves no read of its own still running.
   */
  async function summarizeAll(tags: string[]): Promise<ProjectSummary[]> {
    const summaries: ProjectSummary[] = [];
    const pending = tags.entries();
    const workers = Array.from({ length: READ_LIMIT }, async () => {
      for (const [at, tag] of pending) summaries[at] = await summarize(tag);
    });
    await Promise.all(workers);
    return summaries;
  }

  return {
    async list() {
      assertServing();
      const tags = await discover();
      assertServing();
      // One read of one file per project, so a listing opens no index.
      return summarizeAll(tags);
    },

    async open(tag) {
      assertServing();
      const tags = await discover();
      // Read again, now that the directory read has returned: a close that
      // completed while it ran drained the map, and an open that went on would
      // leave a watch handle where nothing looks for one again. Nothing is
      // awaited between here and the insert below, so no close can land inside
      // that window.
      assertServing();
      if (!tags.includes(tag)) {
        // Whatever the reason the tree does not list it: a tag nobody created
        // and a name that is no tag are one answer, so neither states which.
        throw new TaskStoreError("project-not-found", `no project of this tree is tagged "${tag}"`);
      }

      let entry = held.get(tag);
      if (entry === undefined) {
        const started = new Held(tag, root);
        held.set(tag, started);
        // An open that failed holds nothing, so the next request opens again.
        void started.index.catch(() => {
          if (held.get(tag) === started) held.delete(tag);
        });
        entry = started;
      }

      const index = await entry.index;
      // A repair already running is joined rather than started again, so the
      // flag this answer carries is the outcome of a rescan that returned. The
      // running one is what a call arriving before the flag is raised joins:
      // the raised flag is no guard once a repair has begun.
      let running = entry.repair;
      if (running === undefined && dueForRepair(entry, repairInterval)) {
        running = runRepair(entry, index);
        entry.repair = running;
      }
      if (running !== undefined) await running;
      return { index, live: entry.live };
    },

    async close() {
      closing = true;
      const open = [...held.values()];
      held.clear();
      await Promise.all(open.map(drop));
    },
  };
}
