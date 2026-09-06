import { once } from "node:events";
import { chmod } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { daemonAnswers } from "../../src/lifecycle/probe.js";
import { readRecord, recordPath } from "../../src/lifecycle/record.js";
import { runDaemon, startDaemon } from "../../src/lifecycle/run.js";
import type { DaemonIo, Start } from "../../src/lifecycle/run.js";
import { foreignPort, freePort, projectsRoot, seedRecord, startTestServer, until } from "../helpers.js";

type Serving = Extract<Start, { started: true }>;

/** The events a daemon installs a handler on, so a test counts what stands on them. */
const HANDLED = ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection"];

/** A handler as a test calls it: the process types each event's own arguments. */
type Handler = (...args: unknown[]) => void;

/**
 * What stands on one event. Read through the emitter, which takes a name of any
 * shape: the process types `listeners` for its signals alone.
 */
function installedOn(event: string): Handler[] {
  return (process as NodeJS.EventEmitter).listeners(event) as Handler[];
}

function installed(): Handler[] {
  return HANDLED.flatMap(installedOn);
}

/** The streams the daemon wrote to, collected as a test can assert on them. */
function capture(): { io: DaemonIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];

  return {
    io: { stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } },
    out,
    err,
  };
}

/** A real daemon over a temp tree, stopped when the test ends. */
async function daemonOn(root: string, options: { port?: number; drainMs?: number } = {}): Promise<Serving> {
  const start = await startDaemon({ port: options.port ?? 0, root, drainMs: options.drainMs });
  if (!start.started) throw new Error(start.message);
  onTestFinished(() => start.stop());

  return start;
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

/** The arm a start that did not start carries. */
function refusal(start: Start): { code: number; message: string } {
  if (start.started) throw new Error(`the daemon started at ${start.url}`);

  return start;
}

/**
 * The one start of two that serves, with the other asserted to have stood down
 * to it. Which of the two wins is the race the test is about.
 */
function onlyServing(starts: Start[]): Serving {
  const serving = starts.find((start): start is Serving => start.started);
  const stood = starts.find((start) => !start.started);

  if (serving === undefined || stood === undefined) throw new Error("both starts came to the same end");
  onTestFinished(() => serving.stop());

  expect(refusal(stood).code).toBe(0);
  expect(refusal(stood).message).toContain(serving.url);

  return serving;
}

/** The address a running daemon reported, from the one line it wrote. */
function reportedPort(line: string): number {
  const found = /at http:\/\/127\.0\.0\.1:(\d+)\n$/.exec(line);
  if (found === null) throw new Error(`no address in ${JSON.stringify(line)}`);

  return Number(found[1]);
}

/** A daemon under `runDaemon`, held at the point where it has reported its address. */
async function running(root: string, argv: string[] = ["--port", "0"]): Promise<{
  code: Promise<number>;
  port: number;
  out: string[];
  err: string[];
}> {
  const { out, err, io } = capture();
  const code = runDaemon(argv, io, {}, root);
  // A test that fails before it signals would otherwise leave the daemon holding
  // the worker open and its fault handlers standing over every later test.
  onTestFinished(async () => {
    process.emit("SIGINT");
    await code;
  });
  await until(() => out.length > 0, "the daemon reported the address it bound");

  return { code, port: reportedPort(out.join("")), out, err };
}

describe("starting a daemon", () => {
  it("serves on the port it bound, and records where it listens", async () => {
    const root = await projectsRoot("ONE");
    const start = await daemonOn(root);
    const port = portOf(start.url);

    expect(await daemonAnswers(port)).toBe(true);
    expect(await readRecord(root)).toEqual({ port, pid: process.pid });
  });

  it("finds the daemon already serving this tree and binds nothing", async () => {
    const root = await projectsRoot();
    const first = await daemonOn(root);

    const second = refusal(await startDaemon({ port: 0, root }));

    expect(second.code).toBe(0);
    expect(second.message).toContain(first.url);
  });

  it("ends at the probe whatever port was asked for", async () => {
    const root = await projectsRoot();
    await daemonOn(root);

    // A port this process could never bind, so a start that reached the bind fails here.
    const second = refusal(await startDaemon({ port: 1, root }));

    expect(second.code).toBe(0);
  });

  it("overwrites a record whose port answers nothing", async () => {
    const root = await projectsRoot();
    await seedRecord(root, { port: await freePort(), pid: 4242 });

    const start = await daemonOn(root);

    expect(await readRecord(root)).toEqual({ port: portOf(start.url), pid: process.pid });
  });

  it("overwrites a record naming the very port it binds", async () => {
    const root = await projectsRoot();
    // What an ungraceful death leaves on the default port: the record names the
    // port the next start binds, so a probe of it would be answered by that
    // start itself.
    const port = await freePort();
    await seedRecord(root, { port, pid: 4242 });

    const start = await daemonOn(root, { port });

    expect(portOf(start.url)).toBe(port);
    expect(await readRecord(root)).toEqual({ port, pid: process.pid });
  });

  it("lets one of two starts racing for the same tree serve it", async () => {
    const root = await projectsRoot();

    const starts = await Promise.all([startDaemon({ port: 0, root }), startDaemon({ port: 0, root })]);

    expect(await readRecord(root)).toEqual({ port: portOf(onlyServing(starts).url), pid: process.pid });
  });

  it("lets one of two starts racing to clear a record left behind serve the tree", async () => {
    const root = await projectsRoot();
    await seedRecord(root, { port: await freePort(), pid: 4242 });

    const starts = await Promise.all([startDaemon({ port: 0, root }), startDaemon({ port: 0, root })]);

    expect(await readRecord(root)).toEqual({ port: portOf(onlyServing(starts).url), pid: process.pid });
  });

  it("refuses a port another process holds", async () => {
    const port = await foreignPort('"hello"');

    const start = refusal(await startDaemon({ port, root: await projectsRoot() }));

    expect(start.code).toBe(1);
    expect(start.message).toContain(String(port));
  });

  it("stands down where the process holding the port is a daemon", async () => {
    const other = await startTestServer([]);

    const start = refusal(await startDaemon({ port: portOf(other.url), root: await projectsRoot() }));

    expect(start.code).toBe(0);
    expect(start.message).toContain(other.url);
  });

  it("reports a port that cannot be bound at all", async () => {
    const start = refusal(await startDaemon({ port: 70_000, root: await projectsRoot() }));

    expect(start.code).toBe(1);
    expect(start.message).toContain("70000");
  });

  it("reports a record it cannot write, and serves nothing", async () => {
    const root = join(await projectsRoot(), "file", "tree");

    const start = refusal(await startDaemon({ port: 0, root }));

    expect(start.code).toBe(1);
    expect(start.message).toContain(recordPath(root));
  });
});

describe("stopping a daemon", () => {
  it("closes every open index, however many times it is stopped", async () => {
    const root = await projectsRoot("ONE");
    const start = await daemonOn(root);

    // The second call joins the first rather than starting another shutdown.
    await Promise.all([start.stop(), start.stop()]);

    await expect(start.host.list()).rejects.toMatchObject({ code: "index-closed" });
  });

  it("closes a request that outlives the drain deadline", async () => {
    const start = await daemonOn(await projectsRoot("ONE"), { drainMs: 50 });
    const port = portOf(start.url);
    const socket = connect(port, "127.0.0.1");
    onTestFinished(() => void socket.destroy());
    await once(socket, "connect");

    // Headers complete and a body that never finishes: the request is running,
    // so the drain waits on it rather than closing the connection as idle.
    const request = [
      "POST /projects/ONE/tasks HTTP/1.1",
      `host: 127.0.0.1:${port}`,
      "content-type: application/json",
      "content-length: 64",
      "",
      "{",
    ].join("\r\n");
    await new Promise<void>((resolve) => socket.write(request, () => resolve()));
    // A round trip on another connection, so the daemon has read the one above.
    expect(await daemonAnswers(port)).toBe(true);

    const began = performance.now();
    await start.stop();

    expect(performance.now() - began).toBeGreaterThanOrEqual(50);
  });
});

describe("the daemon as a process", () => {
  it("reports the address it bound, and answers a signal by stopping", async () => {
    const root = await projectsRoot("ONE");
    const before = installed();

    const daemon = await running(root);

    expect(daemon.out.join("")).toMatch(/^tasma-daemon \d+\.\d+\.\d+ at http:\/\/127\.0\.0\.1:\d+\n$/);
    expect(await readRecord(root)).toEqual({ port: daemon.port, pid: process.pid });
    expect(installed().length - before.length, "one handler per signal and per fault").toBe(5);

    // Twice, as a terminal sends it. The handlers stand until the shutdown has
    // run, because removing the last one restores the signal's own disposition
    // and the second would then end the process outright.
    process.emit("SIGINT");
    expect(installed().length - before.length, "the handlers stand through the shutdown").toBe(5);
    process.emit("SIGINT");

    expect(await daemon.code).toBe(0);
    expect(await readRecord(root)).toBeUndefined();
    expect(await daemonAnswers(daemon.port)).toBe(false);
    expect(installed().length, "every handler is removed once it has stopped").toBe(before.length);
  });

  it("reports an uncaught exception, stops, and fails", async () => {
    const root = await projectsRoot();
    const before = installedOn("uncaughtException");
    const daemon = await running(root);

    // Called rather than emitted, so vitest's own handler does not report a
    // fault this test raised on purpose.
    const [handler] = installedOn("uncaughtException").filter((listener) => !before.includes(listener));
    handler!(new Error("a defect"), "uncaughtException");

    expect(await daemon.code).toBe(1);
    expect(daemon.err).toEqual(["tasma-daemon: a defect\n"]);
    expect(await readRecord(root)).toBeUndefined();
  });

  it("reports a rejection nothing handled, whatever it carries", async () => {
    const root = await projectsRoot();
    const before = installedOn("unhandledRejection");
    const daemon = await running(root);

    const [handler] = installedOn("unhandledRejection").filter((listener) => !before.includes(listener));
    handler!("no reason at all", Promise.resolve());

    expect(await daemon.code).toBe(1);
    expect(daemon.err).toEqual(["tasma-daemon: no reason at all\n"]);
  });

  it("reports a shutdown that fails, and fails with it", async () => {
    const root = await projectsRoot();
    const daemon = await running(root);

    // The record can be read and not removed, which is what a shutdown meets on
    // a tree it no longer has write access to.
    await chmod(root, 0o500);
    onTestFinished(() => chmod(root, 0o700));

    process.emit("SIGINT");

    expect(await daemon.code).toBe(1);
    expect(daemon.err.join("")).toMatch(/^tasma-daemon: /);
  });

  it("refuses a bad port, and an option it does not take, without binding", async () => {
    const root = await projectsRoot();
    const bad = capture();
    const unknown = capture();

    expect(await runDaemon(["--port", "nonsense"], bad.io, {}, root)).toBe(1);
    expect(await runDaemon(["--nonsense"], unknown.io, {}, root)).toBe(1);

    expect(bad.err).toEqual(['tasma-daemon: --port must be a whole number from 0 to 65535: "nonsense"\n']);
    expect(unknown.err.join("")).toMatch(/^tasma-daemon: .*--nonsense/);
    expect(bad.out).toEqual([]);
    expect(await readRecord(root)).toBeUndefined();
  });

  it("writes one line for an argument carrying a break, whatever the break is", async () => {
    const { err, io } = capture();

    expect(await runDaemon(["--forged\nline\u2028break"], io, {}, await projectsRoot())).toBe(1);

    expect(err).toHaveLength(1);
    expect(err[0]).toContain("--forged\\u000aline\\u2028break");
    expect(err[0]!.indexOf("\n")).toBe(err[0]!.length - 1);
  });

  it("reports a daemon already serving the tree, and stands down", async () => {
    const root = await projectsRoot();
    const first = await daemonOn(root);
    const { err, io, out } = capture();

    expect(await runDaemon(["--port", "0"], io, {}, root)).toBe(0);

    expect(err).toEqual([`tasma-daemon: a daemon is already serving this tree at ${first.url}\n`]);
    expect(out).toEqual([]);
  });
});
