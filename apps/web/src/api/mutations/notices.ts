import { ProtocolError, TransportError, type Diagnostic, type SerializeErrorCode } from "@tasma/protocol";
import { useNoticeStore, type Notice } from "../../store/notices";

export type FailureKind = "refused" | "unanswered" | "address" | "unsent";

export function failureKind(cause: unknown): FailureKind {
  if (cause instanceof ProtocolError) {
    return "refused";
  }
  if (cause instanceof TransportError) {
    return cause.status === undefined ? "unanswered" : "address";
  }
  return "unsent";
}

/** A write failed. The domain that sent it subclasses this to add what its own notice reads. */
export class WriteError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "WriteError";
  }
}

/** Closed first, so the notice of an earlier write, dismissed or not, does not hold this one back. */
export function openWriteNotice(notice: Notice): void {
  useNoticeStore.getState().closeNotice(notice.key);
  useNoticeStore.getState().showNotice(notice);
}

export const FAILURE_KEY_PREFIX = "task-write-failure:";

export const WARNING_KEY_PREFIX = "task-write-warnings:";

/**
 * The correction a refusal about the body names, by the code the daemon refused
 * with. A map rather than an object: the daemon's `code` is validated as a
 * string alone, and a prototype key would index an object literal to something
 * that is not a message.
 */
const BODY_CORRECTIONS = new Map<SerializeErrorCode, string>([
  [
    "marker-collision",
    "The body starts a line with a comment marker. Indent that line, or change its first characters.",
  ],
  ["fence-unterminated", "The body opens a code fence that never closes. Close the fence."],
]);

/**
 * What a refusal that is about the body tells the reader to correct, and
 * nothing for a refusal that ties to no field of the editor. It takes the
 * error a write rejects with as readily as the refusal inside it.
 */
export function bodyCorrection(error: unknown): string | undefined {
  const cause = error instanceof WriteError ? error.cause : error;

  if (!(cause instanceof ProtocolError) || cause.failure.kind !== "serialize") {
    return undefined;
  }

  return BODY_CORRECTIONS.get(cause.failure.code);
}

/** The diagnostics of a write that the screen the reader is on does not already show. */
export function freshDiagnostics(
  written: readonly Diagnostic[],
  known: readonly Diagnostic[],
): Diagnostic[] {
  return written.filter((diagnostic) => !known.some(
    ({ code, message }) => code === diagnostic.code && message === diagnostic.message,
  ));
}
