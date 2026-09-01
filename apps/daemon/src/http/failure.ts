// A thrown fault as the wire reports it, and the status that goes with it.
//
// Every status the daemon sends is decided here: a handler throws, the router
// names a code, and one table per kind turns that code into a number. The
// tables are exhaustive records, so a code the engine adds fails the typecheck
// until somebody classifies it.

import { TaskParseError, TaskSerializeError, TaskStoreError } from "@tasma/engine";
import type {
  DaemonErrorCode,
  Failure,
  ParseErrorCode,
  SerializeErrorCode,
  StoreErrorCode,
} from "@tasma/protocol";

/**
 * A refusal the daemon raises for a condition no engine code describes: a
 * request it cannot read, route or accept. Thrown rather than returned, so it
 * reaches the wire down the same path as an engine fault.
 */
export class DaemonError extends Error {
  readonly code: DaemonErrorCode;

  constructor(code: DaemonErrorCode, message: string) {
    super(message);
    this.name = "DaemonError";
    this.code = code;
  }
}

/**
 * The explanation a fault carries, without the class name a string conversion
 * puts in front of it. The engine keeps its own `causeOf` unexported, so the
 * daemon writes the one line under the same name rather than widening the
 * engine's public surface.
 */
export function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whatever was thrown, as the failure the client reads.
 *
 * The two format classes share a base, so the test is against the two leaves.
 * Each engine message already carries its own prefix — `path: description` from
 * the store, `filename:line: description` from the format layer — so it goes
 * out unchanged.
 */
export function toFailure(error: unknown): Failure {
  if (error instanceof TaskStoreError) {
    return { kind: "store", code: error.code, message: error.message, path: error.path };
  }
  if (error instanceof TaskParseError) {
    return { kind: "parse", code: error.code, message: error.message, line: error.line, filename: error.filename };
  }
  if (error instanceof TaskSerializeError) {
    return {
      kind: "serialize",
      code: error.code,
      message: error.message,
      line: error.line,
      filename: error.filename,
      field: error.field,
    };
  }
  if (error instanceof DaemonError) {
    return { kind: "daemon", code: error.code, message: error.message };
  }

  // The text is kept: the daemon is a local process a developer runs, and a 500
  // saying nothing could only be debugged by adding output this layer has none of.
  return { kind: "daemon", code: "internal", message: causeOf(error) };
}

const STORE_STATUS = {
  "task-not-found": 404,
  "comment-not-found": 404,
  "project-not-found": 404,
  // The file changed under a write, which a caller answers by reading again and
  // retrying rather than by sending something else.
  "task-exists": 409,
  "comment-exists": 409,
  "snapshot-lost": 409,
  // Each of these is a file on disk that cannot be used, not a bad call.
  "project-invalid": 422,
  "config-invalid": 422,
  "workflow-invalid": 422,
  "step-file-unreadable": 422,
  // Only a daemon on its way out refuses this way.
  "index-closed": 503,
  "status-unknown": 400,
  "priority-unknown": 400,
  "label-invalid": 400,
  "workflow-unknown": 400,
  "step-unknown": 400,
  "field-not-writable": 400,
  "field-required": 400,
  "id-mismatch": 400,
} satisfies Record<StoreErrorCode, number>;

// A file on disk that cannot be read. The caller sent nothing wrong and
// repeating the call will not help, so it is neither a 400 nor a 500.
const PARSE_STATUS = {
  "frontmatter-missing": 422,
  "frontmatter-unterminated": 422,
  "frontmatter-invalid": 422,
  "frontmatter-key-missing": 422,
  "frontmatter-key-type": 422,
  "marker-unterminated": 422,
  "marker-invalid": 422,
  "marker-key-missing": 422,
  "marker-key-type": 422,
  "comment-id-duplicate": 422,
} satisfies Record<ParseErrorCode, number>;

const SERIALIZE_STATUS = {
  // Each rejects the content the caller sent: a value that would collide with a
  // delimiter, an unterminated fence, a bad label, a missing or mistyped key.
  "key-missing": 400,
  "key-type": 400,
  "label-invalid": 400,
  "value-contains-arrow": 400,
  "frontmatter-collision": 400,
  "marker-collision": 400,
  "fence-unterminated": 400,
  "comment-id-duplicate": 400,
  "value-unwritable": 400,
  // Each is a property of the YAML already in the file: the writer cannot
  // address a key lent by a merge key or pointed at by an anchor, whatever the
  // request says.
  "anchor-aliased": 422,
  "merge-key": 422,
  "key-unaddressable": 422,
  // An unexpected throw from the YAML library, which is the daemon's own fault.
  "region-unwritable": 500,
} satisfies Record<SerializeErrorCode, number>;

const DAEMON_STATUS = {
  "internal": 500,
  "malformed-request": 400,
  "route-not-found": 404,
  "method-not-allowed": 405,
  "unsupported-media-type": 415,
  "request-too-large": 413,
} satisfies Record<DaemonErrorCode, number>;

/** The status a refusal is sent with. Every success answers 200. */
export function statusOf(failure: Failure): number {
  switch (failure.kind) {
    case "store":
      return STORE_STATUS[failure.code];
    case "parse":
      return PARSE_STATUS[failure.code];
    case "serialize":
      return SERIALIZE_STATUS[failure.code];
    case "daemon":
      return DAEMON_STATUS[failure.code];
  }
}
