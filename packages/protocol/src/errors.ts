// How a call is refused, and how an answer is shaped.
//
// A refusal is discriminated by `kind` because two codes belong to two engine
// unions at once. `comment-id-duplicate` from the parser says the file on disk
// already holds two comments with one id and nothing the caller sent caused it;
// from the serializer it says the write being attempted would produce them and
// is refused. A flat code cannot tell a broken file from a rejected request.

import type { Diagnostic } from "./diagnostics.js";

export type StoreErrorCode
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
    | "blocked-by-invalid"
    | "blocked-by-unknown"
    | "workflow-invalid"
    | "workflow-unknown"
    | "step-unknown"
    | "step-file-unreadable"
    | "field-not-writable"
    | "field-required"
    | "id-mismatch"
    | "snapshot-lost"
    | "index-closed";

export type ParseErrorCode
  = | "frontmatter-missing"
    | "frontmatter-unterminated"
    | "frontmatter-invalid"
    | "frontmatter-key-missing"
    | "frontmatter-key-type"
    | "marker-unterminated"
    | "marker-invalid"
    | "marker-key-missing"
    | "marker-key-type"
    | "comment-id-duplicate";

export type SerializeErrorCode
  = | "key-missing"
    | "key-type"
    | "label-invalid"
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

/** What the daemon itself refuses with, for a condition no engine code describes. */
export type DaemonErrorCode
  = | "internal"
    | "malformed-request"
    | "route-not-found"
    | "method-not-allowed"
    | "unsupported-media-type"
    | "request-too-large";

/**
 * Why a call was refused. Each arm carries only the fields its engine class has:
 * `line` is required wherever the format layer raised the fault, and `field` is
 * reachable only on a serialize refusal, which is the one that names the
 * offending value.
 *
 * A refusal carries no diagnostics. An engine method builds its diagnostics
 * inside itself and returns them in its result; when it throws instead, that
 * array is abandoned and the daemon never receives it.
 */
export type Failure
  = | { kind: "store"; code: StoreErrorCode; message: string; path?: string }
    | { kind: "parse"; code: ParseErrorCode; message: string; line: number; filename?: string }
    | { kind: "serialize"; code: SerializeErrorCode; message: string; line: number; filename?: string; field?: string }
    | { kind: "daemon"; code: DaemonErrorCode; message: string };

export type Success<T> = {
  data: T;
  diagnostics: Diagnostic[];
};

/**
 * What a route answers with. The body is authoritative and the HTTP status is
 * advisory: a client narrows on `ok` and never reads the status for meaning.
 */
export type Envelope<T>
  = | ({ ok: true } & Success<T>)
    | { ok: false; error: Failure };

/** The daemon refused the call and said why. */
export class ProtocolError extends Error {
  readonly failure: Failure;
  /** The advisory status the refusal arrived with. */
  readonly status: number;

  constructor(failure: Failure, status: number) {
    super(failure.message);
    this.name = "ProtocolError";
    this.failure = failure;
    this.status = status;
  }
}

/** The call produced no usable answer, so there is nothing to narrow on. */
export class TransportError extends Error {
  /** Present only where an answer arrived at all. */
  readonly status: number | undefined;

  constructor(message: string, status?: number, cause?: unknown) {
    super(message, { cause });
    this.name = "TransportError";
    this.status = status;
  }
}
