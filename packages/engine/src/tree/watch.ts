import { type FSWatcher, statSync, watch } from "node:fs";
import type { WatchOpen } from "../index-cache/watch.js";
import { expandRoot } from "../store/paths.js";
import {
  diffTree,
  type ReadTree,
  readTree,
  type TreeArea,
  type TreeChange,
  type TreeState,
  watchedFolders,
  WHOLE_TREE,
} from "./state.js";

export type { TreeChange } from "./state.js";

/**
 * How long the events of one area are collected before the area is read again.
 * One save through a temporary file, or a checkout in the workflows folder,
 * sends several. The read decides what changed, so the value controls the cost
 * alone.
 */
const DEBOUNCE_MS = 100;

/**
 * The most folders the tree watches; the rescan alone reads the ones past it.
 * On macOS, Bun builds its one FSEvents stream again for each watch it adds, on
 * the thread that runs the daemon, so the cost of taking the watches grows with
 * the square of their number. A workflows folder can be any folder of the
 * user's, which sets that number.
 */
const WATCH_LIMIT = 128;

export type TreeWatch = {
  /** Reads the whole tree, takes again each watch that is missing, and resolves after it reports its changes. */
  rescan(): Promise<void>;
  /** Releases every watch and waits for the read in flight. No change is reported after it resolves. */
  close(): Promise<void>;
};

/** One folder the tree watches: the identity the watch stands on, and the area an event of it reads. */
type Held = { identity: string; area: TreeArea; watcher: FSWatcher | undefined };

function keyOf(area: TreeArea): string {
  if (area.kind === "project") return `project:${area.tag}`;
  if (area.kind === "workflow") return `workflow:${area.name}`;
  return area.kind;
}

/** The areas to read, each once, without an area that a list read with them covers. */
function coalesce(areas: TreeArea[]): TreeArea[] {
  if (areas.some((area) => area.kind === "all")) return [WHOLE_TREE];
  const kinds = new Set(areas.map((area) => area.kind));
  const kept = areas.filter(
    (area) => !(area.kind === "project" && kinds.has("projects")) && !(area.kind === "workflow" && kinds.has("workflows")),
  );
  return [...new Map(kept.map((area) => [keyOf(area), area])).values()];
}

/**
 * Flat watches on the folders that hold what the board reads: the tree root,
 * `projects/`, each project folder, the workflows folder and each workflow
 * folder. An event is a hint and the disk decides: it starts a read of the area
 * of its folder and a compare with the last state, and the name it carries is
 * not used.
 */
class Tree implements TreeWatch {
  readonly #root: string;
  readonly #onChange: (change: TreeChange) => void;
  readonly #open: WatchOpen;
  readonly #read: ReadTree;
  readonly #limit: number;
  readonly #held = new Map<string, Held>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  #state: TreeState | undefined;
  /**
   * The read in flight, which the next one runs behind, so a diff always
   * compares with the state that the last read left.
   */
  #reading: Promise<void> = Promise.resolve();
  /** The reads that wait behind the one in flight, by area. */
  readonly #waiting = new Map<string, Promise<void>>();
  #closed = false;

  constructor(options: Required<TreeOptions>) {
    this.#root = options.root;
    this.#onChange = options.onChange;
    this.#open = options.open;
    this.#read = options.read;
    this.#limit = options.limit;
  }

  rescan(): Promise<void> {
    return this.#queue(WHOLE_TREE);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const held of this.#held.values()) held.watcher?.close();
    this.#held.clear();
    await this.#reading;
  }

  /**
   * A read of an area that waits already is joined: it starts after the call,
   * so it reads what the call asks for. `#run` never rejects, so the chain
   * never breaks.
   */
  #queue(area: TreeArea): Promise<void> {
    const key = keyOf(area);
    const waiting = this.#waiting.get(key);
    if (waiting !== undefined) return waiting;
    const read = this.#reading.then(() => {
      this.#waiting.delete(key);
      return this.#run(area);
    });
    this.#waiting.set(key, read);
    this.#reading = read;
    return read;
  }

  async #run(area: TreeArea): Promise<void> {
    if (this.#closed) return;
    let next: TreeState;
    try {
      next = await this.#read(this.#root, area, this.#state);
    } catch {
      // The state stays as it was, and the next event or rescan reads again.
      return;
    }
    if (this.#closed) return;
    const last = this.#state;
    this.#state = next;
    if (last !== undefined) for (const change of diffTree(last, next)) this.#report(change);
    // A change made between the read and the new watch would be lost without
    // this read: the watch was not there to hear it.
    for (const fresh of coalesce(this.#follow(next))) await this.#run(fresh);
  }

  /**
   * Brings the watch set in line with the state, and answers the areas of the
   * folders that are new to it. A folder whose identity changed is watched
   * again, because a watch on a folder that someone deleted goes quiet with no
   * error. A watch that failed is taken again here, at each read.
   */
  #follow(state: TreeState): TreeArea[] {
    const wanted = new Map([...watchedFolders(this.#root, state)].slice(0, this.#limit));
    for (const [path, held] of this.#held) {
      if (wanted.has(path)) continue;
      held.watcher?.close();
      this.#held.delete(path);
    }
    const fresh: TreeArea[] = [];
    for (const [path, want] of wanted) {
      let held = this.#held.get(path);
      if (held === undefined) {
        held = { identity: want.identity, area: want.area, watcher: undefined };
        this.#held.set(path, held);
        fresh.push(want.area);
      } else if (held.identity !== want.identity) {
        held.watcher?.close();
        held.watcher = undefined;
        held.identity = want.identity;
      }
      held.area = want.area;
      held.watcher ??= this.#take(path, held);
    }
    return fresh;
  }

  /**
   * A watch that cannot be taken, or that fails later, is dropped; the next read
   * takes it again. On macOS, `fs.watch` on a FIFO never returns and stops the
   * thread, so the path is checked again here: the read that found a folder
   * there can be out of date.
   */
  #take(path: string, held: Held): FSWatcher | undefined {
    try {
      if (!statSync(path).isDirectory()) return undefined;
      const watcher = this.#open(path, () => this.#event(held.area));
      watcher.on("error", () => {
        watcher.close();
        if (held.watcher === watcher) held.watcher = undefined;
      });
      return watcher;
    } catch {
      return undefined;
    }
  }

  #event(area: TreeArea): void {
    if (this.#closed) return;
    const key = keyOf(area);
    clearTimeout(this.#timers.get(key));
    this.#timers.set(
      key,
      setTimeout(() => {
        this.#timers.delete(key);
        void this.#queue(area);
      }, DEBOUNCE_MS),
    );
  }

  #report(change: TreeChange): void {
    try {
      this.#onChange(change);
    } catch {
      // A listener that throws stops no later change.
    }
  }
}

type TreeOptions = {
  root: string;
  onChange: (change: TreeChange) => void;
  open?: WatchOpen;
  read?: ReadTree;
  limit?: number;
};

/**
 * `watchTree`, with the seams a test drives: `open` takes a watch, `read` reads
 * the tree, and `limit` is the most watches it takes.
 */
export async function openTree(options: TreeOptions): Promise<TreeWatch> {
  const tree = new Tree({
    root: options.root,
    onChange: options.onChange,
    open: options.open ?? watch,
    read: options.read ?? readTree,
    limit: options.limit ?? WATCH_LIMIT,
  });
  await tree.rescan();
  return tree;
}

/**
 * Reads the tree, takes the watches and answers with the watch. It never
 * rejects: a fault of a read becomes a mark, and a watch that cannot be taken
 * is taken again at the next read, while the caller's `rescan()` covers what it
 * misses.
 */
export function watchTree(options: {
  root?: string;
  onChange: (change: TreeChange) => void;
  open?: WatchOpen;
}): Promise<TreeWatch> {
  return openTree({ root: expandRoot(options.root), onChange: options.onChange, open: options.open });
}
