import type { StoreDiagnostic } from "../store/index.js";
import { discoverProjects } from "../store/projects.js";
import { openProject } from "../store/store.js";
import { staleStep } from "../store/workflow.js";
import { TaskIndex } from "./cache.js";
import type { IndexEntry } from "./types.js";

/**
 * One `step-stale` note for each task of one project that names `workflow` and
 * carries a step of `removed`. A task in a final status is not named.
 */
function removedStepNotesOfProject(
  entries: readonly IndexEntry[],
  finalStatuses: readonly string[],
  workflow: string,
  removed: readonly string[],
): StoreDiagnostic[] {
  const notes: StoreDiagnostic[] = [];
  for (const { id, path, frontmatter } of entries) {
    const { step, status } = frontmatter;
    if (frontmatter.workflow !== workflow || typeof step !== "string" || !removed.includes(step)) continue;
    if (finalStatuses.includes(status)) continue;
    notes.push({ code: "step-stale", message: staleStep(step, workflow, id), path });
  }
  return notes;
}

/**
 * One `step-stale` note for each task of the tree, in a status that is not
 * final, on a step an edit removed from its workflow.
 *
 * Each project is read once through an index that takes no watch, so the notes
 * leave nothing open. A project that cannot be read is passed over: the notes
 * are advisory.
 */
export async function removedStepNotesOfTree(
  workflow: string,
  removed: readonly string[],
  options: { root?: string },
): Promise<StoreDiagnostic[]> {
  if (removed.length === 0) return [];
  const notes: StoreDiagnostic[] = [];
  for (const tag of await discoverProjects(options.root)) {
    const project = openProject({ project: tag, root: options.root });
    const index = new TaskIndex(project.paths);
    try {
      const { config } = await project.config();
      await index.reconcile();
      notes.push(...removedStepNotesOfProject(index.query().entries, config.final_statuses, workflow, removed));
    } catch {
      continue;
    } finally {
      index.close();
    }
  }
  return notes;
}
