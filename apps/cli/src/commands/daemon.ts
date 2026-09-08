import { parseArgs } from "node:util";
import { DAEMON_NAME, printable } from "@tasma/protocol";
import { daemonAnswers, daemonUrl, readRecord, recordPath } from "../daemon/record.js";
import { delay, TICK_MS } from "../daemon/start.js";
import { REQUEST_TIMEOUT_MS } from "../daemon/transport.js";
import { attempt, reportForeign, UNREACHABLE } from "../failure.js";
import { fieldsOf } from "../output.js";
import { noun, reportUsage, wireText } from "../shell.js";
import type { Io, Options, Target } from "../types.js";
import { HELP_OPTION, readVerb, usageBlock } from "./verb.js";

/** How long `stop` waits for the daemon to remove its own record. No escalation follows it. */
const STOP_BUDGET_MS = 10_000;

/** Every daemon verb takes the same arguments: none of its own, and the flag printing its usage. */
const VERB_OPTIONS = { ...HELP_OPTION } as const satisfies Options;

const START_HELP = usageBlock("daemon start");
const STATUS_HELP = usageBlock("daemon status");
const STOP_HELP = usageBlock("daemon stop");

/**
 * The code a verb returns before it acts, or nothing where its arguments left it
 * free to act: none of these verbs reads a value off its own table.
 */
function readDaemonVerb(io: Io, verb: string, args: string[], help: string[]): number | undefined {
  const parsed = readVerb(io, args, { command: `daemon ${verb}`, help, takes: 0 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: VERB_OPTIONS }));

  return typeof parsed === "number" ? parsed : undefined;
}

/**
 * The fault where a verb that acts on this tree was pointed at an address.
 *
 * The record is the only thing `start` and `stop` can start or signal, and the
 * channel that carried the address is named so the reader knows what to remove:
 * a shell profile exporting the variable makes every invocation explicit until
 * it is unset for that one.
 */
function refuseAddress(io: Io, verb: string, stated: Extract<Target, { kind: "explicit" }>["stated"]): number {
  const remove = stated === "--daemon" ? "remove --daemon" : "unset TASMA_DAEMON_URL";

  return reportUsage(io, `daemon ${verb} acts on the daemon of this tree: ${remove}`);
}

/**
 * Names the daemon that answered, or refuses the answer.
 *
 * `start` allows a start on demand and `status` does not, which is the whole
 * difference between the two verbs: a daemon already serving prints the same
 * line either way.
 */
function report(io: Io, target: Target, options: { start: boolean }): Promise<number> {
  return attempt(io, target, (client) => client.readHealth(), (health, url) => {
    const answer: unknown = health;

    if (typeof answer !== "object" || answer === null) {
      return reportForeign(io, url, answer);
    }

    const { name, version } = fieldsOf(answer);

    if (name !== DAEMON_NAME) {
      return reportForeign(io, url, name);
    }

    io.stdout.write(`${DAEMON_NAME} ${wireText(version)} at ${url}\n`);
    return 0;
  }, options);
}

async function status(args: string[], io: Io, target: Target): Promise<number> {
  return readDaemonVerb(io, "status", args, STATUS_HELP) ?? report(io, target, { start: false });
}

async function start(args: string[], io: Io, target: Target): Promise<number> {
  const refusal = readDaemonVerb(io, "start", args, START_HELP);

  if (refusal !== undefined) return refusal;
  if (target.kind === "explicit") return refuseAddress(io, "start", target.stated);

  return report(io, target, { start: true });
}

/**
 * Why the process refused the signal, or nothing where it took it.
 *
 * A pid off the record is a positive `int32`, so the kernel answers with `ESRCH`
 * or `EPERM` and nothing else: the signal is a constant, and every other way
 * `process.kill` refuses is a fault in its arguments.
 */
function signalStop(pid: number): "sent" | "gone" | "refused" {
  try {
    process.kill(pid, "SIGTERM");

    return "sent";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "refused";
  }
}

/**
 * Whether the process is gone, from a signal that asks and sends nothing.
 *
 * `EPERM` means it exists under another account, which is still a process the
 * daemon may be running as.
 */
function hasGone(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Whether the daemon ended within the budget, and whether its record outlived it. */
type Stopped = { ended: true; stale: boolean } | { ended: false };

/**
 * Waits for the daemon to end, and says whether it did.
 *
 * Removing the record is the daemon's last act, after the drain and the index
 * close, so a record gone — or naming another process — is the whole shutdown
 * and not only the closed port. A process gone while its record stands is a
 * shutdown that did not reach the record, which the next start replaces.
 */
async function waitForStop(path: string, pid: number, budgetMs: number): Promise<Stopped> {
  const deadline = Date.now() + budgetMs;

  for (;;) {
    if ((await readRecord(path))?.pid !== pid) return { ended: true, stale: false };
    if (hasGone(pid)) return { ended: true, stale: true };
    if (Date.now() >= deadline) return { ended: false };

    await delay(TICK_MS);
  }
}

/**
 * Ends the daemon of this tree, by signal: the daemon serves no route that stops
 * it, and the record is what names the process to signal.
 *
 * Reaching the goal state is exit 0, so a tree with no daemon running is not a
 * failure — unlike `status`, which answers a question. The record is never
 * removed here whatever it holds; the daemon replaces it at its next start.
 *
 * Nothing in production passes `budgetMs`; it is there so the wait can be driven
 * in milliseconds.
 */
export async function stop(args: string[], io: Io, target: Target, budgetMs = STOP_BUDGET_MS): Promise<number> {
  const refusal = readDaemonVerb(io, "stop", args, STOP_HELP);

  if (refusal !== undefined) return refusal;
  if (target.kind === "explicit") return refuseAddress(io, "stop", target.stated);

  const path = recordPath(target.home);
  const record = await readRecord(path);

  if (record === undefined) {
    io.stdout.write("no daemon is running\n");
    return 0;
  }

  const url = daemonUrl(record.port);
  const staleNote = `tasma: the record at ${printable(path)} is stale\n`;

  // The budget every other verb reaches a daemon under, rather than the shorter
  // one a bare probe defaults to: a daemon whose event loop is held for a moment
  // is one `status` reports as running, and calling it absent here would report
  // the goal state reached and signal nothing.
  if (!(await daemonAnswers(url, REQUEST_TIMEOUT_MS))) {
    io.stdout.write("no daemon is running\n");
    io.stderr.write(staleNote);
    return 0;
  }

  // The probe proves that a daemon answers at the recorded port, and nothing
  // proves it is the process the record names: `Health` states a name and a
  // version and no process id, so the two fields of the record are believed
  // together or not at all.
  const signalled = signalStop(record.pid);

  // A daemon of another tree on the same port, which this CLI does not own.
  if (signalled === "gone") {
    io.stderr.write(`tasma: the record names process ${record.pid}, which is not running, while ${url} answers\n`);
    return UNREACHABLE;
  }

  if (signalled === "refused") {
    io.stderr.write(`tasma: not permitted to signal process ${record.pid}\n`);
    return UNREACHABLE;
  }

  const stopped = await waitForStop(path, record.pid, budgetMs);

  if (!stopped.ended) {
    const seconds = budgetMs / 1000;

    io.stderr.write(`tasma: the daemon at ${url} (process ${record.pid}) did not stop within ${seconds} seconds\n`);
    return UNREACHABLE;
  }

  io.stdout.write(`${DAEMON_NAME} at ${url} stopped\n`);
  if (stopped.stale) io.stderr.write(staleNote);

  return 0;
}

export const daemon = noun("daemon", "Work with the daemon", [
  {
    name: "start",
    summary: "Start the daemon of this tree",
    usage: { help: START_HELP, options: VERB_OPTIONS },
    run: start,
  },
  {
    name: "status",
    summary: "Report whether a daemon is running",
    usage: { help: STATUS_HELP, options: VERB_OPTIONS },
    run: status,
  },
  {
    name: "stop",
    summary: "Stop the daemon of this tree",
    usage: { help: STOP_HELP, options: VERB_OPTIONS },
    run: stop,
  },
]);
