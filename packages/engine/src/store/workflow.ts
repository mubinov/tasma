import type { Frontmatter } from "../format/index.js";
import type { InstructionDocument, Workflow, Workflows } from "../workflow/index.js";
import { declaresStep, noSuchStep, readInstructions, readStepDocument, stepEntry } from "../workflow/load.js";
import { causeOf, fail, TaskStoreError } from "./errors.js";
import type { ResolvedConfig, StoreDiagnostic } from "./types.js";

/**
 * Everything one write validation reads. It stands as one value because the two
 * checks below run on the same subject: threading each field down as a parameter
 * of its own said nothing and made every call site restate the whole state.
 */
export type WriteContext = {
  workflows: Workflows;
  config: ResolvedConfig;
  /** The frontmatter with the change applied, which is the effective state the checks run on. */
  frontmatter: Record<string, unknown>;
  /** The keys the change states, which is a narrower set than the frontmatter holds. */
  keys: Set<string>;
  path: string;
  diagnostics: StoreDiagnostic[];
};

/**
 * The one wording a stale step is reported with, from the write path and the
 * read path alike. It names the task once: the diagnostic already carries the
 * path of the file, so a second mention of its subject says nothing.
 */
function staleStep(step: string, workflow: Workflow | undefined): string {
  const carries = `this task carries the step "${step}"`;
  return workflow === undefined
    ? `${carries} and names no workflow`
    : `${carries}, which the workflow "${workflow.name}" does not declare`;
}

/**
 * The workflow a value names, checked against the list the project declares. A
 * name of another form, a name the project declares no workflow under and a
 * directory that is missing are one code: the caller's next move is the same,
 * and the message says which it was. A project that declares no `workflows` key
 * declares an empty list, so no task in it may name a workflow — which is what
 * makes the key catch a typo instead of recording one.
 */
export async function readDeclaredWorkflow(
  workflows: Workflows,
  declared: string[],
  name: string,
  diagnostics: StoreDiagnostic[],
): Promise<Workflow> {
  // The name is checked before the declared list, because `pathsOf` refuses a
  // name that is no workflow name and the fault below names the directory it
  // returns.
  const paths = workflows.pathsOf(name);
  if (!declared.includes(name)) {
    fail("workflow-unknown", `this project declares no workflow "${name}"`, paths.directory);
  }
  const read = await workflows.read(name);
  diagnostics.push(...read.diagnostics);
  return read.workflow;
}

/**
 * Checks `workflow` and `step` against the effective workflow — the value of
 * `workflow` once the change is applied — and reports a stored `step` that no
 * longer fits.
 *
 * It stands outside the per-key loop of the caller because the last case
 * concerns a stored `step` the change does not state, and that loop walks the
 * keys the change does state. A workflow the change does not state is not
 * re-checked against the declared list either: only the value being written is
 * refused, so a project that dropped a workflow leaves the tasks that name it as
 * they are.
 */
export async function validateWorkflowInto(check: WriteContext): Promise<void> {
  const { workflows, config, frontmatter, keys, path, diagnostics } = check;
  const statesWorkflow = keys.has("workflow");
  if (!statesWorkflow && !keys.has("step")) return;
  const name = frontmatter.workflow;
  const step = frontmatter.step;

  let workflow: Workflow | undefined;
  if (name !== undefined) {
    if (typeof name !== "string") fail("workflow-unknown", "workflow must be a string", path);
    // Read once, and only where a value the call must place depends on it.
    if (statesWorkflow) workflow = await readDeclaredWorkflow(workflows, config.workflows, name, diagnostics);
    else if (step !== undefined) {
      const read = await workflows.read(name);
      diagnostics.push(...read.diagnostics);
      workflow = read.workflow;
    }
  }

  if (keys.has("step") && step !== undefined) {
    if (typeof step !== "string") fail("step-unknown", "step must be a string", path);
    if (workflow === undefined) {
      fail("step-unknown", `the step "${step}" was stated for a task that names no workflow`, path);
    }
    if (!declaresStep(workflow, step)) {
      fail("step-unknown", noSuchStep(workflow.name, step), workflows.pathsOf(workflow.name).file);
    }
    return;
  }
  // The change did not state `step`, so a stored one that no longer fits is
  // reported and kept: it is what a workflow the user edited leaves behind, and
  // refusing it would strand the task instead of naming the problem.
  if (typeof step !== "string" || (workflow !== undefined && declaresStep(workflow, step))) return;
  diagnostics.push({ code: "step-stale", message: staleStep(step, workflow), path });
}

/**
 * Reports a workflow the task names that does not resolve, and a step its
 * workflow does not declare. Without it an agent picking up a task left on a
 * removed step would never learn: the value is refused only on a write, and by
 * then the write is setting a valid step and the stale value is already gone.
 *
 * The list the project declares is not consulted, and configuration is not
 * resolved. That check is write-only: `resolveConfig` refuses a configuration
 * file it cannot read, so one broken `config.yml` would make every task of the
 * project unreadable. What a read has to tell a caller is whether the workflow
 * resolves and whether its step is in it.
 */
export async function reportWorkflowInto(
  workflows: Workflows,
  frontmatter: Frontmatter,
  path: string,
  diagnostics: StoreDiagnostic[],
): Promise<void> {
  const name = frontmatter.workflow;
  const step = frontmatter.step;
  if (typeof name !== "string") {
    // A task carrying a step and no workflow is the one state a write is
    // allowed to create and no workflow can account for.
    if (typeof step === "string") {
      diagnostics.push({ code: "step-stale", message: staleStep(step, undefined), path });
    }
    return;
  }
  let workflow;
  try {
    // The findings of the load itself are not forwarded. They concern a shared
    // file, and a read reports on this task: an unknown key in one workflow
    // would otherwise arrive once per task that names it.
    workflow = (await workflows.read(name)).workflow;
  } catch (error) {
    if (!(error instanceof TaskStoreError)) throw error;
    diagnostics.push({
      code: "workflow-missing",
      message: `this task names the workflow "${name}", which does not resolve: ${causeOf(error)}`,
      // Every fault the loader raises names the directory or the file it stands
      // on, which is what a caller has to open next.
      path: error.path,
    });
    return;
  }
  if (typeof step === "string" && !declaresStep(workflow, step)) {
    diagnostics.push({ code: "step-stale", message: staleStep(step, workflow), path });
  }
}

/**
 * Every document that applies to one step, broad to narrow: the instructions of
 * the workflow, then those of the project, then the step's own file. Without a
 * stated order two clients would assemble the same rules differently and behave
 * differently on the same files.
 *
 * The step's own file is the thing the caller asked for, so a file that cannot
 * be read refuses the call; an entry of either instructions list that cannot be
 * read is a diagnostic and the other documents are still returned.
 */
export async function readStepInstructions(
  workflows: Workflows,
  config: ResolvedConfig,
  workflow: string,
  step: string,
  diagnostics: StoreDiagnostic[],
): Promise<InstructionDocument[]> {
  const loaded = await readDeclaredWorkflow(workflows, config.workflows, workflow, diagnostics);
  const entry = stepEntry(loaded, step, workflows.pathsOf(workflow).file);
  const documents = await readInstructions(loaded.instructions, diagnostics);
  documents.push(...(await readInstructions(config.instructions, diagnostics)));
  documents.push(await readStepDocument(entry.file));
  return documents;
}
