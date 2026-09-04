import { DAEMON_NAME } from "@tasma/protocol";
import { createDaemonClient } from "../daemon/transport.js";
import { attempt, reportForeign } from "../failure.js";
import { noun, reportUsage, wireText } from "../shell.js";
import type { Io } from "../types.js";

/**
 * Whether a daemon is running, and which one.
 *
 * It uses the shared failure rule with no exception: a daemon that is down is
 * one line on stderr and a non-zero code, not a success reporting absence.
 *
 * A verb is handed every token after it, so an option meant for the top level
 * lands here; accepted silently it would report on an address nobody asked
 * about.
 */
async function status(args: string[], io: Io, daemonUrl: string): Promise<number> {
  const [extra] = args;

  if (extra !== undefined) {
    return reportUsage(io, `daemon status takes no arguments: ${extra}`);
  }

  return attempt(io, daemonUrl, () => createDaemonClient(daemonUrl).readHealth(), (health) => {
    // Read as the wire carries it. The envelope check reads no further than its
    // discriminant, so the answer is whatever the port sent — `null` and a
    // scalar included — and no field can be read off it until it is an object.
    const answer: unknown = health;

    if (typeof answer !== "object" || answer === null) {
      return reportForeign(io, daemonUrl, answer);
    }

    const { name, version } = answer as { name?: unknown; version?: unknown };

    if (name !== DAEMON_NAME) {
      return reportForeign(io, daemonUrl, name);
    }

    io.stdout.write(`${DAEMON_NAME} ${wireText(version)} at ${daemonUrl}\n`);
    return 0;
  });
}

export const daemon = noun("daemon", "Work with the daemon", [
  { name: "status", summary: "Report whether a daemon is running", run: status },
]);
