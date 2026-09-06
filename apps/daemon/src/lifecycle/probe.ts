// Where a daemon on this machine is reached, and whether one answers there.
//
// The port is held by a process this daemon knows nothing about until it has
// replied, so every part of the call is bounded: the wait, the reply, and what
// is read off it.

import { createClient, DAEMON_NAME, DEFAULT_DAEMON_HOST } from "@tasma/protocol";
import type { Transport } from "@tasma/protocol";

/**
 * How long a probe waits. A loopback port either answers at once or refuses at
 * once; the budget bounds the one case that does neither, a process that
 * accepts the connection and never replies.
 */
const PROBE_TIMEOUT_MS = 1000;

/**
 * How much of a reply is read. A health answer is two short fields, and the
 * budget alone would let a process that holds the port send for a whole second.
 */
const PROBE_BODY_LIMIT = 64 * 1024;

/** The address a daemon on this machine listens at, from the host every bind uses. */
export function daemonUrl(port: number): string {
  return `http://${DEFAULT_DAEMON_HOST}:${port}`;
}

/**
 * The reply as JSON, refusing one longer than a health answer can be. The read
 * is a loop rather than one call so the length is known before the whole of it
 * is held; leaving the loop early cancels the stream, so the rest is never read.
 */
async function replyBody(response: Response): Promise<unknown> {
  // The body is typed as a stream of anything, and what a socket carries is bytes.
  const body = response.body as AsyncIterable<Uint8Array> | null;

  if (body === null) throw new Error("the reply carried no body");

  const decoder = new TextDecoder();
  let text = "";

  for await (const chunk of body) {
    text += decoder.decode(chunk, { stream: true });

    if (text.length > PROBE_BODY_LIMIT) throw new Error("the reply is longer than a health answer can be");
  }

  return JSON.parse(text) as unknown;
}

/**
 * Whether a Tasma daemon answers on this port.
 *
 * The reply is read through the contract's own client rather than by hand, so a
 * body that is no envelope answers `false` here instead of throwing somewhere
 * else. Any fault at all answers `false`.
 */
export async function daemonAnswers(port: number): Promise<boolean> {
  // Health is the one route this transport carries: a read, so it sends no body
  // and needs no media type.
  const transport: Transport = async ({ method, path }) => {
    const response = await fetch(`${daemonUrl(port)}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    return { status: response.status, body: await replyBody(response) };
  };

  try {
    const { data } = await createClient(transport).readHealth();
    // Read as the wire carries it: the envelope check reads no further than its
    // discriminant, so the answer is whatever the port sent.
    const answer = data as { name?: unknown } | null | undefined;

    return answer?.name === DAEMON_NAME;
  } catch {
    return false;
  }
}
