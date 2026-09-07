import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_NAME } from "@tasma/protocol";
import type { DaemonRecord } from "@tasma/protocol";
import { onTestFinished } from "vitest";
import { readRecord, recordPath } from "../src/daemon/record.js";
import type { Command, Io, Target } from "../src/types.js";

export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export type TestServer = { url: string; close: () => Promise<void> };

/** The version the health handler below reports, so a test asserts on one spelling. */
export const TEST_VERSION = "1.2.3";

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
export type Answers = { handle: Handler; seen: string[] };

/**
 * A server answering each `METHOD path` of a table with the envelope it holds,
 * and 404 with a refusal for every other call.
 *
 * The key carries the query as it arrived, so a test asserts the exact path a
 * verb built rather than only that it reached the route. `seen` is what proves a
 * verb sent no query at all, which no answer can show.
 */
export function serveAnswers(table: Record<string, unknown>): Answers {
  const seen: string[] = [];

  return {
    seen,
    handle: (request, response) => {
      const key = `${request.method ?? ""} ${request.url ?? ""}`;
      const envelope = table[key];

      seen.push(key);
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
export type Ran = { code: number; out: string; err: string; seen: string[] };

/** Runs a command against a server answering the table, and reports what it wrote. */
export async function runCommand(command: Command, args: string[], table: Record<string, unknown>): Promise<Ran> {
  const answers = serveAnswers(table);
  const server = await startServer(answers.handle);
  const { io, out, err } = capture();

  try {
    const code = await command.run(args, io, at(server.url));

    return { code, out: out.join(""), err: err.join(""), seen: answers.seen };
  } finally {
    await server.close();
  }
}

/** A tree of the test's own, removed with it, so nothing reads or writes the real home. */
export function treeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tasma-home-"));

  onTestFinished(() => {
    rmSync(home, { recursive: true, force: true });
  });

  return home;
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
