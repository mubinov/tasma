// A workflow, its steps, and the documents a step is defined in.

/** Who performs a step. The step's default turn, never the state of a running session. */
export type StepOwner = "agent" | "human";

/** One step a workflow declares. `file` is a resolved absolute path. */
export type WorkflowStep = {
  name: string;
  file: string;
  owner: StepOwner;
  /** Every key the entry states beyond `name`, `file` and `owner`, exactly as read. Absent when none. */
  custom?: Record<string, unknown>;
};

export type Workflow = {
  /** The name of the directory the workflow stands in. */
  name: string;
  /** The file that declares the workflow, as a resolved absolute path. */
  file: string;
  title?: string;
  /** The steps in the order the file declares them. */
  steps: WorkflowStep[];
  /** The documents that apply to every step, as resolved absolute paths. */
  instructions: string[];
  /** Stored exactly as read and never consulted. */
  transitions?: unknown;
};

/** One instruction document: the whole file, with the path it was read from. */
export type InstructionDocument = { path: string; text: string };

/** One step and the document its file holds. */
export type StepDefinition = { step: WorkflowStep; document: InstructionDocument };

/**
 * One step a write states. `file` must be absolute or start with `~/`, and name a
 * regular file; it is stored as stated.
 */
export type StepInput = { name: string; owner: StepOwner; file: string };

/**
 * What a create states. `instructions` entries follow the rule of
 * `StepInput.file`. The daemon refuses a name that exists as `workflow-exists`.
 */
export type WorkflowInput = { name: string; title?: string; instructions?: string[]; steps: StepInput[] };

/**
 * One change of a `workflow.yml`. A key present with `null` removes the key and
 * an absent key leaves it alone. A list replaces the stored list, and a step
 * entry keeps the other keys of the stored entry of the same name. `steps`
 * cannot be removed.
 *
 * Each task on a step the new list no longer holds is reported as a
 * `step-stale` diagnostic, except a task in a final status.
 */
export type WorkflowChange = { title?: string | null; instructions?: string[] | null; steps?: StepInput[] };

/**
 * The answer to a delete: the name removed. A workflow a project lists is
 * refused as `workflow-in-use`.
 */
export type WorkflowReceipt = { name: string };
