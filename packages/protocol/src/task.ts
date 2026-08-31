// A task and its parts as they cross the wire.
//
// These shapes are the engine's, less what JSON cannot carry: the engine holds
// the source region a task was read from under a symbol key, and a symbol key
// does not survive a JSON round trip. Everything else is repeated field for
// field, and `test/protocol-contract.test.ts` at the repository root fails the
// typecheck when the two drift apart.

export type Frontmatter = {
  id: string;
  title: string;
  status: string;
  created: string;
  updated: string;
  next_comment_id: number;
  workflow?: string;
  step?: string;
  priority?: string;
  order?: number;
  labels?: string[];
  parent?: string;
  custom?: Record<string, unknown>;
};

/** The marker fields of a comment: everything written inside the marker. */
export type CommentFields = {
  id: number;
  title: string;
  created: string;
  updated?: string;
  author?: string;
  collapsed?: boolean;
  custom?: Record<string, unknown>;
};

export type Comment = CommentFields & {
  body: string;
  /** Where the comment sits in the file it was parsed from, 1-based and inclusive. */
  lines?: { start: number; end: number };
};

export type Task = {
  frontmatter: Frontmatter;
  body: string;
  comments: Comment[];
};

/** One task of a listing: the frontmatter alone, never the body. */
export type TaskEntry = {
  id: string;
  path: string;
  frontmatter: Frontmatter;
};

/** Why a file named as a task file of a project holds no entry. */
export type ExclusionCode
  = | "task-file-unreadable"
    | "task-file-foreign"
    | "task-file-misnamed";

export type ExcludedFile = {
  path: string;
  code: ExclusionCode;
  message: string;
};

/**
 * Every task a listing holds, and the files that failed to become one. An
 * excluded file is a caveat on the completeness of the listing, never a missing
 * result, so it arrives with the answer it qualifies.
 */
export type TaskList = {
  entries: TaskEntry[];
  excluded: ExcludedFile[];
};

/**
 * What one write set. The diagnostics of the write are not here: on the wire
 * every route reports them in the envelope, so there is one rule for all of them.
 */
export type WriteResult = {
  id: string;
  /** The id of the comment the write concerns: issued by an add, repeated by an edit or a delete. */
  commentId?: number;
  /** Present when the write set the field: the value as it was stored. */
  labels?: string[];
  status?: string;
  priority?: string;
};

/**
 * The fields one write sets. An unknown key is carried rather than rejected,
 * because the engine writes an unknown frontmatter key back unchanged and a
 * narrower type here would refuse data the engine keeps.
 */
export type TaskInput = { body?: string } & Record<string, unknown>;

/** The same for one comment. */
export type CommentInput = { body?: string } & Record<string, unknown>;
