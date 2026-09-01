import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";
import type { RouteEntry } from "../src/http/router.js";
import { createDaemonServer } from "../src/http/server.js";

export type TestServer = { url: string; close(): Promise<void> };

/**
 * A daemon listening on a port the operating system issued, so parallel test
 * files never collide. It is closed when the test ends, whether or not the test
 * closes it itself.
 */
export async function startTestServer(entries: RouteEntry[]): Promise<TestServer> {
  const server = createDaemonServer(entries);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    // An idle keep-alive socket would hold the run open past the test, and
    // `close` returns the server rather than a promise, so the wait is the event.
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
  onTestFinished(close);

  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close };
}
