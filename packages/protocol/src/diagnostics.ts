// Everything one call corrected, passed over or read as questionable.
//
// A diagnostic is not a refusal: the call succeeded and the report is the only
// signal a client gets that a hand edit or another writer changed a file. Every
// success carries the channel, empty when there is nothing to report.

export type DiagnosticCode
  = | "stale-next-comment-id"
    | "unterminated-fence"
    | "next-comment-id-repaired"
    | "next-task-id-rebuilt"
    | "next-task-id-advanced"
    | "label-case-converted"
    | "label-duplicate-dropped"
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
    | "task-file-misnamed"
    | "tasks-directory-lost"
    | "index-watch-failed";

export type Diagnostic = {
  code: DiagnosticCode;
  message: string;
  /** The file or directory the finding concerns, as an absolute path. */
  path?: string;
  line?: number;
};
