import { ProtocolError, TransportError } from "@tasma/protocol";
import { DAEMON_URL } from "../api/transport";

export type FailureWords = { head?: string; message: string };

/** What a failure panel or notice prints for a failure: who answered, and what was said. */
export function failureWords(error: unknown): FailureWords {
  if (error instanceof ProtocolError) {
    // The client validates `kind` alone, so the message need not be a string.
    return { head: `${error.failure.kind}/${error.failure.code}`, message: String(error.failure.message) };
  }

  if (error instanceof TransportError) {
    return error.status === undefined
      ? { message: DAEMON_URL }
      : { head: `${DAEMON_URL} · HTTP ${String(error.status)}`, message: error.message };
  }

  // A thrown value need not be an `Error`: a thrown string has no `message`.
  return { message: error instanceof Error ? error.message : String(error) };
}

export function joinFailureWords({ head, message }: FailureWords): string {
  return head === undefined ? message : `${head} · ${message}`;
}
