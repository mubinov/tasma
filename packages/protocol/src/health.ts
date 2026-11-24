// What the liveness route answers, and the one shape that identifies a Tasma daemon.

/** A literal, so a client can tell a daemon from any other process holding the port. */
export const DAEMON_NAME = "tasma-daemon";

export type Health = {
  name: typeof DAEMON_NAME;
  /** The daemon's own package version, informational: no call negotiates on it. */
  version: string;
  /** The OS user id of the daemon process. A daemon of an earlier version does not send it. */
  uid?: number;
};

/**
 * Whether a health answer comes from the daemon of another OS user. An answer
 * with no `uid` counts as the caller's own: a daemon of an earlier version
 * sends none.
 */
export function ofAnotherUser(health: { uid?: unknown }, uid: number): boolean {
  return health.uid !== undefined && health.uid !== uid;
}
