import type { Transport } from "@tasma/protocol";

// Injected by vite.config.ts from the same value the proxy targets. Shown to a
// person when the daemon cannot be reached; never used to build a request.
declare const __DAEMON_URL__: string;

export const DAEMON_URL = __DAEMON_URL__;

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // A proxy with nothing behind it answers HTML. Swallowed, that reaches the
    // caller as "answered with no envelope" rather than "reached no daemon".
    return undefined;
  }
}

/**
 * Every status comes back, 4xx and 5xx included: the daemon's body is
 * authoritative and its status advisory, so the envelope goes to `createClient`
 * and only a `fetch` that never reached a server rejects.
 */
export function createFetchTransport(basePath: string): Transport {
  return async ({ method, path, body }) => {
    const response = await fetch(`${basePath}${path}`, {
      method,
      // The daemon requires the media type on a write and ignores it on a read,
      // where it would only cost a preflight wherever the call is not
      // same-origin.
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return { status: response.status, body: await readJson(response) };
  };
}
