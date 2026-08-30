/**
 * Every reason a call on a project can be refused. The code of the index is
 * named here although the index is a layer above the store, for the reason its
 * diagnostic codes are named in `StoreDiagnosticCode`: a caller holds one
 * project and matches one union, whichever of the two layers refused the call.
 */
export type TaskStoreErrorCode
  = | "task-not-found"
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
    | "snapshot-lost"
    // What the index refuses with once it is closed, and no store call does.
    | "index-closed";

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

/**
 * The explanation a fault carries, without the class name a string conversion
 * puts in front of it. A message written for a reader states what went wrong,
 * never which class refused the work.
 */
export function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The code a filesystem fault carries, or `undefined` for anything else. */
export function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
