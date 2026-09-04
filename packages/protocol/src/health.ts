// What the liveness route answers, and the one shape that identifies a Tasma daemon.

/** A literal, so a client can tell a daemon from any other process holding the port. */
export const DAEMON_NAME = "tasma-daemon";

export type Health = {
  name: typeof DAEMON_NAME;
  /** The daemon's own package version, informational: no call negotiates on it. */
  version: string;
};
