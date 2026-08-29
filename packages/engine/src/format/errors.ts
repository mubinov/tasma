export type TaskParseErrorCode =
  | "frontmatter-missing"
  | "frontmatter-unterminated"
  | "frontmatter-invalid"
  | "frontmatter-key-missing"
  | "frontmatter-key-type"
  | "marker-unterminated"
  | "marker-invalid"
  | "marker-key-missing"
  | "marker-key-type"
  | "comment-id-duplicate";

export type TaskSerializeErrorCode =
  | "key-missing"
  | "key-type"
  | "value-contains-arrow"
  | "frontmatter-collision"
  | "marker-collision"
  | "fence-unterminated"
  | "comment-id-duplicate"
  | "anchor-aliased"
  | "merge-key"
  | "key-unaddressable"
  | "region-unwritable"
  | "value-unwritable";

export type TaskFormatErrorCode = TaskParseErrorCode | TaskSerializeErrorCode;

/**
 * A task file the format layer cannot read, or a task it cannot write as a file
 * that reads back the same way. Callers match on `code`, never on the message.
 */
export abstract class TaskFormatError extends Error {
  abstract readonly code: TaskFormatErrorCode;
  readonly line: number;
  readonly filename: string | undefined;

  protected constructor(name: string, line: number, description: string, filename?: string, cause?: unknown) {
    super(filename === undefined ? `line ${line}: ${description}` : `${filename}:${line}: ${description}`, { cause });
    this.name = name;
    this.line = line;
    this.filename = filename;
  }
}

/** A task file that cannot be read. */
export class TaskParseError extends TaskFormatError {
  override readonly code: TaskParseErrorCode;

  constructor(code: TaskParseErrorCode, line: number, description: string, filename?: string, cause?: unknown) {
    super("TaskParseError", line, description, filename, cause);
    this.code = code;
  }
}

/** A task that cannot be written as a file that reads back the same way. */
export class TaskSerializeError extends TaskFormatError {
  override readonly code: TaskSerializeErrorCode;
  /** The path of the offending value inside its region, for example `custom.workflow.note`. */
  readonly field: string | undefined;

  constructor(
    code: TaskSerializeErrorCode,
    line: number,
    description: string,
    field?: string,
    filename?: string,
    cause?: unknown,
  ) {
    super("TaskSerializeError", line, description, filename, cause);
    this.code = code;
    this.field = field;
  }
}

/** How a fault in one region is reported: the name of the region, and the file it came from. */
export type Faults = { label: "frontmatter" | "marker"; filename: string | undefined };

/** Raises the fault a write-time check decided on. */
export function fail(
  code: TaskSerializeErrorCode,
  line: number,
  description: string,
  field: string | undefined,
  filename: string | undefined,
  cause?: unknown,
): never {
  throw new TaskSerializeError(code, line, description, field, filename, cause);
}
