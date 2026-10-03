// The text query of a task listing. The index holds the front matter alone, so
// a search reads each task the other filters kept in full.

import { TaskParseError, TaskStoreError } from "@tasma/engine";
import type { IndexedProject, ListedEntry, Task } from "@tasma/engine";

/**
 * How many tasks one search reads at a time. Each read holds a descriptor, so
 * an unbounded search over a large project would reach the process limit.
 */
const READ_LIMIT = 8;

export function words(q: string | undefined): string[] {
  if (q === undefined) return [];
  return q.toLowerCase().split(/\s+/).filter((word) => word !== "");
}

/**
 * The text a query searches, one field per line. A word holds no whitespace,
 * so no word matches across two fields.
 */
function searchable(task: Task): string {
  const fields = [task.frontmatter.id, task.frontmatter.title, task.body];
  for (const comment of task.comments) fields.push(comment.title, comment.body);
  return fields.join("\n").toLowerCase();
}

/** Whether a failed read is the fault of the one task file, not of the project or the code. */
function isFileFault(error: unknown): boolean {
  if (error instanceof TaskParseError) return true;
  if (error instanceof TaskStoreError) return error.code === "task-not-found" || error.code === "id-mismatch";
  return error instanceof Error && "syscall" in error;
}

async function holdsEvery(
  project: Pick<IndexedProject, "readTask">,
  entry: ListedEntry,
  terms: readonly string[],
): Promise<boolean> {
  try {
    const text = searchable((await project.readTask(entry.id)).task);
    return terms.every((term) => text.includes(term));
  } catch (error) {
    if (isFileFault(error)) return false;
    throw error;
  }
}

/**
 * The entries whose task holds every word, in the order they were given. The
 * workers share one iterator, so what is in flight is bounded by how many of
 * them there are, and each writes its answer under the position it took.
 */
export async function searchEntries(
  project: Pick<IndexedProject, "readTask">,
  entries: readonly ListedEntry[],
  terms: readonly string[],
): Promise<ListedEntry[]> {
  const kept: boolean[] = [];
  const pending = entries.entries();
  const workers = Array.from({ length: READ_LIMIT }, async () => {
    for (const [at, entry] of pending) kept[at] = await holdsEvery(project, entry, terms);
  });
  await Promise.all(workers);
  return entries.filter((_entry, at) => kept[at]);
}
