// What the liveness route answers, and the one shape that identifies a Tasma daemon.

export type Health = {
  /** A literal, so a client can tell a daemon from any other process holding the port. */
  name: "tasma-daemon";
  /** The daemon's own package version, informational: no call negotiates on it. */
  version: string;
};
