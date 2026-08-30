import type { IndexedProject, IndexOptions, Project, QueryResult, StoreDiagnostic } from "@tasma/engine";
import type { ChunkSource } from "../../src/index-cache/frontmatter.js";
import { openIndexed } from "../../src/index-cache/project.js";
import { type TaskEntry, taskNumber } from "../../src/store/paths.js";
import { PROJECT, taskFile } from "../store/helpers.js";

/** The byte-order mark an editor may put in front of a file it writes as UTF-8. */
export const BOM = "\uFEFF";

/** A source over text in fixed-size chunks, recording what a read asked of it. */
export type Source = ChunkSource & { requested: number; closed: number };

export function chunks(text: string, size = 16): Source {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  const source: Source = {
    requested: 0,
    closed: 0,
    async next() {
      const chunk = bytes.subarray(at, at + size);
      at += chunk.length;
      source.requested += chunk.length;
      return chunk;
    },
    async close() {
      source.closed += 1;
    },
  };
  return source;
}

/** The ids an index answers with, in the order it answers them. */
export function ids(source: { query(): QueryResult }): string[] {
  return source.query().entries.map((entry) => entry.id);
}

/** The file of one task as the index applies it. */
export function taskEntry(root: string, id: string): TaskEntry {
  return { id, number: taskNumber(PROJECT, `${id}.md`) ?? 0, path: taskFile(root, id) };
}

/** A listener that keeps every diagnostic the index hands it. */
export function listener(): { seen: StoreDiagnostic[]; on: (diagnostic: StoreDiagnostic) => void; codes(): string[] } {
  const seen: StoreDiagnostic[] = [];
  return {
    seen,
    on: (diagnostic) => void seen.push(diagnostic),
    codes: () => seen.map((diagnostic) => diagnostic.code),
  };
}

/**
 * Waits until the expectation holds, so a test never waits a fixed interval.
 *
 * `change` is the change the expectation waits on, and it is made again every so
 * often while the wait runs. A watch of the operating system can drop the first
 * changes that follow it, and under load it drops them for seconds, so repeating
 * the change keeps the test about the event that arrives rather than about the
 * moment the watch became live. The tests that depend on a live watch are run
 * again on a failure for the same reason.
 */
export async function until(holds: () => boolean, what: string, change?: () => Promise<unknown>): Promise<void> {
  const timeout = 5000;
  const deadline = Date.now() + timeout;
  let again = 0;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeout} ms`);
    if (change !== undefined && Date.now() >= again) {
      again = Date.now() + 250;
      await change();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * An indexed project whose watcher is never established, so a test proves the
 * write path and `rescan()` on their own rather than on an event that may or may
 * not have arrived.
 */
export function unwatched(project: Project, options: IndexOptions = {}): Promise<IndexedProject> {
  return openIndexed(project, options, () => ({
    ensure: async () => {},
    close: async () => {},
  }));
}
