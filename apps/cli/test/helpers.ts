import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Io } from "../src/types.js";

export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export type TestServer = { url: string; close: () => Promise<void> };

/** The streams a command wrote to, collected as a test can assert on them. */
export function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } },
    out,
    err,
  };
}

/**
 * A server the CLI owns, on an ephemeral port: a test never collides with a real
 * daemon on the default port, nor with another test running beside it.
 *
 * `apps/cli` may not import `@tasma/daemon`, so every proof against a live
 * server is against this one.
 */
export async function startServer(handle: Handler): Promise<TestServer> {
  const server = createServer(handle);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server reported no port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // A handler that never answers holds its socket open, and close() waits
        // for it forever without this.
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

/** A closed port on the loopback address, for the case where nothing answers. */
export async function unusedUrl(): Promise<string> {
  const server = await startServer(() => {});
  const { url } = server;
  await server.close();
  return url;
}
