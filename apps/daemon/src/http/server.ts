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
 * What a request may declare it came from. A browser states this on every
 * request it sends, the ones that need no preflight included; a caller that is
 * no browser states nothing, which is every local process the daemon is for.
 */
const SERVED_SITES = new Set<unknown>([undefined, "none", "same-origin"]);

/** How long the rest of a refused body may keep arriving before the daemon cuts the connection. */
const DISCARD_LIMIT_MS = 5000;

export type DaemonServerOptions = {
  /**
   * How long the rest of a refused body may keep arriving, in milliseconds. It
   * is an option so that a test can see a client that does not stop cut off,
   * rather than wait out the limit.
   */
  discardLimitMs?: number;
};

/**
 * A daemon serving the entries it is given, and the liveness route in front of
 * them: every daemon answers `GET /health` whatever it was constructed with, so
 * no caller can forget it or replace it.
 */
export function createDaemonServer(entries: RouteEntry[], options: DaemonServerOptions = {}): Server {
  const served: RouteEntry[] = [{ route: routes.health, handler: readHealth }, ...entries];
  const discardLimitMs = options.discardLimitMs ?? DISCARD_LIMIT_MS;

  /**
   * One request, start to finish, inside a single try/catch: nothing that can
   * throw sits outside it, and a rejected promise is covered by the same `await`.
   * Whatever is caught leaves as a reply, so one bad request cannot end the
   * process.
   */
  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!servesHost(request.headers.host)) {
        const message = "a request must address the loopback address the daemon binds";
        refuse(request, response, { kind: "daemon", code: "malformed-request", message });
        return;
      }

      if (!servesSite(request.headers["sec-fetch-site"])) {
        const message = "a request must not be sent by a page on another site";
        refuse(request, response, { kind: "daemon", code: "malformed-request", message });
        return;
      }

      const found = match(request.method ?? "", request.url ?? "/", served);
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

    // A body never read is left to Node, which discards it once the reply is out.
    if (request.readableDidRead && !request.complete) discardRest(request, discardLimitMs);

    writeEnvelope(response, statusOf(error), { ok: false, error }, allow);
  }

  return createServer((request, response) => {
    // The last resort. `serve` answers with whatever it caught, and a throw from
    // writing that answer leaves the socket rather than the process.
    void serve(request, response).catch(() => {
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
 * Whether the request came from somewhere the daemon serves.
 *
 * The media type the writes require keeps a page off them: it cannot be set on a
 * cross-origin request without a preflight. A `GET` carrying one query key needs
 * no preflight, so a page can send it and drive what the route does — the
 * resolution reads the filesystem at the path it is given — however little of the
 * reply the browser lets it read back. This is what refuses that.
 */
function servesSite(site: string | string[] | undefined): boolean {
  return SERVED_SITES.has(site);
}

/**
 * Reads the rest of a body the daemon stopped reading, and drops it.
 *
 * A close while the client still sends resets the connection before the client
 * reads the refusal. Discarding lets the client finish and read it; the limit
 * cuts a client that does not stop.
 */
function discardRest(request: IncomingMessage, limitMs: number): void {
  const { socket } = request;
  const cut = setTimeout(() => socket.destroy(), limitMs);
  cut.unref();

  // Both listeners go on either path: a socket kept alive carries later
  // requests, and would otherwise collect one `close` listener per refusal.
  const settle = (): void => {
    clearTimeout(cut);
    request.off("end", settle);
    socket.off("close", settle);
  };
  request.once("end", settle);
  socket.once("close", settle);

  request.resume();
}
