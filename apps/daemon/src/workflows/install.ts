// The install of a base workflow: the documents that ship in the daemon bundle,
// copied to a folder of the user, and a workflow created over the copies.

import type { Stats } from "node:fs";
import { lstat, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  createExclusive,
  createExclusiveDirectory,
  createWorkflow,
  errnoOf,
  expandRoot,
  openWritableWorkflows,
  sameNode,
  shapeWorkflow,
  syncDirectory,
  TaskStoreError,
} from "@tasma/engine";
import type { Workflow, WorkflowInput } from "@tasma/engine";
import type { Success, WorkflowInstall } from "@tasma/protocol";

/** The text of each base file. Vite writes it into the bundle, so no run reads the base folder. */
const BASE_FILES = import.meta.glob<string>("../../base-workflows/**/*", { query: "?raw", import: "default", eager: true });

const WORKFLOW_FILE = "workflow.yml";

/** Where the documents go when `workflows_path` stands in the tree: beside the tree, under this name. */
const DOCUMENTS_FOLDER = "tasma-workflows";

/** What one run made, which is all that its cleanup can remove. Folders stand in the order they were made. */
type Made = { files: string[]; folders: string[] };

type BaseWorkflow = { definition: string; documents: [string, string][] };

function refuseOccupied(target: string): never {
  throw new TaskStoreError(
    "path-taken",
    "the documents of this workflow go in this path, and it is not free. It must not exist, or it must be an empty "
    + "folder of this account. Use a different workflows_path, or move what this path holds, then install again",
    target,
  );
}

function refuseWorkflowsPath(target: string): never {
  throw new TaskStoreError(
    "path-taken",
    "this folder is workflows_path, so it cannot hold the documents. Change workflows_path, then install again",
    target,
  );
}

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

/** A path as the default macOS volume compares it: with no regard to case or Unicode form. */
function folded(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/** The folder of the documents, which is never under the tree. */
function targetOf(name: string, root: string, workflowsDirectory: string): string {
  const parent = dirname(workflowsDirectory);
  const fromRoot = relative(folded(root), folded(parent));
  const insideRoot = fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);

  return insideRoot ? join(dirname(root), DOCUMENTS_FOLDER, name) : join(parent, name);
}

/**
 * Refuses a target that cannot hold the documents, and answers whether it has to
 * be made: `true` when nothing is there, `false` for an empty folder of this
 * account. The owner of a link or of a folder of a different account can replace
 * a step document after the install, so both refuse.
 */
async function checkTarget(target: string, workflowsDirectory: string): Promise<boolean> {
  if (folded(target) === folded(workflowsDirectory)) refuseWorkflowsPath(target);

  let entry;

  try {
    entry = await lstat(target);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return true;
    if (errnoOf(error) === "ENOTDIR") refuseOccupied(target);
    throw error;
  }

  // A `workflows_path` that is a link to the target has a different name for the same folder.
  const workflowsEntry = await found(stat(workflowsDirectory));

  if (workflowsEntry !== undefined && sameNode(entry, workflowsEntry)) refuseWorkflowsPath(target);

  // The owner comes first: `readdir` of a folder of a different account can fail with `EACCES`.
  const free = entry.isDirectory() && entry.uid === process.getuid?.() && (await readdir(target)).length === 0;

  if (!free) refuseOccupied(target);

  return false;
}

/** Makes one folder and flushes its name. `EEXIST` reaches the caller: a different writer took the name. */
async function makeFolder(folder: string, made: Made): Promise<void> {
  await createExclusiveDirectory(folder);
  made.folders.push(folder);
  await syncDirectory(dirname(folder));
}

/** Makes a folder above the target, or uses the one that exists. */
async function useFolder(folder: string, made: Made): Promise<void> {
  try {
    await makeFolder(folder, made);
  } catch (error) {
    if (errnoOf(error) !== "EEXIST") throw error;
  }
}

/** Makes a folder above the target and each missing folder above it. */
async function makeAbove(folder: string, made: Made): Promise<void> {
  try {
    await useFolder(folder, made);
  } catch (error) {
    if (errnoOf(error) !== "ENOENT") throw error;

    await makeAbove(dirname(folder), made);
    // One more try only: under a link to nothing, each try answers `ENOENT`.
    await useFolder(folder, made);
  }
}

/** Makes a folder under the target and each folder between. */
async function makeInside(folder: string, target: string, made: Made): Promise<void> {
  if (folder === target || made.folders.includes(folder)) return;

  await makeInside(dirname(folder), target, made);
  await makeFolder(folder, made);
}

/** Removes what the run made, the deepest folder first. A folder that holds a file of someone else stays. */
async function removeMade(made: Made): Promise<void> {
  // A fault here must not replace the failure that led here.
  const passOver = () => undefined;

  for (const file of made.files) await unlink(file).catch(passOver);
  for (const folder of made.folders.toReversed()) await rmdir(folder).catch(passOver);
}

/**
 * Writes each document, flushed before the create that names it: `exists` repairs
 * nothing. An exclusive create never overwrites a file and never follows a link.
 * A failure removes what the copy made.
 */
async function copyDocuments(documents: [string, string][], target: string, mustMake: boolean): Promise<Made> {
  const made: Made = { files: [], folders: [] };

  try {
    if (mustMake) {
      await makeAbove(dirname(target), made);
      await makeFolder(target, made);
    }

    for (const [path, text] of documents) {
      const file = join(target, path);

      await makeInside(dirname(file), target, made);
      await createExclusive(file, text);
      made.files.push(file);
    }

    return made;
  } catch (error) {
    await removeMade(made);
    if (errnoOf(error) === "EEXIST") refuseOccupied(target);
    throw error;
  }
}

/**
 * Whether a failed create left its `workflow.yml`, which then names the copies:
 * the read that ends the create can fail after the write. A look that fails counts
 * as yes, because copies with no workflow refuse the next install and name the
 * folder, but a workflow with no copies answers `exists`.
 */
async function createLeftFile(error: unknown, file: string): Promise<boolean> {
  // A different writer holds the name, and its file names its own documents.
  if (errnoOf(error) === "EEXIST" || (error instanceof TaskStoreError && error.code === "workflow-exists")) return false;

  try {
    return (await found(stat(file)))?.isFile() === true;
  } catch {
    return true;
  }
}

/** What a create states: only the keys that `workflow.yml` states. `createWorkflow` refuses `title: undefined`. */
function inputOf({ title, instructions, steps }: Workflow): WorkflowInput {
  return {
    ...(title === undefined ? {} : { title }),
    ...(instructions.length === 0 ? {} : { instructions }),
    steps: steps.map(({ name, owner, file }) => ({ name, owner, file })),
  };
}

/**
 * Copies the documents of one base workflow and creates the workflow over the
 * copies. A workflow of this name, loading or not, answers `exists` and changes
 * nothing. A failure before `workflow.yml` stands removes what the run made.
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

  const target = targetOf(name, expandRoot(options.root), workflows.directory);
  const mustMake = await checkTarget(target, workflows.directory);
  const { workflow } = shapeWorkflow(definition, { directory: target, file: join(target, WORKFLOW_FILE) }, name);
  const made = await copyDocuments(documents, target, mustMake);

  try {
    const { diagnostics } = await createWorkflow(workflows, name, inputOf(workflow));
    return { data: { result: "installed", folder: target }, diagnostics };
  } catch (error) {
    if (!(await createLeftFile(error, paths.file))) await removeMade(made);
    throw error;
  }
}
