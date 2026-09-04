// Where a daemon listens when nothing overrides it, for every client that has
// to name that address without being told one.
//
// The host and the port are separate and the URL is derived from them, so a
// caller that binds a port never parses one back out of a URL.
//
// 127.0.0.1 rather than localhost: the literal avoids a name lookup per
// invocation, and avoids `localhost` resolving to ::1 against a daemon bound to
// 127.0.0.1, which presents as a refused connection to a daemon that is running.

export const DEFAULT_DAEMON_HOST = "127.0.0.1";
export const DEFAULT_DAEMON_PORT = 8278;
export const DEFAULT_DAEMON_URL = `http://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}`;
