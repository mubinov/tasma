import type { Task } from "../format/index.js";

/**
 * Everything one call corrected, passed over or read as questionable, empty on a
 * plain operation. An anomaly the engine resolved on the caller's behalf is
 * still reported: the report is the only signal a caller gets that a hand edit
 * or another writer changed the file. The two codes the reader defines are
 * forwarded here too, so a caller reads one channel and matches one union.
 *
 * The codes of the index are named here for the same reason, although it pushes
 * its findings to a listener rather than returning them: one channel, one union
 * to match.
 */
export type StoreDiagnosticCode
  = | "stale-next-comment-id"
    | "unterminated-fence"
    | "next-comment-id-repaired"
    | "next-task-id-rebuilt"
    | "next-task-id-advanced"
    | "label-case-converted"
    | "label-duplicate-dropped"
    | "blocked-by-duplicate-dropped"
    | "status-case-corrected"
    | "priority-case-corrected"
    | "config-key-unknown"
    | "config-unreadable"
    | "state-key-unknown"
    | "workflow-key-unknown"
    | "workflows-path-unusable"
    | "workflow-missing"
    | "step-stale"
    | "instruction-file-unreadable"
    | "task-file-unreadable"
    | "task-file-foreign"
    | "task-file-unexpected"
    | "temp-file-left"
    // What the index raises and no store call does.
    | "blocked-by-unresolved"
    | "task-file-misnamed"
    | IndexLivenessLost;

/**
 * The findings that say an index stopped following the disk, named as their own
 * union so that a caller reporting liveness matches this instead of restating
 * which codes mean it.
 */
export type IndexLivenessLost = "tasks-directory-lost" | "index-watch-failed";

const LIVENESS_LOST = {
  "tasks-directory-lost": true,
  "index-watch-failed": true,
} satisfies Record<IndexLivenessLost, true>;

/**
 * True for a finding that says the index stopped following the disk. The record
 * behind it is exhaustive over `IndexLivenessLost`, so a code that later joins
 * that union fails the typecheck here until it states what it means for
 * liveness.
 */
export function endsLiveness(code: StoreDiagnosticCode): boolean {
  return Object.hasOwn(LIVENESS_LOST, code);
}

export type StoreDiagnostic = {
  code: StoreDiagnosticCode;
  message: string;
  path?: string;
  line?: number;
};

export type ProjectOptions = {
  /** The project tag, which is also the name of its directory. */
  project: string;
  /** The tree the engine stores everything under. Defaults to `~/.tasma`. */
  root?: string;
};

/**
 * The fields one write sets. A key that is absent leaves the field alone; a key
 * present with the value `undefined` clears it. Every frontmatter key the format
 * defines may be named, less the ones the store owns — `id`, `created`,
 * `updated` and `next_comment_id`; data of another component belongs under
 * `custom`. `body` is the markdown between the frontmatter and the first comment.
 */
export type TaskChange = { body?: string } & Record<string, unknown>;

/** The same for one comment. The store owns `id`, `created` and `updated`. */
export type CommentChange = { body?: string } & Record<string, unknown>;

export type WriteResult = {
  id: string;
  /** The id of the comment the write concerns: issued by an add, repeated by an edit or a delete. */
  commentId?: number;
  /** Present when the write set the field: the value as it was stored. */
  labels?: string[];
  blocked_by?: string[];
  status?: string;
  priority?: string;
  diagnostics: StoreDiagnostic[];
};

export type ReadResult = {
  task: Task;
  diagnostics: StoreDiagnostic[];
};

export type ResolvedConfig = {
  statuses: string[];
  default_status: string;
  /**
   * The statuses that end a task, always present: the last of `statuses` when no
   * configuration file states the key. It is what decides whether a blocker
   * still blocks.
   */
  final_statuses: string[];
  priorities: string[];
  /** The workflows a task of this project may name. Empty when the project declares none. */
  workflows: string[];
  /** The documents that apply to every task of this project, as resolved absolute paths. */
  instructions: string[];
  /** The project's display name. Absent when the project declares none. */
  name?: string;
  /** The project's repository, as a resolved absolute path. Absent when the project declares none. */
  path?: string;
  /**
   * The workflows directory the user named, as a resolved absolute path, and
   * absent when no file named one. It is user-level alone: the workflows tree is
   * one shared thing per machine.
   */
  workflows_path?: string;
};

/**
 * What a project states about itself beyond its tag. Both keys are
 * project-level alone, so a caller that needs no more than these reads the one
 * file that can state them rather than resolving the whole configuration.
 */
export type ProjectDeclaration = Pick<ResolvedConfig, "name" | "path">;

export type ConfigResult = {
  config: ResolvedConfig;
  diagnostics: StoreDiagnostic[];
};

export type ListResult = {
  ids: string[];
  diagnostics: StoreDiagnostic[];
};
