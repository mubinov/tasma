// A workflow, its steps, and the documents a step is defined in.

/** One step a workflow declares. `file` is a resolved absolute path. */
export type WorkflowStep = {
  name: string;
  file: string;
  /** Every key the entry states beyond `name` and `file`, exactly as read. Absent when none. */
  custom?: Record<string, unknown>;
};

export type Workflow = {
  /** The name of the directory the workflow stands in. */
  name: string;
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
