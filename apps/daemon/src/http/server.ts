// The server itself: one request in, one envelope out, and nothing a handler
// does can end the process.
//
// It is created here and started by its caller. The process-level exception
// hooks, the signal handlers and the shutdown belong to whoever owns the port,
// not here.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { routes } from "@tasma/protocol";
import type { Failure, Method } from "@tasma/protocol";
import { statusOf, toFailure } from "./failure.js";
import { readHealth } from "./health.js";
import { readBody, writeEnvelope } from "./json.js";
import { match } from "./router.js";
import type { RouteEntry } from "./router.js";

/** The names the daemon answers to. It binds the loopback address and no other. */
const SERVED_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * A daemon serving the entries it is given, and the liveness route in front of
 * them: every daemon answers `GET /health` whatever it was constructed with, so
 * no caller can forget it or replace it.
 */
export function createDaemonServer(entries: RouteEntry[]): Server {
  const served: RouteEntry[] = [{ route: routes.health, handler: readHealth }, ...entries];

  return createServer((request, response) => {
    // The last resort. `serve` answers with whatever it caught, and a throw from
    // writing that answer leaves the socket rather than the process.
    void serve(served, request, response).catch(() => {
      response.destroy();
    });
  });
}

/**
 * Whether the request was addressed to the daemon rather than sent to a name
 * that resolves to it.
 *
 * A page whose own domain resolves to the loopback address is same-origin with
 * the daemon: it needs no preflight, sets any content type it likes and reads
 * every reply, so neither the browser's origin rules nor the media type this
 * daemon requires refuses it. The host it addressed is what tells the two apart.
 */
function servesHost(host: string | undefined): boolean {
  if (host === undefined) return false;

  try {
    return SERVED_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/**
 * One request, start to finish, inside a single try/catch: nothing that can
 * throw sits outside it, and a rejected promise is covered by the same `await`.
 * Whatever is caught leaves as a reply, so one bad request cannot end the
 * process.
 */
async function serve(entries: RouteEntry[], request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (!servesHost(request.headers.host)) {
      const message = "a request must address the loopback address the daemon binds";
      refuse(request, response, { kind: "daemon", code: "malformed-request", message });
      return;
    }

    const found = match(request.method ?? "", request.url ?? "/", entries);
    if (!found.ok) {
      refuse(request, response, { kind: "daemon", code: found.code, message: found.message }, found.allow);
      return;
    }

    const body = await readBody(request);
    const success = await found.entry.handler({ params: found.params, query: found.query, body });
    writeEnvelope(response, 200, { ok: true, ...success });
  } catch (error) {
    refuse(request, response, toFailure(error));
  }
}

/** A refusal on the wire, where there is still a reply to be made. */
function refuse(request: IncomingMessage, response: ServerResponse, error: Failure, allow?: Method[]): void {
  // Two states leave nothing to answer: the client disconnected while its body
  // was being read, and a reply that failed part way out. Writing again would
  // send a second head or write to a dead socket, and either would throw inside
  // the block that is meant to be the last resort.
  if (response.destroyed || response.writableEnded || response.headersSent) {
    response.destroy();
    return;
  }

  // A body the daemon started reading and stopped leaves the parser stalled part
  // way through a message, so the connection can carry nothing after it. Naming
  // it closed is what stops the caller sending on a socket that is spent. A body
  // never read is not stalled: Node discards it once the reply is out, and the
  // connection stays usable.
  if (request.readableDidRead && !request.complete) response.setHeader("connection", "close");

  writeEnvelope(response, statusOf(error), { ok: false, error }, allow);
}
