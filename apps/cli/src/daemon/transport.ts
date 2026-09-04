import { createClient, DEFAULT_DAEMON_URL } from "@tasma/protocol";
import type { Client, Transport } from "@tasma/protocol";

/** Written as URL.hostname reports them: an IPv6 literal keeps its brackets. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** How much of a refused address is quoted back: the refusal is a line, not a payload. */
const QUOTED_LIMIT = 120;

/** Everything before the first of the given marks, or all of it where none appears. */
function upTo(text: string, ...marks: string[]): string {
  const found = marks.map((mark) => text.indexOf(mark)).filter((index) => index !== -1);

  return found.length === 0 ? text : text.slice(0, Math.min(...found));
}

/**
 * A refused address as much as it can be quoted back: the scheme and the host,
 * and nothing behind them.
 *
 * The refusal reaches a CI log, scrollback or a pasted report, and it fires by
 * definition on the addresses this CLI does not accept — a tunnel or a proxy
 * recipe, which is where a token rides, in the userinfo, in a query parameter or
 * in a path segment. None of those decides the refusal: the scheme and the host
 * are what was wrong with the value and are all the reader needs to recognise
 * it.
 *
 * A parsed address is read off the URL, which knows where its own authority
 * ends. An unparsable one does not have that boundary, and an `@` in it can be
 * userinfo in front of a host or a path segment behind one — cutting for either
 * spelling quotes the other's secret — so where one appears the scheme is all
 * that is shown, and nothing at all where there is no scheme either. That `@`
 * is looked for over the whole remainder before anything is cut away: `?` and
 * `#` are ordinary password characters, so cutting at one first can take the
 * delimiter with it and leave the userinfo looking like a host.
 */
function quotableAddress(refused: string | URL): string {
  let quoted: string;

  if (typeof refused !== "string") {
    // Not `origin`, which is the string "null" for every scheme but a special
    // one. A scheme with no authority is followed by an opaque path, the whole
    // of which is the value's own.
    quoted = refused.host === "" ? refused.protocol : `${refused.protocol}//${refused.host}`;
  } else {
    const scheme = refused.indexOf("://");
    const prefix = scheme === -1 ? "" : refused.slice(0, scheme + 3);
    const asked = refused.slice(prefix.length);

    // A backslash ends the authority for a special scheme as a slash does.
    quoted = asked.includes("@") ? prefix : prefix + upTo(asked, "/", "\\", "?", "#");
  }

  return quoted.length <= QUOTED_LIMIT ? quoted : `${quoted.slice(0, QUOTED_LIMIT)}...`;
}

/**
 * Where to reach the daemon: the flag, then `TASMA_DAEMON_URL`, then the
 * built-in default. Both channels arrive as parameters, so nothing below the
 * entry point reads a global.
 *
 * An empty value is no value: an exported-but-empty variable is an ordinary
 * shell and CI shape, and refusing it would name no address to act on.
 *
 * A stated value is validated whichever channel stated it, and a bad one throws
 * for the caller to report as a usage error: `--daemon nonsense` is a typo in
 * the command rather than a daemon that is down, and conflating them sends
 * somebody hunting a process that was never addressed.
 *
 * Only `http:` on a loopback host is accepted — the set the daemon itself
 * serves. Tasma has no authentication, so any other host would receive task
 * content and be believed on the answer; a remote daemon reached through an SSH
 * tunnel is still loopback locally, so nothing legitimate is refused.
 */
export function resolveDaemonUrl(flag: string | undefined, env: Record<string, string | undefined>): string {
  const stated = [flag, env.TASMA_DAEMON_URL].find((value) => value !== undefined && value !== "");

  if (stated === undefined) {
    return DEFAULT_DAEMON_URL;
  }

  let url: URL;
  try {
    url = new URL(stated);
  } catch {
    // Empty where the value holds nothing that can be quoted safely; the fault
    // is still named, and the reader typed the value.
    const quoted = quotableAddress(stated);

    throw new Error(quoted === "" ? "not a daemon address" : `not a daemon address: ${quoted}`);
  }

  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`a daemon address is http: on 127.0.0.1, [::1] or localhost: ${quotableAddress(url)}`);
  }

  // The origin alone, which normalises away a trailing slash — otherwise
  // `${base}${path}` produces //health — along with the case and a redundant :80.
  return url.origin;
}

/** One call's budget. A fresh signal per request, so it is not a process-wide deadline. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** A call that ran out of time, carrying the budget it ran out of so the report cannot name another. */
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`no answer within ${timeoutMs} ms`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The two names an aborted request rejects under, whichever of the headers and the body it stalled in. */
function ranOutOfTime(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}

async function readJson(response: Response, timeoutMs: number): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    // A stall after the headers is the budget running out, not a body that is
    // not JSON, and swallowing it would report a timeout as a foreign answer.
    if (ranOutOfTime(cause)) throw new RequestTimeoutError(timeoutMs);

    // Anything else is swallowed, so a body that is not JSON reaches the caller
    // as "answered with no envelope" rather than "reached no daemon".
    return undefined;
  }
}

/**
 * Every status comes back, 4xx and 5xx included: the daemon's body is
 * authoritative and its status advisory, so the envelope goes to `createClient`
 * and only a call that reached no server rejects.
 *
 * A redirect is refused rather than followed. `resolveDaemonUrl` accepts a
 * loopback host alone, and following a redirect would leave that governing the
 * first hop only, carrying the body to whatever host the answer named.
 *
 * Nothing in production passes `timeoutMs`; it is there so the budget can be
 * driven in milliseconds.
 */
export function createFetchTransport(baseUrl: string, timeoutMs = REQUEST_TIMEOUT_MS): Transport {
  return async ({ method, path, body }) => {
    let response: Response;

    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        // The daemon requires the media type on a write and ignores it on a read.
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw ranOutOfTime(cause) ? new RequestTimeoutError(timeoutMs) : cause;
    }

    return { status: response.status, body: await readJson(response, timeoutMs) };
  };
}

export function createDaemonClient(url: string): Client {
  return createClient(createFetchTransport(url));
}
