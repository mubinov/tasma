// A public name of the store layer comes from the barrel the package publishes;
// a name it does not export comes from the file that holds it.
import type { StoreDiagnostic } from "../store/types.js";

/**
 * One step a workflow declares: identity and location, and nothing else.
 *
 * `file` is a resolved absolute path.
 */
export type WorkflowStep = {
  name: string;
  file: string;
  /**
   * Every key the entry states beyond `name` and `file`, exactly as read, and
   * absent when it states none. The entry is the one reserved place for a
   * per-step property a later component needs; they stand under a name of their
   * own so that a key this format does define stays type-checked.
   */
  custom?: Record<string, unknown>;
};

export type Workflow = {
  /** The name of the directory the workflow stands in, which is its name. */
  name: string;
  title?: string;
  /** The steps in the order the file declares them. */
  steps: WorkflowStep[];
  /** The documents that apply to every step, as resolved absolute paths. */
  instructions: string[];
  /**
   * Stored exactly as read and never consulted. It is typed `unknown` on
   * purpose: a caller that wants to act on it must narrow it, so no component
   * that reads a workflow today decides what the transition model will be.
   */
  transitions?: unknown;
};

/** One instruction document: the whole file, with the path it was read from. */
export type InstructionDocument = { path: string; text: string };

export type WorkflowList = { names: string[]; diagnostics: StoreDiagnostic[] };

export type WorkflowResult = { workflow: Workflow; diagnostics: StoreDiagnostic[] };

export type WorkflowStepResult = {
  step: WorkflowStep;
  document: InstructionDocument;
  diagnostics: StoreDiagnostic[];
};

/** Every document that applies to one step, in the order the format states. */
export type InstructionsResult = { documents: InstructionDocument[]; diagnostics: StoreDiagnostic[] };

/** Where one workflow stands: its directory, and the file that declares it. */
export type WorkflowPaths = { directory: string; file: string };

/**
 * A handle on the workflows of one tree. Every call returns a non-optional
 * value, so a question this cannot answer raises rather than answering with an
 * empty one.
 *
 * The handle carries no project, so no call of it checks the list of workflows a
 * project declares. `Project.stepInstructions` is where a project is in scope
 * and that check is made.
 */
export type Workflows = {
  /** The directory the workflows of this tree stand in. */
  readonly directory: string;
  /**
   * Where the workflow of one name stands, for a caller that must name it in a
   * fault. This is the one place a name becomes a path, so a name that is no
   * workflow name is refused here with `workflow-unknown`, which is what keeps
   * every path this handle builds inside its own directory.
   */
  pathsOf(name: string): WorkflowPaths;
  /**
   * The name of every workflow the tree holds, ascending. A missing `workflows/`
   * directory is an empty list, and a directory that holds no workflow is a
   * diagnostic rather than a fault: a listing never fails because one workflow
   * of many is broken.
   */
  list(): Promise<WorkflowList>;
  read(name: string): Promise<WorkflowResult>;
  readStep(name: string, step: string): Promise<WorkflowStepResult>;
};
