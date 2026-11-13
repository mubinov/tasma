// The install of a base workflow: the documents that ship in the daemon bundle
// and the shipped workflow.yml, written into the workflow folder.

import type { Stats } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { createWorkflowFolder, errnoOf, openWritableWorkflows, TaskStoreError } from "@tasma/engine";
import type { Success, WorkflowInstall } from "@tasma/protocol";

/** The text of each base file. Vite writes it into the bundle, so no run reads the base folder. */
const BASE_FILES = import.meta.glob<string>("../../base-workflows/**/*", { query: "?raw", import: "default", eager: true });

const WORKFLOW_FILE = "workflow.yml";

type BaseWorkflow = { definition: string; documents: [string, string][] };

/** The files of one base workflow by their path from its folder, with the text of its `workflow.yml` apart. */
function baseWorkflow(name: string, files: Record<string, string>): BaseWorkflow {
  const prefix = `../../base-workflows/${name}/`;
  const texts = new Map(Object.entries(files)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, text]) => [key.slice(prefix.length), text]));
  const definition = texts.get(WORKFLOW_FILE);

  if (definition === undefined) throw new TaskStoreError("workflow-unknown", `there is no base workflow "${name}"`);
  texts.delete(WORKFLOW_FILE);

  return { definition, documents: [...texts] };
}

/** What a look at one path found, where a name above it that holds no folder also means that nothing is there. */
async function found(look: Promise<Stats>): Promise<Stats | undefined> {
  try {
    return await look;
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/**
 * Writes the documents of one base workflow and its shipped `workflow.yml` into
 * the workflow folder. A workflow of this name, loading or not, answers `exists`
 * and changes nothing.
 */
export async function installBaseWorkflow(
  name: string,
  options: { root?: string; files?: Record<string, string> },
): Promise<Success<WorkflowInstall>> {
  const { definition, documents } = baseWorkflow(name, options.files ?? BASE_FILES);
  const workflows = await openWritableWorkflows(options.root);
  const paths = workflows.pathsOf(name);

  if ((await found(stat(paths.file)))?.isFile() === true) return { data: { result: "exists" }, diagnostics: [] };

  if ((await found(lstat(paths.directory))) !== undefined) {
    throw new TaskStoreError(
      "path-taken",
      `this folder holds no ${WORKFLOW_FILE}. Move or remove it, then install again`,
      paths.directory,
    );
  }

  const { diagnostics } = await createWorkflowFolder(workflows, name, { definition, files: documents });

  return { data: { result: "installed", folder: paths.directory }, diagnostics };
}
