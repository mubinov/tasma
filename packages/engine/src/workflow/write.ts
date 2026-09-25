import { Document, type Node, type YAMLMap } from "yaml";
import { isPlainMapping } from "../format/values.js";
import {
  createExclusive,
  createExclusiveDirectory,
  discardDirectory,
  makeDirectory,
  removeTree,
  replaceFile,
} from "../store/atomic.js";
import { declaredWorkflows, readDeclared, resolveWorkflowsPath } from "../store/config.js";
import { applyWrites, checkAnchor, cleared, openDeclaration, storedValues } from "../store/declaration.js";
import { asStoreRefusal, errnoOf, fail } from "../store/errors.js";
import { checkedFilePath, expandRoot, projectPaths, userConfigPath } from "../store/paths.js";
import { discoverProjects } from "../store/projects.js";
import { openWorkflows, readWorkflowText, shapeWorkflow } from "./load.js";
import type {
  StepInput,
  StepOwner,
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
 * Refuses a text the reader would refuse. The message is the reader's, under
 * the code of a bad request: the text is the one this write built.
 */
function checkShape(text: string, paths: WorkflowPaths, name: string): void {
  try {
    shapeWorkflow(text, paths, name);
  } catch (error) {
    const fault = asStoreRefusal(error);
    fail("workflow-change-invalid", fault.description, paths.file, fault);
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

  await makeDirectory(workflows.directory);
  try {
    await createExclusiveDirectory(paths.directory);
  } catch (error) {
    if (errnoOf(error) === "EEXIST") fail("workflow-exists", `the workflow "${name}" exists`, paths.directory);
    throw error;
  }
  try {
    await createExclusive(paths.file, text);
  } catch (error) {
    await discardDirectory(paths.directory);
    throw error;
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
