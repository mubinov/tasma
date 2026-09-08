import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { DAEMON_NAME } from "@tasma/protocol";
import type { DaemonRecord } from "@tasma/protocol";
import { onTestFinished } from "vitest";
import { readRecord, recordPath } from "../src/daemon/record.js";
import type { Command, Io, Source, Target } from "../src/types.js";

export type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

export type TestServer = { url: string; close: () => Promise<void> };

/** The version the health handler below reports, so a test asserts on one spelling. */
export const TEST_VERSION = "1.2.3";

/**
 * The streams a command used, its output collected as a test can assert on it.
 *
 * Text arrives as one chunk; a source is taken as it stands, which is how a case
 * states chunks of its own or a read that throws part way.
 */
export function capture(stdin: string | Source = ""): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdin: typeof stdin === "string" ? Readable.from([stdin]) : stdin,
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
    },
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
  // A handler that reads the request body is asynchronous, and the listener Node
  // takes returns nothing. A throw is answered rather than left to reject: an
  // unhandled rejection is reported against the whole run, while a 500 fails the
  // one test that was waiting and carries what went wrong to it.
  const server = createServer((request, response) => {
    void (async () => {
      try {
        await handle(request, response);
      } catch (error) {
        if (response.writableEnded) return;
        if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });

        response.end(error instanceof Error ? error.message : String(error));
      }
    })();
  });

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

/** A server answering `GET /health` with the envelope it is given. */
export function serveHealth(data: unknown): Handler {
  return (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, data, diagnostics: [] }));
  };
}

/** Answers every path as a Tasma daemon would answer `/health`. */
export const tasmaHealth: Handler = serveHealth({ name: DAEMON_NAME, version: TEST_VERSION });

/** A stand-in daemon: what it answers each call with, and the calls it received. */
export type Answers = { handle: Handler; seen: string[]; bodies: unknown[] };

/** What one call carried, parsed, or nothing where it carried no body at all. */
async function sentBody(request: IncomingMessage): Promise<unknown> {
  const raw = await text(request);

  return raw === "" ? undefined : (JSON.parse(raw) as unknown);
}

/** The call `attempt` proves an address with before it sends one that has to reach this tree's daemon. */
export const HEALTH = "GET /health";

/**
 * A server answering each `METHOD path` of a table with the envelope it holds,
 * and 404 with a refusal for every other call.
 *
 * The key carries the query as it arrived, so a test asserts the exact path a
 * verb built rather than only that it reached the route. `seen` is what proves a
 * verb sent no query at all, which no answer can show, and `bodies` the same for
 * what a write sent: aligned with `seen` by index, so a `null` a verb sent is
 * told apart from a key it left out.
 *
 * A table that states no health answer gets the one a Tasma daemon gives, since
 * a stand-in that answers no probe is one no write would reach. It is recorded
 * like any other call, so what a verb sent stays visible whole.
 */
export function serveAnswers(table: Record<string, unknown>): Answers {
  const seen: string[] = [];
  const bodies: unknown[] = [];

  return {
    seen,
    bodies,
    handle: async (request, response) => {
      const key = `${request.method ?? ""} ${request.url ?? ""}`;
      const envelope = table[key] ?? (key === HEALTH ? ok({ name: DAEMON_NAME, version: TEST_VERSION }) : undefined);
      const index = seen.push(key) - 1;

      bodies[index] = await sentBody(request);
      response.writeHead(envelope === undefined ? 404 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(envelope ?? {
        ok: false,
        error: { kind: "daemon", code: "route-not-found", message: `this test server answers no ${key}` },
      }));
    },
  };
}

/** The address the flag carried, as the target a command acts on. */
export function at(url: string): Target {
  return { kind: "explicit", url, stated: "--daemon" };
}

/** A success envelope, as a route answers one. */
export function ok(data: unknown, diagnostics: unknown[] = []): unknown {
  return { ok: true, data, diagnostics };
}

/** What one command wrote, the code it returned, and the calls the server saw. */
export type Ran = { code: number; out: string; err: string; seen: string[]; bodies: unknown[] };

/** Runs a command against a server answering the table, and reports what it wrote. */
export async function runCommand(
  command: Command,
  args: string[],
  table: Record<string, unknown>,
  options: { stdin?: string } = {},
): Promise<Ran> {
  const answers = serveAnswers(table);
  const server = await startServer(answers.handle);
  const { io, out, err } = capture(options.stdin);

  try {
    const code = await command.run(args, io, at(server.url));

    return { code, out: out.join(""), err: err.join(""), seen: answers.seen, bodies: answers.bodies };
  } finally {
    await server.close();
  }
}

/** The hint every usage failure ends with, which the line naming the fault stands before. */
export const HINT = "Run 'tasma --help' for usage.\n";

/** A directory removed with the test, so nothing a case writes outlives it or stands beside the sources. */
function madeUnder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

/** A tree of the test's own, removed with it, so nothing reads or writes the real home. */
export function treeHome(): string {
  return madeUnder("tasma-home-");
}

/** A directory of the test's own, for a case naming a path rather than writing one. */
export function scratchDir(): string {
  return madeUnder("tasma-scratch-");
}

/** A file holding the given bytes, in a directory of its own, and the path to it. */
export function scratchFile(content: string): string {
  const path = join(scratchDir(), "body.md");

  writeFileSync(path, content);

  return path;
}

/** Puts a record — or any text at all — under the name a daemon of that tree would write, and answers the path. */
export function seedRecord(home: string, content: DaemonRecord | string): string {
  const path = recordPath(home);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));

  return path;
}

/**
 * A process id no process can hold: every supported kernel caps its own far
 * below it. A seeded record names it so that nothing a test signals is a
 * process the test did not start.
 */
export const UNUSED_PID = 2_147_483_647;

/**
 * The stand-in daemon, set to run one scenario in this home, as the path a
 * `startDaemon` executable answers.
 *
 * The fake is ended with the test. Registered after `treeHome`, so it runs
 * before the home is removed and can still read the record naming the process.
 */
export function fakeDaemon(home: string, scenario: string): string {
  writeFileSync(join(home, "scenario"), scenario);

  onTestFinished(async () => {
    const record = await readRecord(recordPath(home));

    if (record === undefined || record.pid === UNUSED_PID) return;

    try {
      process.kill(record.pid, "SIGTERM");
    } catch {
      // Already gone, which is what the signal was for.
    }
  });

  return fileURLToPath(new URL("./fixtures/fake-daemon.ts", import.meta.url));
}
