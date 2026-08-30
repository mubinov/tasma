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
export type StoreDiagnosticCode =
  | "stale-next-comment-id"
  | "unterminated-fence"
  | "next-comment-id-repaired"
  | "next-task-id-rebuilt"
  | "next-task-id-advanced"
  | "label-case-converted"
  | "label-duplicate-dropped"
  | "status-case-corrected"
  | "priority-case-corrected"
  | "config-key-unknown"
  | "state-key-unknown"
  | "task-file-unreadable"
  | "task-file-foreign"
  | "task-file-unexpected"
  | "temp-file-left"
  // What the index raises and no store call does.
  | "task-file-misnamed"
  | "tasks-directory-lost"
  | "index-watch-failed";

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
  priorities: string[];
};

export type ConfigResult = {
  config: ResolvedConfig;
  diagnostics: StoreDiagnostic[];
};

export type ListResult = {
  ids: string[];
  diagnostics: StoreDiagnostic[];
};
