import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { WRITABLE } from "../format/schema.js";
import { isPlainMapping, isStringList } from "../format/values.js";
import { readRegularFile } from "../store/atomic.js";
import { causeOf, errnoOf, fail } from "../store/errors.js";
import { expandRoot, resolveAgainst } from "../store/paths.js";
import type { StoreDiagnostic } from "../store/types.js";
import type {
  InstructionDocument,
  Workflow,
  WorkflowList,
  WorkflowPaths,
  WorkflowResult,
  Workflows,
  WorkflowStep,
  WorkflowStepResult,
} from "./types.js";

/** The one file a workflow directory must hold. */
const WORKFLOW_FILE = "workflow.yml";

/**
 * The form of a workflow name. It is narrower than the form of a step name: the
 * name becomes a directory name, so this is a safety rule. It carries no dot and
 * no path separator, and cannot be `.` or `..`, which is what keeps a workflow
 * inside the workflows directory — without it a task carrying
 * `workflow: ../../../Documents` would make a read parse a file outside the
 * tree.
 */
const WORKFLOW_NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

/**
 * The longest a workflow name may be. The name becomes one path component, and a
 * longer one leaves the filesystem reporting `ENAMETOOLONG` from a call this
 * layer would otherwise have to give a meaning; bounding the form rule keeps
 * that answer where every other bad name is answered.
 */
const WORKFLOW_NAME_LIMIT = 255;

/**
 * The form of a step name. The colon a flow puts in front of a step is part of
 * the name: `dev:research` is one opaque string, and this format does not split
 * it, name its parts or define a role.
 */
const STEP_NAME = /^[a-z0-9](?:[a-z0-9:_-]*[a-z0-9])?$/;

/** The top-level keys of a workflow file. A key outside the set is reported and not read. */
const WORKFLOW_KEYS = new Set(["title", "steps", "instructions", "transitions"]);

const WORKFLOW_NAME_EXPECTATION
  = `must be 1 to ${WORKFLOW_NAME_LIMIT} characters from "a-z", "0-9", "-" and "_", `
    + "and start and end with a letter or a digit";

const STEP_NAME_EXPECTATION
  = 'must be one or more characters from "a-z", "0-9", "-", "_" and ":", '
    + "and start and end with a letter or a digit";

/** What keeps a string from being a workflow name, or `undefined` when it is one. */
function workflowNameFault(name: string): string | undefined {
  const holds = name.length <= WORKFLOW_NAME_LIMIT && WORKFLOW_NAME.test(name);
  return holds ? undefined : WORKFLOW_NAME_EXPECTATION;
}

/**
 * The directory the workflows of one tree stand in: the one configuration named,
 * else the built-in place beside `projects/`.
 */
function workflowsPath(root: string | undefined, path: string | undefined): string {
  return path ?? join(expandRoot(root), "workflows");
}

/**
 * Why the workflows directory cannot be used, from the fault reading it raised.
 * One code carries all three, the way `workflow-missing` carries the two reasons
 * a directory holds no workflow: what a caller does next is the same.
 */
function unusableReason(error: unknown): string {
  const code = errnoOf(error);
  if (code === "ENOENT") return "there is no directory under this name";
  if (code === "ENOTDIR") return "this name holds no directory";
  return `this workflows directory cannot be read: ${causeOf(error)}`;
}

/**
 * What one name holds with symbolic links followed, or `undefined` when this
 * loader cannot see a workflow under it. A workflow file is one the user places
 * and this engine never writes, so a link is followed here on the same reasoning
 * `config.ts` states for its own files.
 *
 * A fault of any kind answers `undefined` rather than reaching the caller: this
 * asks one question — does this name hold a directory, does it hold a file — and
 * a name it cannot reach holds neither. The caller turns that into
 * `workflow-unknown` or into the `workflow-missing` diagnostic, which is what
 * keeps a listing from failing because one workflow of many is broken.
 */
async function entryThrough(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

/** Whether one step entry of a loaded workflow carries this name. */
export function declaresStep(workflow: Workflow, step: string): boolean {
  return workflow.steps.some((entry) => entry.name === step);
}

/** The one wording every path refuses a step its workflow does not declare with. */
export function noSuchStep(workflow: string, step: string): string {
  return `the workflow "${workflow}" declares no step "${step}"`;
}

/**
 * The entry one workflow declares under a step name. A name it declares nothing
 * under has no answer, so the call is refused rather than answered with an empty
 * value, and the fault names the file that would have to declare it.
 */
export function stepEntry(workflow: Workflow, step: string, file: string): WorkflowStep {
  const entry = workflow.steps.find((declared) => declared.name === step);
  if (entry === undefined) fail("step-unknown", noSuchStep(workflow.name, step), file);
  return entry;
}

/** The `steps` list as this format requires it, in the order the file declares. */
function readSteps(content: Record<string, unknown>, directory: string, file: string): WorkflowStep[] {
  const declared = content.steps;
  if (!Array.isArray(declared)) fail("workflow-invalid", '"steps" must be a list of mappings', file);
  if (declared.length === 0) fail("workflow-invalid", '"steps" must hold at least one entry', file);
  const steps: WorkflowStep[] = [];
  const seen = new Set<string>();
  for (const entry of declared as unknown[]) {
    if (!isPlainMapping(entry)) fail("workflow-invalid", 'every entry of "steps" must be a mapping', file);
    const name = entry.name;
    if (typeof name !== "string") fail("workflow-invalid", 'every entry of "steps" needs a "name" that is a string', file);
    if (!STEP_NAME.test(name)) fail("workflow-invalid", `the step name "${name}" ${STEP_NAME_EXPECTATION}`, file);
    if (seen.has(name)) fail("workflow-invalid", `the step name "${name}" is declared more than once`, file);
    const stated = entry.file;
    if (typeof stated !== "string") fail("workflow-invalid", `the step "${name}" needs a "file" that is a string`, file);
    seen.add(name);
    const step: WorkflowStep = { name, file: resolveAgainst(directory, stated) };
    // A key this format does not define survives the load, under a name of its
    // own rather than beside the two the format checks.
    const custom = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "name" && key !== "file"));
    if (Object.keys(custom).length > 0) step.custom = custom;
    steps.push(step);
  }
  return steps;
}

/** The `instructions` list of a workflow, as paths resolved against its directory. */
function readInstructionPaths(value: unknown, base: string, file: string): string[] {
  if (value === undefined || value === null) return [];
  if (!isStringList(value)) fail("workflow-invalid", '"instructions" must be a list of strings', file);
  return value.map((entry) => resolveAgainst(base, entry));
}

/**
 * The text of the file one workflow is declared in. A directory that does not
 * exist is no workflow at all; a directory that exists and holds no file this
 * loader accepts is a workflow that is broken, which is a different thing to
 * report and a different thing to fix.
 */
async function readWorkflowText(paths: WorkflowPaths, name: string): Promise<string> {
  const { directory, file } = paths;
  let read;
  try {
    read = await readRegularFile(file, true);
  } catch (error) {
    // A name above the file that holds no directory reads as a workflow that
    // is not there, which the check below then names. Every other fault of the
    // filesystem is a workflow that cannot be loaded and is reported as one: a
    // bare errno reaching a caller would refuse a read the contract says must
    // report.
    if (errnoOf(error) !== "ENOTDIR") {
      fail("workflow-invalid", `this workflow cannot be read: ${causeOf(error)}`, file, error);
    }
    read = "absent" as const;
  }
  if (typeof read === "string") {
    if (read === "absent" && (await entryThrough(directory))?.isDirectory() !== true) {
      fail("workflow-unknown", `there is no directory for the workflow "${name}"`, directory);
    }
    const reason = read === "absent" ? `this workflow holds no ${WORKFLOW_FILE}` : "this name holds no regular file";
    fail("workflow-invalid", reason, file);
  }
  return read.text;
}

/** The workflow one directory holds, parsed and shaped from the text of its file. */
async function loadWorkflow(paths: WorkflowPaths, name: string): Promise<WorkflowResult> {
  const { directory, file } = paths;
  const text = await readWorkflowText(paths, name);

  let content: unknown;
  try {
    content = parse(text);
  } catch (error) {
    // The position alone, never the message of the parser: `yaml` appends a
    // frame of the source lines it failed on, and this read follows a link
    // anywhere. A fault it reports no position for leaves the file name alone.
    const at = (error as { linePos?: { line: number }[] }).linePos?.[0];
    fail("workflow-invalid", `the file is not valid YAML${at === undefined ? "" : ` at line ${at.line}`}`, file);
  }
  // A plain mapping, not merely an object: a YAML tag resolves to a `Set`, a
  // `Map` or a `Date`, none of which reports its content as entries.
  if (!isPlainMapping(content)) fail("workflow-invalid", "the file must hold a YAML mapping", file);
  // `transitions` is handed to another component exactly as `custom` is, so the
  // whole file takes the same walk a task region takes.
  if (!WRITABLE.holds(content)) fail("workflow-invalid", `the file ${WRITABLE.expectation}`, file);

  const diagnostics: StoreDiagnostic[] = [];
  for (const key of Object.keys(content)) {
    if (WORKFLOW_KEYS.has(key)) continue;
    diagnostics.push({
      code: "workflow-key-unknown",
      message: `"${key}" is not a workflow key this engine knows, so its value is not read`,
      path: file,
    });
  }

  const title = content.title;
  if (title !== undefined && title !== null && typeof title !== "string") {
    fail("workflow-invalid", '"title" must be a string', file);
  }
  const workflow: Workflow = {
    name,
    title: typeof title === "string" ? title : undefined,
    steps: readSteps(content, directory, file),
    instructions: readInstructionPaths(content.instructions, directory, file),
    transitions: content.transitions,
  };
  return { workflow, diagnostics };
}

/**
 * The text of one step definition. It is the thing the caller asked for, so a
 * file that is missing or unreadable refuses the call rather than reporting.
 */
export async function readStepDocument(path: string): Promise<InstructionDocument> {
  let read;
  try {
    read = await readRegularFile(path, true);
  } catch (error) {
    fail("step-file-unreadable", `this file cannot be read: ${causeOf(error)}`, path, error);
  }
  if (read === "absent") fail("step-file-unreadable", "there is no file under this name", path);
  if (read === "irregular") fail("step-file-unreadable", "this name holds no regular file", path);
  return { path, text: read.text };
}

/**
 * The documents of one `instructions` list. A list is several documents, so one
 * entry that cannot be read is a diagnostic naming that path and the rest are
 * still returned.
 */
export async function readInstructions(
  paths: readonly string[],
  diagnostics: StoreDiagnostic[],
): Promise<InstructionDocument[]> {
  const documents: InstructionDocument[] = [];
  for (const path of paths) {
    let read;
    try {
      read = await readRegularFile(path, true);
    } catch (error) {
      diagnostics.push({
        code: "instruction-file-unreadable",
        message: `this file cannot be read: ${causeOf(error)}`,
        path,
      });
      continue;
    }
    if (typeof read === "string") {
      const reason = read === "absent" ? "there is no file under this name" : "this name holds no regular file";
      diagnostics.push({ code: "instruction-file-unreadable", message: reason, path });
      continue;
    }
    documents.push({ path, text: read.text });
  }
  return documents;
}

class WorkflowStore implements Workflows {
  readonly directory: string;
  /**
   * Whether configuration named the directory or it is the built-in default.
   * `list()` alone acts on it, so it stays private: a tree that is not there is
   * an empty list where the engine chose the place and a finding where the user
   * did.
   */
  readonly #configured: boolean;

  constructor(directory: string, configured: boolean) {
    this.directory = directory;
    this.#configured = configured;
  }

  pathsOf(name: string): WorkflowPaths {
    const fault = workflowNameFault(name);
    // The check stands here rather than in each caller, because this is the one
    // place a name becomes a path: a name of another form would name a directory
    // outside the tree this handle stands on.
    if (fault !== undefined) fail("workflow-unknown", `the workflow name "${name}" ${fault}`, this.directory);
    const directory = join(this.directory, name);
    return { directory, file: join(directory, WORKFLOW_FILE) };
  }

  async list(): Promise<WorkflowList> {
    const names: string[] = [];
    const diagnostics: StoreDiagnostic[] = [];
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      // The one silent case is the built-in default that does not exist: a tree
      // the engine placed and nobody created holds no workflow, the way a
      // missing `tasks/` directory is a project that holds no task. A directory
      // the user named is reported when it is not there, because the user wrote
      // the name and a listing that answers nothing says why.
      if (errnoOf(error) === "ENOENT" && !this.#configured) return { names, diagnostics };
      diagnostics.push({ code: "workflows-path-unusable", message: unusableReason(error), path: this.directory });
      return { names, diagnostics };
    }
    for (const entry of entries) {
      const path = join(this.directory, entry.name);
      const directory = entry.isDirectory() || (entry.isSymbolicLink() && (await entryThrough(path))?.isDirectory());
      // A name of any other form holds no workflow and is passed over.
      if (directory !== true) continue;
      if (workflowNameFault(entry.name) !== undefined) {
        diagnostics.push({
          code: "workflow-missing",
          message: `the name of this directory is no workflow name, which ${WORKFLOW_NAME_EXPECTATION}`,
          path,
        });
        continue;
      }
      // The file is not opened: a listing reports which workflows exist, and a
      // workflow that does not load still exists.
      if ((await entryThrough(join(path, WORKFLOW_FILE)))?.isFile() !== true) {
        diagnostics.push({ code: "workflow-missing", message: `this directory holds no ${WORKFLOW_FILE}`, path });
        continue;
      }
      names.push(entry.name);
    }
    // The order of a directory read is not defined, and this answer is a list.
    names.sort();
    return { names, diagnostics };
  }

  async read(name: string): Promise<WorkflowResult> {
    return loadWorkflow(this.pathsOf(name), name);
  }

  async readStep(name: string, step: string): Promise<WorkflowStepResult> {
    const { workflow, diagnostics } = await this.read(name);
    const entry = stepEntry(workflow, step, this.pathsOf(name).file);
    return { step: entry, document: await readStepDocument(entry.file), diagnostics };
  }
}

/**
 * A handle on the workflows of one tree. The call performs no I/O: it expands
 * the root and returns a handle, the same shape as `openProject`, so a test —
 * and later a daemon — runs against another tree with no environment override.
 *
 * `path` is the directory `workflows_path` resolved to, absent when no
 * configuration file named one. It is the resolved absolute path: this layer
 * holds no configuration file, so it expands nothing.
 *
 * Nothing is cached between calls. A workflow is read when a call needs it, and
 * a hand edit would leave a cached list stale with nothing to invalidate it.
 */
export function openWorkflows(options: { root?: string; path?: string }): Workflows {
  return new WorkflowStore(workflowsPath(options.root, options.path), options.path !== undefined);
}
