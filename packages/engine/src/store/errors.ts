export type TaskStoreErrorCode =
  | "task-not-found"
  | "task-exists"
  | "comment-not-found"
  | "comment-exists"
  | "project-not-found"
  | "project-invalid"
  | "config-invalid"
  | "status-unknown"
  | "priority-unknown"
  | "label-invalid"
  | "field-not-writable"
  | "field-required"
  | "id-mismatch"
  | "snapshot-lost";

/**
 * A store operation that cannot be carried out. Callers match on `code`, never
 * on the message, the way they match a `TaskFormatError`.
 *
 * `TaskParseError` and `TaskSerializeError` are not wrapped in this: a file the
 * format layer refuses keeps reporting the code that layer defined.
 */
export class TaskStoreError extends Error {
  readonly code: TaskStoreErrorCode;
  /** The file or directory the fault concerns, when one path holds it. */
  readonly path: string | undefined;

  constructor(code: TaskStoreErrorCode, description: string, path?: string, cause?: unknown) {
    super(path === undefined ? description : `${path}: ${description}`, { cause });
    this.name = "TaskStoreError";
    this.code = code;
    this.path = path;
  }
}

export function fail(code: TaskStoreErrorCode, description: string, path?: string, cause?: unknown): never {
  throw new TaskStoreError(code, description, path, cause);
}

/** The code a filesystem fault carries, or `undefined` for anything else. */
export function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
