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

/** The address a daemon on this machine listens at, from the host every bind uses. */
export function daemonUrl(port: number): string {
  return `http://${DEFAULT_DAEMON_HOST}:${port}`;
}

// The record a running daemon writes into the root of the tree, so a client
// finds a daemon that bound a port other than the default. The name and the
// shape live here because a client reads them and only the daemon writes them.

export const DAEMON_RECORD_FILE = "daemon.json";

/**
 * The directory the tree stands in, under the home. It repeats the engine's own
 * default because the engine does not depend on the protocol, and the clients
 * may not depend on the engine.
 */
export const TREE_DIRNAME = ".tasma";

/**
 * Where the daemon listens, which process to signal to stop it, and the token
 * every request of this run must carry. A daemon of an earlier version writes
 * no token, and its record still names its port.
 */
export type DaemonRecord = { port: number; pid: number; token?: string };

// The parse and the token rule are here, and the file I/O stays with each
// client, so the CLI and the dev proxy read one record in one way. This module
// imports nothing, because Node loads it directly from the Vite config.

const HIGHEST_PORT = 65535;

/**
 * The highest process id a signal can name. `process.kill` takes an `int32` and
 * refuses anything above it by type, and the record is a file any process that
 * can write the tree root may hold, so a larger value names nothing to signal.
 */
const HIGHEST_PROCESS_ID = 2_147_483_647;

const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

function isPortNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= HIGHEST_PORT;
}

/** A process a signal can be sent to. Zero names the caller's own group and a negative value names another. */
function isProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= HIGHEST_PROCESS_ID;
}

/**
 * Whether a value can go into an `Authorization` header as it is. A value with
 * a control character or a character above ASCII makes the header write throw
 * before the request is sent.
 */
export function isTokenText(value: string): boolean {
  return VISIBLE_ASCII.test(value);
}

/**
 * What the text of a record states, or `undefined` for every way it states
 * nothing: not JSON, not an object, or a port or a process id out of range.
 *
 * A token that no header can carry is read as no token, and the record still
 * names its port.
 */
export function parseDaemonRecord(text: string): DaemonRecord | undefined {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (typeof value !== "object" || value === null) return undefined;

  const { port, pid, token } = value as { port?: unknown; pid?: unknown; token?: unknown };
  if (!isPortNumber(port) || !isProcessId(pid)) return undefined;

  return typeof token === "string" && isTokenText(token) ? { port, pid, token } : { port, pid };
}

/**
 * The token of `record` for a call to `origin`: only where the record names that
 * address, so a listener on any other address never receives the token of a
 * live daemon. `localhost` and `[::1]` are other addresses, because the daemon
 * binds 127.0.0.1 alone and another user can bind the IPv6 loopback.
 */
export function recordTokenFor(record: DaemonRecord | undefined, origin: string): string | undefined {
  return record !== undefined && origin === daemonUrl(record.port) ? record.token : undefined;
}
