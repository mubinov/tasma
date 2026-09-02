import type { Document } from "yaml";

/**
 * Key of the parsed source a region was read from.
 *
 * The property is enumerable, so a spread copy of a task or a comment keeps it
 * and still writes back byte for byte. It is a symbol so that a plain
 * `{ frontmatter, body, comments }` literal is a valid `Task`.
 *
 * A copy that carries no symbol keys, such as the result of `structuredClone`
 * or of a JSON round trip, loses it. Serialization then generates every region
 * instead of writing it back, which drops YAML comments and rewrites quoting.
 * `hasSource` reports the loss.
 */
export const SNAPSHOT: unique symbol = Symbol("tasma.format.snapshot");

/** Whether the value still carries the source that lets a writer reproduce it byte for byte. */
export function hasSource(value: Task | TaskComment): boolean {
  return value[SNAPSHOT] !== undefined;
}

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
  blocked_by?: string[];
  custom?: Record<string, unknown>;
};

/** The marker fields of a comment: everything that is written inside the marker. */
export type CommentFields = {
  id: number;
  title: string;
  created: string;
  updated?: string;
  author?: string;
  collapsed?: boolean;
  custom?: Record<string, unknown>;
};

export type TaskComment = CommentFields & {
  body: string;
  /** Where the comment sits in the parsed file, 1-based and inclusive. Serialization ignores it. */
  lines?: { start: number; end: number };
  [SNAPSHOT]?: CommentSnapshot;
};

export type Task = {
  frontmatter: Frontmatter;
  body: string;
  comments: TaskComment[];
  [SNAPSHOT]?: FrontmatterSnapshot;
};

export type FrontmatterSnapshot = {
  /** The region as it was read, from the opening `---` to the end of the closing `---` line. */
  raw: string;
  doc: Document;
  values: Frontmatter;
};

export type CommentSnapshot = {
  /** The marker as it was read, from `<!--` to the end of the line that closes it. */
  raw: string;
  doc: Document;
  values: CommentFields;
};

export type DiagnosticCode = "stale-next-comment-id" | "unterminated-fence";

export type Diagnostic = {
  code: DiagnosticCode;
  line: number;
  message: string;
};

export type ParseOptions = {
  filename?: string;
};

export type SerializeOptions = {
  filename?: string;
};

export type ParseResult = {
  task: Task;
  diagnostics: Diagnostic[];
};
