// The daemon as a process: what it takes to start one, what it takes to stop
// one, and the wiring that turns a signal into an exit code.
//
// The two are split because the sequence and the process are separable: the
// sequence takes its port and its tree as arguments, installs no handler and
// writes to no stream, and the wiring around it owns the arguments, the streams
// and the exit code.

import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { DAEMON_NAME, DEFAULT_DAEMON_HOST, printable } from "@tasma/protocol";
import type { DaemonRecord } from "@tasma/protocol";
import manifest from "../../package.json" with { type: "json" };
import { causeOf } from "../http/failure.js";
import { createDaemonServer } from "../http/server.js";
import { createProjectHost } from "../projects/host.js";
import type { ProjectHost } from "../projects/host.js";
import { projectRoutes } from "../projects/routes.js";
import { taskRoutes } from "../tasks/routes.js";
import { resolveDaemonPort } from "./port.js";
import { daemonAnswers, daemonUrl } from "./probe.js";
import { claimRecord, readRecord, recordPath, removeRecord } from "./record.js";

/** How long a shutdown waits for requests already running before it closes their connections. */
const DRAIN_MS = 5000;

/** The signals a shutdown answers. A closed terminal sends `SIGHUP`, whose default ends the process outright. */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * What a start came to. The started arm carries the host as well as the stop
 * handle, so a caller can prove the shutdown closed it; nothing in this module
 * reads it.
 *
 * The daemon has two exit codes and no more. Zero means a Tasma daemon is
 * serving, whether this process started it or stood down to one already there;
 * one means none is. A daemon found through the record or the claim serves this
 * tree; one found holding the requested port answers for that port alone, since
 * `Health` states a name and a version and no tree.
 */
export type Start
  = | { started: true; url: string; host: ProjectHost; stop: () => Promise<void> }
    | { started: false; code: number; message: string };

/** Anything a byte can be written to. Structural, so a test collects what a stream would print. */
export type Sink = { write(text: string): unknown };

export type DaemonIo = { stdout: Sink; stderr: Sink };

/** One line under the daemon's name, carrying nothing a reader of it acts on. */
function line(text: string): string {
  return `${DAEMON_NAME}: ${printable(text)}\n`;
}

/**
 * Binds the port, resolving on the event and rejecting on the fault. The fault
 * listener is attached whichever way it goes, which is also what stops a bind
 * failure reaching the process-level hooks as an uncaught exception.
 */
async function bind(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.removeListener("error", reject);
      resolve();
    });
    server.listen(port, DEFAULT_DAEMON_HOST);
  });
}

/** What a listen fault comes to: a daemon already on the port, another process on it, or a port that is unusable. */
async function bindFailure(error: unknown, port: number): Promise<Start> {
  // Something took the port between the probe and the bind. Which process it is
  // decides the answer, so the port is probed once.
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    return (await daemonAnswers(port))
      ? { started: false, code: 0, message: `a daemon is already serving at ${daemonUrl(port)}` }
      : { started: false, code: 1, message: `another process holds port ${port}` };
  }

  return { started: false, code: 1, message: `port ${port} cannot be bound: ${causeOf(error)}` };
}

/**
 * Stops the server answering, waiting `drainMs` for the requests already running
 * and then closing what is left.
 *
 * An idle keep-alive socket carries no request, so it is closed at once and the
 * wait is only ever on work that is actually running. The timer is cleared on
 * the other outcome, so it never holds the loop open.
 */
async function drain(server: Server, drainMs: number): Promise<void> {
  const closed = once(server, "close");
  server.close();
  server.closeIdleConnections();
  const timer = setTimeout(() => server.closeAllConnections(), drainMs);

  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One daemon over one tree.
 *
 * The order is the design. The probe precedes the bind, so a daemon holding
 * another port is still found; the bind precedes the claim, so the record only
 * ever describes a daemon that holds a port.
 *
 * The requested port does not enter the probe. A daemon answering on the
 * recorded port ends the start whether or not another port was asked for,
 * because the rule is one daemon per tree and not one daemon per port: the write
 * queue that orders overlapping writes is per process, so two processes over one
 * tree would order nothing.
 */
export async function startDaemon(options: {
  port: number;
  root?: string;
  /** How long the shutdown waits for requests already running, in milliseconds. */
  drainMs?: number;
}): Promise<Start> {
  const { port, root } = options;
  const drainMs = options.drainMs ?? DRAIN_MS;
  const pid = process.pid;

  const record = await readRecord(root);

  // The recorded process id is never consulted, which is what makes process-id
  // reuse unable to mislead the answer.
  if (record !== undefined && (await daemonAnswers(record.port))) {
    return { started: false, code: 0, message: `a daemon is already serving this tree at ${daemonUrl(record.port)}` };
  }

  const host = createProjectHost({ root });
  const server = createDaemonServer([...projectRoutes(host), ...taskRoutes(host)]);

  async function closeServing(): Promise<void> {
    await drain(server, drainMs);
    // The daemon never calls process.exit, so an index left open would hold its
    // watch handle and the process would never end.
    await host.close();
  }

  try {
    await bind(server, port);
  } catch (error) {
    await host.close();

    return await bindFailure(error, port);
  }

  // The port the server reports rather than the one that was asked for, so a
  // start on port zero records the number the operating system chose.
  const mine: DaemonRecord = { port: (server.address() as AddressInfo).port, pid };

  // A record naming the port this process holds describes no other daemon: the
  // probe would be answered by this process itself, and a record an ungraceful
  // death left behind would then stop the daemon starting for good.
  const elsewhere = async (candidate: number) => candidate !== mine.port && (await daemonAnswers(candidate));

  let held: DaemonRecord | undefined;

  try {
    held = await claimRecord(root, mine, elsewhere);
  } catch (error) {
    // Not passed over: a daemon nothing can find is worse than no daemon.
    await closeServing();

    return { started: false, code: 1, message: `${recordPath(root)} cannot be written: ${causeOf(error)}` };
  }

  if (held !== undefined) {
    // Another start took the tree between the probe and the claim. Its record
    // stands, so this one closes without touching it.
    await closeServing();

    return { started: false, code: 0, message: `a daemon is already serving this tree at ${daemonUrl(held.port)}` };
  }

  let stopping: Promise<void> | undefined;

  async function shutDown(): Promise<void> {
    await closeServing();
    await removeRecord(root, pid);
  }

  return {
    started: true,
    url: daemonUrl(mine.port),
    host,
    // A second call joins the first rather than starting another shutdown.
    stop: () => (stopping ??= shutDown()),
  };
}

/**
 * Holds until a signal or a fault ends the daemon, and answers the code that end
 * carries.
 *
 * The handlers stand until the shutdown has run, and a second end reaches the
 * guard instead: removing the last listener of a signal restores Node's own
 * disposition for it, so a terminal's second Ctrl-C during the drain would
 * otherwise end the process outright, leaving the indexes open and the record
 * behind. A shutdown that itself throws resolves here rather than escaping as a
 * rejection nothing is left to catch.
 */
function holdUntilStopped(stop: () => Promise<void>, io: DaemonIo): Promise<number> {
  return new Promise<number>((resolve) => {
    let ending = false;

    function remove(): void {
      for (const signal of SIGNALS) process.off(signal, onSignal);
      process.off("uncaughtException", onFault);
      process.off("unhandledRejection", onFault);
    }

    function ended(code: number): void {
      remove();
      resolve(code);
    }

    function end(code: number, fault?: string): void {
      if (ending) return;

      ending = true;
      if (fault !== undefined) io.stderr.write(fault);

      stop().then(
        () => ended(code),
        (error: unknown) => {
          io.stderr.write(line(causeOf(error)));
          ended(1);
        },
      );
    }

    function onSignal(): void {
      end(0);
    }

    function onFault(error: unknown): void {
      end(1, line(causeOf(error)));
    }

    for (const signal of SIGNALS) process.on(signal, onSignal);
    process.on("uncaughtException", onFault);
    process.on("unhandledRejection", onFault);
  });
}

/**
 * The whole daemon: arguments in, exit code out, every byte through `io` and
 * every variable through `env`.
 *
 * `root` is the tree, defaulting to the one the engine expands. It is a
 * parameter rather than an option because no user names another tree.
 */
export async function runDaemon(
  argv: string[],
  io: DaemonIo,
  env: Record<string, string | undefined>,
  root?: string,
): Promise<number> {
  let port: number;

  try {
    const { values } = parseArgs({ args: argv, strict: true, options: { port: { type: "string" } } });
    port = resolveDaemonPort(values.port, env);
  } catch (error) {
    io.stderr.write(line(causeOf(error)));

    return 1;
  }

  const start = await startDaemon({ port, root });

  if (!start.started) {
    io.stderr.write(line(start.message));

    return start.code;
  }

  // The handlers are installed in the same tick this line is written, so a
  // caller that reads the address and signals at once reaches a daemon that
  // answers.
  io.stdout.write(`${DAEMON_NAME} ${manifest.version} at ${start.url}\n`);

  return holdUntilStopped(start.stop, io);
}
