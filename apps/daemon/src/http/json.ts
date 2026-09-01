// The two ends of one request: the body as a value, and the envelope as bytes.
//
// This layer does not inspect content. It does not check that a body is an
// object and it does not know which route needs one: a route that requires a
// field refuses with the engine's own code, which reads better than anything
// written here.

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { Envelope, Method } from "@tasma/protocol";
import { DaemonError, causeOf } from "./failure.js";

/** The largest body the daemon reads, in bytes. */
export const BODY_LIMIT = 8 * 1024 * 1024;

const MEDIA_TYPE = "application/json";

/**
 * The methods that may carry a body. Every one of them must declare the media
 * type, whether or not a body follows: a page cannot set this content type on a
 * cross-origin request without a preflight, which a form or an image request
 * never sends.
 */
const CARRIES_BODY = ["POST", "PATCH"];

/** The media type alone, so a charset parameter does not change what was sent. */
function mediaTypeOf(header: string | undefined): string {
  const [type = ""] = (header ?? "").split(";");
  return type.trim().toLowerCase();
}

/**
 * The body as a value, `undefined` where the request carries none.
 *
 * The cap is enforced twice. A declared length over it is refused before a byte
 * is read, which is the cheap path; a chunked body declares no length, so the
 * running count is checked as each chunk arrives and reading stops the moment it
 * passes. The daemon never holds more than the limit.
 */
export async function readBody(request: IncomingMessage): Promise<unknown> {
  const method = request.method ?? "";

  if (!CARRIES_BODY.includes(method)) {
    // Consumed on a path this code controls, rather than left to Node's own
    // discard once the response has finished.
    request.resume();
    return undefined;
  }

  if (mediaTypeOf(request.headers["content-type"]) !== MEDIA_TYPE) {
    throw new DaemonError("unsupported-media-type", `${method} must declare content-type: ${MEDIA_TYPE}`);
  }

  const declared = Number(request.headers["content-length"]);
  if (declared > BODY_LIMIT) {
    throw new DaemonError("request-too-large", `a body of ${declared} bytes is over the ${BODY_LIMIT} byte limit`);
  }

  const text = await collect(request);
  if (text.length === 0) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new DaemonError("malformed-request", `the request body is not JSON: ${causeOf(cause)}`);
  }
}

async function collect(request: IncomingMessage): Promise<string> {
  // Leaving the loop must not destroy the request: destroying it takes the
  // socket with it, and a refusal raised here is still to be written on that
  // socket. Reading simply stops, which is what bounds what is held.
  const stream = request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>;
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > BODY_LIMIT) {
      request.pause();
      throw new DaemonError("request-too-large", `a body over the ${BODY_LIMIT} byte limit`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One reply, head and body together.
 *
 * The body is serialized before the head is written: `JSON.stringify` can throw
 * on a value JSON cannot carry, and once a status has gone out there is no way
 * left to report that it failed.
 */
export function writeEnvelope(
  response: ServerResponse,
  status: number,
  envelope: Envelope<unknown>,
  allow?: Method[],
): void {
  const body = Buffer.from(JSON.stringify(envelope), "utf8");

  const headers: OutgoingHttpHeaders = {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    // A task read once must not be served again from a cache the daemon cannot see.
    "cache-control": "no-store",
    // The body is JSON whatever a reader guesses from its content.
    "x-content-type-options": "nosniff",
  };
  if (allow !== undefined) headers.allow = allow.join(", ");

  response.writeHead(status, headers);
  response.end(body);
}
