import { dirname, isAbsolute, join, normalize } from "node:path";
import { Document, type Node, type YAMLMap } from "yaml";
import { isPlainMapping } from "../format/values.js";
import {
  createExclusive,
  createExclusiveDirectory,
  discard,
  discardDirectory,
  entryAt,
  makeDirectory,
  removeTree,
  replaceFile,
  syncDirectory,
} from "../store/atomic.js";
import { declaredWorkflows, readDeclared, resolveWorkflowsPath } from "../store/config.js";
import { applyWrites, checkAnchor, cleared, openDeclaration, storedValues } from "../store/declaration.js";
import { asStoreRefusal, errnoOf, fail } from "../store/errors.js";
import { checkedFilePath, expandRoot, projectPaths, userConfigPath } from "../store/paths.js";
import { discoverProjects } from "../store/projects.js";
import { openWorkflows, readWorkflowText, shapeWorkflow, WORKFLOW_FILE } from "./load.js";
import type {
  StepInput,
  StepOwner,
  Workflow,
  WorkflowChange,
  WorkflowInput,
  WorkflowPaths,
  WorkflowResult,
  Workflows,
  WorkflowUpdateResult,
} from "./types.js";

/** The keys a step entry of a write states. Every other key of an entry is kept from the file. */
const STEP_INPUT_KEYS = new Set(["name", "file", "owner"]);

function refuse(description: string): never {
  fail("workflow-change-invalid", description);
}

function checkedTitle(stated: unknown): string {
  if (typeof stated !== "string" || stated === "") refuse('"title" must be a string that is not empty');
  return stated;
}

function checkedInstructions(stated: unknown): string[] {
  if (!Array.isArray(stated)) refuse('"instructions" must be a list of strings');
  for (const entry of stated as unknown[]) {
    if (typeof entry !== "string" || entry === "") {
      refuse('every entry of "instructions" must be a string that is not empty');
    }
  }
  return stated as string[];
}

/**
 * The steps a write states, checked for type alone. The name rule, a duplicate
 * name and the owner values are the reader's rules, which the new text is held
 * to before it is written.
 */
function checkedSteps(stated: unknown): StepInput[] {
  if (!Array.isArray(stated)) refuse('"steps" must be a list of steps');
  if (stated.length === 0) refuse('"steps" must hold at least one entry');
  return (stated as unknown[]).map((entry) => {
    if (!isPlainMapping(entry)) refuse('every entry of "steps" must be a mapping');
    const unknown = Object.keys(entry).find((key) => !STEP_INPUT_KEYS.has(key));
    if (unknown !== undefined) refuse(`"${unknown}" is not a key of a step a write states`);
    const { name, file, owner } = entry;
    if (typeof name !== "string" || typeof owner !== "string" || typeof file !== "string" || file === "") {
      refuse('every entry of "steps" needs a "name", an "owner" and a "file" that are strings');
    }
    return { name, file, owner: owner as StepOwner };
  });
}

const VALUE_CHECKS: { [Key in keyof WorkflowChange]-?: (stated: unknown) => unknown } = {
  title: checkedTitle,
  instructions: checkedInstructions,
  steps: checkedSteps,
};

/**
 * The value each key of a write sets, `undefined` for a key it removes, in the
 * order the file states its keys when it is created.
 */
function checkedWrites(stated: unknown, clearable: boolean): Map<string, unknown> {
  if (!isPlainMapping(stated)) refuse("a workflow write must be a mapping");
  for (const key of Object.keys(stated)) {
    if (!Object.hasOwn(VALUE_CHECKS, key)) refuse(`"${key}" is not a field of a workflow a write sets`);
  }
  const writes = new Map<string, unknown>();
  for (const [key, check] of Object.entries(VALUE_CHECKS)) {
    if (!Object.hasOwn(stated, key)) continue;
    const value = stated[key];
    if (!cleared(value)) writes.set(key, check(value));
    else if (clearable && key !== "steps") writes.set(key, undefined);
    else refuse(`"${key}" cannot be cleared`);
  }
  return writes;
}

/** Refuses a step file or an instruction document that is not a regular file. The stated value is kept. */
async function checkDocuments(writes: Map<string, unknown>): Promise<void> {
  for (const step of (writes.get("steps") as StepInput[] | undefined) ?? []) {
    await checkedFilePath(step.file, `the file of the step "${step.name}"`);
  }
  for (const entry of (writes.get("instructions") as string[] | undefined) ?? []) {
    await checkedFilePath(entry, "an instruction document");
  }
}

/**
 * The kept keys of each step entry of a file, the keys beyond `name`, `file` and
 * `owner`, under the name of every step the file stores.
 */
function keptKeysByStep(doc: Document): Map<string, Record<string, unknown>> {
  const keptKeys = new Map<string, Record<string, unknown>>();
  const steps = storedValues(doc).steps;
  if (!Array.isArray(steps)) return keptKeys;
  for (const entry of steps as unknown[]) {
    if (!isPlainMapping(entry) || typeof entry.name !== "string") continue;
    keptKeys.set(entry.name, Object.fromEntries(Object.entries(entry).filter(([key]) => !STEP_INPUT_KEYS.has(key))));
  }
  return keptKeys;
}

/** The node of one step entry: a flow mapping of `name`, `file`, `owner`, then the kept keys. */
function stepNode(doc: Document, step: StepInput, keptKeys: Record<string, unknown> = {}): Node {
  const node: YAMLMap = doc.createNode({ name: step.name, file: step.file, owner: step.owner, ...keptKeys });
  node.flow = true;
  return node;
}

/** Replaces the stated steps of `writes` with the nodes the file stores. */
function withStepNodes(
  doc: Document,
  writes: Map<string, unknown>,
  keptKeys: Map<string, Record<string, unknown>>,
): void {
  const steps = writes.get("steps") as StepInput[] | undefined;
  if (steps !== undefined) writes.set("steps", steps.map((step) => stepNode(doc, step, keptKeys.get(step.name))));
}

/**
 * Refuses a text the reader would refuse, and returns the workflow the reader
 * shapes from it. The message is the reader's, under the code of a bad request:
 * the text is the input of the write.
 */
function checkShape(text: string, paths: WorkflowPaths, name: string): WorkflowResult {
  try {
    return shapeWorkflow(text, paths, name);
  } catch (error) {
    const fault = asStoreRefusal(error);
    fail("workflow-change-invalid", fault.description, paths.file, fault);
  }
}

/** Makes the directory of a new workflow. A directory that exists refuses the write. */
async function claimWorkflowDirectory(workflows: Workflows, paths: WorkflowPaths, name: string): Promise<void> {
  await makeDirectory(workflows.directory);
  try {
    await createExclusiveDirectory(paths.directory);
  } catch (error) {
    if (errnoOf(error) === "EEXIST") fail("workflow-exists", `the workflow "${name}" exists`, paths.directory);
    throw error;
  }
}

/**
 * Creates a workflow: its directory, and a `workflow.yml` that states `title`,
 * `instructions` and `steps` in that order. Every check runs before anything is
 * written, and a create that fails once the directory exists removes it while it
 * is still empty.
 */
export async function createWorkflow(
  workflows: Workflows,
  name: string,
  input: WorkflowInput,
): Promise<WorkflowResult> {
  const paths = workflows.pathsOf(name);
  const writes = checkedWrites(input, false);
  if (!writes.has("steps")) refuse('a workflow needs "steps"');
  await checkDocuments(writes);
  const doc = new Document({});
  withStepNodes(doc, writes, new Map());
  applyWrites(doc, writes);
  const text = doc.toString({ lineWidth: 0 });
  checkShape(text, paths, name);

  await claimWorkflowDirectory(workflows, paths, name);
  try {
    await createExclusive(paths.file, text);
  } catch (error) {
    await discardDirectory(paths.directory);
    throw error;
  }
  return workflows.read(name);
}

/** A relative path as the default macOS volume compares it: normalized, with no regard to case or Unicode form. */
function folded(path: string): string {
  return normalize(path).normalize("NFC").toLowerCase();
}

/**
 * Refuses a file path that leaves the workflow folder, names its `workflow.yml`,
 * or names the same entry as a different path, as the default macOS volume
 * compares them.
 */
function checkFolderPaths(filePaths: string[]): void {
  const files = new Map<string, string>();
  const folders = new Map<string, string>();
  for (const path of filePaths) {
    if (isAbsolute(path) || path.endsWith("/") || path.split("/").includes("..") || normalize(path) === ".") {
      refuse(`the file path "${path}" must name a file inside the workflow folder`);
    }
    const key = folded(path);
    if (key === WORKFLOW_FILE) refuse(`the file path "${path}" names the ${WORKFLOW_FILE} of the workflow folder`);
    const same = files.get(key);
    if (same !== undefined) refuse(`the file paths "${same}" and "${path}" name the same file`);
    files.set(key, path);
    for (let folder = dirname(normalize(path)); folder !== "."; folder = dirname(folder)) {
      const other = folders.get(folded(folder));
      if (other !== undefined && other !== folder) {
        refuse(`the folders "${other}" and "${folder}" differ only by case or Unicode form`);
      }
      folders.set(folded(folder), folder);
    }
  }
  for (const [key, path] of files) {
    if (folders.has(key)) refuse(`the file path "${path}" is also the folder of a different file`);
  }
}

/** Refuses a workflow that names a document its folder will not hold. */
function checkDocumentsInFolder(workflow: Workflow, directory: string, filePaths: string[]): void {
  const written = new Set(filePaths.map((path) => join(directory, path)));
  for (const document of [...workflow.instructions, ...workflow.steps.map((step) => step.file)]) {
    if (!written.has(document)) refuse(`the document "${document}" is not a file of the workflow folder`);
  }
}

/** What one run made, which is all that its cleanup can remove. Folders stand in the order they were made. */
type Made = { files: string[]; folders: string[] };

/** Makes `folder` and each folder above it that this run has not made, the highest first, and flushes each name. */
async function makeFolders(folder: string, made: Made): Promise<void> {
  if (made.folders.includes(folder)) return;
  await makeFolders(dirname(folder), made);
  await createExclusiveDirectory(folder);
  made.folders.push(folder);
  await syncDirectory(dirname(folder));
}

/** Removes what the run made, the deepest folder first. A folder that holds a file of a different writer stays. */
async function removeMade(made: Made): Promise<void> {
  for (const file of made.files) await discard(file);
  for (const folder of made.folders.toReversed()) await discardDirectory(folder);
}

/** `EEXIST` inside a new workflow folder: a different writer took a name in it. */
function refuseTaken(error: unknown, name: string, directory: string): never {
  if (errnoOf(error) === "EEXIST") {
    fail("workflow-exists", `a different writer wrote into the folder of the workflow "${name}"`, directory, error);
  }
  throw error;
}

/**
 * Whether a failed create left `workflow.yml`, which then names the files. A look
 * that fails counts as yes: files with no workflow make the next install refuse
 * and name the folder, but a workflow with no files loads with steps that cannot
 * be read.
 */
async function standsAfterFailure(file: string): Promise<boolean> {
  try {
    return (await entryAt(file))?.isFile() === true;
  } catch {
    return true;
  }
}

/**
 * Creates a workflow folder with its files, then its `workflow.yml` with
 * `definition` unchanged, so the paths it states stay relative to the folder.
 * Every check runs before anything is written. An exclusive create never
 * overwrites and never follows a link, and each file and folder is flushed
 * before the `workflow.yml` that names it. A failure before `workflow.yml`
 * stands removes what the run made.
 */
export async function createWorkflowFolder(
  workflows: Workflows,
  name: string,
  content: { definition: string; files: [string, string][] },
): Promise<WorkflowResult> {
  const paths = workflows.pathsOf(name);
  const { definition, files } = content;
  const filePaths = files.map(([path]) => path);
  checkFolderPaths(filePaths);
  checkDocumentsInFolder(checkShape(definition, paths, name).workflow, paths.directory, filePaths);

  await claimWorkflowDirectory(workflows, paths, name);
  const made: Made = { files: [], folders: [paths.directory] };
  try {
    await syncDirectory(workflows.directory);
    for (const [path, text] of files) {
      const file = join(paths.directory, path);
      await makeFolders(dirname(file), made);
      await createExclusive(file, text);
      made.files.push(file);
    }
  } catch (error) {
    await removeMade(made);
    refuseTaken(error, name, paths.directory);
  }

  try {
    await createExclusive(paths.file, definition);
  } catch (error) {
    if (errnoOf(error) === "EEXIST" || !(await standsAfterFailure(paths.file))) await removeMade(made);
    refuseTaken(error, name, paths.directory);
  }
  return workflows.read(name);
}

/**
 * Sets and removes the keys of one change, leaving every other key and every
 * comment of the file alone. A new `steps` list gives an entry the kept keys of
 * the old entry of the same name; a comment inside the old list is lost.
 */
export async function updateWorkflow(
  workflows: Workflows,
  name: string,
  change: WorkflowChange,
): Promise<WorkflowUpdateResult> {
  const paths = workflows.pathsOf(name);
  const writes = checkedWrites(change, true);
  await checkDocuments(writes);
  // The reader's refusal of a directory or a file that is not there.
  await readWorkflowText(paths, name);
  if (writes.size === 0) return { ...(await workflows.read(name)), removedSteps: [] };

  const doc = await openDeclaration(paths.file, { code: "workflow-invalid", required: true });
  const keptKeys = keptKeysByStep(doc);
  const steps = writes.get("steps") as StepInput[] | undefined;
  withStepNodes(doc, writes, keptKeys);
  for (const [key, value] of writes) checkAnchor(doc, key, value === undefined, paths.file, "workflow-invalid");
  applyWrites(doc, writes);
  const text = doc.toString({ lineWidth: 0 });
  checkShape(text, paths, name);
  await replaceFile(paths.file, text);

  const statedNames = new Set(steps?.map((step) => step.name));
  const removedSteps = steps === undefined ? [] : [...keptKeys.keys()].filter((step) => !statedNames.has(step));
  return { ...(await workflows.read(name)), removedSteps };
}

/**
 * The projects of a tree that list one workflow, and those whose file cannot be
 * read, which may list it.
 */
async function projectsListing(
  root: string | undefined,
  name: string,
): Promise<{ listing: string[]; unread: string[] }> {
  const listing: string[] = [];
  const unread: string[] = [];
  for (const tag of await discoverProjects(root)) {
    try {
      const level = await readDeclared(projectPaths({ project: tag, root }).projectConfig, "project", [], true);
      if (declaredWorkflows(level).includes(name)) listing.push(tag);
    } catch {
      // Any fault counts: the delete cannot prove that this project does not
      // list the workflow. An absent file counts too: every project stores one,
      // and a rename moves the old directory away after the new one is published.
      unread.push(tag);
    }
  }
  return { listing, unread };
}

/** `the project A` or `the projects A, B`. */
function projectsText(tags: string[]): string {
  return `${tags.length === 1 ? "the project" : "the projects"} ${tags.join(", ")}`;
}

/**
 * The workflows of one tree for a write. A user file that cannot be resolved
 * refuses the write rather than falling back to the built-in directory, which
 * the user did not choose, the rule `checkDeclaredWorkflows` states.
 */
export async function openWritableWorkflows(root?: string): Promise<Workflows> {
  const expanded = expandRoot(root);
  return openWorkflows({ root: expanded, path: await resolveWorkflowsPath(userConfigPath(expanded), []) });
}

/**
 * Removes a workflow directory and everything in it. A directory with no regular
 * `workflow.yml` is refused: it is no workflow, and `workflows_path` can name a
 * directory that holds other data. A workflow a project lists is refused, and so
 * is one where a project file cannot be read. Tasks are not checked: a task that
 * names a removed workflow reads with `workflow-missing`. A linked directory
 * loses the link alone.
 */
export async function removeWorkflow(name: string, options: { root?: string }): Promise<void> {
  const paths = (await openWritableWorkflows(options.root)).pathsOf(name);
  await readWorkflowText(paths, name);
  const { listing, unread } = await projectsListing(options.root, name);
  if (listing.length > 0) {
    fail("workflow-in-use", `the workflow "${name}" is listed by ${projectsText(listing)}`, paths.directory);
  }
  if (unread.length > 0) {
    const description = `the configuration of ${projectsText(unread)} cannot be read, so it may list the workflow "${name}"`;
    fail("workflow-in-use", description, paths.directory);
  }
  await removeTree(paths.directory);
}
