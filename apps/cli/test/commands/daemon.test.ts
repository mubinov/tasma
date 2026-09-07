import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execPath } from "node:process";
import { DAEMON_NAME } from "@tasma/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { daemon, stop } from "../../src/commands/daemon.js";
import { PROBE_TIMEOUT_MS, recordPath } from "../../src/daemon/record.js";
import { OUTPUT_FILE, startDaemon } from "../../src/daemon/start.js";
import { run } from "../../src/run.js";
import {
  at, capture, fakeDaemon, seedRecord, serveHealth, startServer, tasmaHealth, TEST_VERSION, treeHome, unusedUrl,
  UNUSED_PID,
} from "../helpers.js";

/** A wire field that refuses to coerce, as JSON.parse builds it, and how it prints. */
const HOSTILE = { toString: "x" };
const HOSTILE_TEXT = '{"toString":"x"}';

/** Longer than a bare probe waits, so a check on that budget would call the server absent. */
const SLOW_REPLY_MS = PROBE_TIMEOUT_MS + 500;

/** Long enough for a tick of the wait and short enough to spend, for the case that runs the budget out. */
const SHORT_BUDGET_MS = 300;

/** A daemon of this tree, as the fake standing in for one, at the address its record names. */
async function runningIn(home: string, scenario = "serves"): Promise<string> {
  const outcome = await startDaemon({
    home,
    executable: () => fakeDaemon(home, scenario),
    output: join(home, OUTPUT_FILE),
    budgetMs: 8000,
  });

  if (!("url" in outcome)) throw new Error(outcome.failure);

  return outcome.url;
}

describe("daemon status", () => {
  it("names the daemon, its version and where it answered, at exit 0", async () => {
    const server = await startServer(tasmaHealth);
    const { io, out, err } = capture();

    try {
      expect(await daemon.run(["status"], io, at(server.url))).toBe(0);
    } finally {
      await server.close();
    }

    expect(out.join("")).toBe(`${DAEMON_NAME} ${TEST_VERSION} at ${server.url}\n`);
    expect(err).toEqual([]);
  });

  // A foreign server can answer a well-formed envelope, so the one field that
  // identifies a Tasma daemon is compared rather than assumed.
  it("refuses a well-formed answer naming another process", async () => {
    const server = await startServer(serveHealth({ name: "other-daemon", version: "1.0.0" }));
    const { io, out, err } = capture();

    try {
      expect(await daemon.run(["status"], io, at(server.url))).toBe(3);
    } finally {
      await server.close();
    }

    expect(out).toEqual([]);
    expect(err.join("")).toBe(`tasma: ${server.url} answered as "other-daemon", not a Tasma daemon\n`);
  });

  // The field is whatever answered the port, so a name that is missing and one
  // that refuses to coerce are the same case.
  it("refuses an envelope whose data carries no name it can print, without throwing", async () => {
    for (const [data, quoted] of [[{}, "undefined"], [{ name: HOSTILE }, HOSTILE_TEXT]] as const) {
      const server = await startServer(serveHealth(data));
      const { io, err } = capture();

      try {
        expect(await daemon.run(["status"], io, at(server.url))).toBe(3);
      } finally {
        await server.close();
      }

      expect(err.join("")).toBe(`tasma: ${server.url} answered as "${quoted}", not a Tasma daemon\n`);
    }
  });

  // `null` and a scalar are shapes the envelope check passes and the type does
  // not describe, so the answer is refused before a field is read off it.
  it("refuses an envelope whose data is not an object, without throwing", async () => {
    for (const [data, quoted] of [[null, "null"], [DAEMON_NAME, DAEMON_NAME], [7, "7"]] as const) {
      const server = await startServer(serveHealth(data));
      const { io, out, err } = capture();

      try {
        expect(await daemon.run(["status"], io, at(server.url))).toBe(3);
      } finally {
        await server.close();
      }

      expect(out).toEqual([]);
      expect(err.join("")).toBe(`tasma: ${server.url} answered as "${quoted}", not a Tasma daemon\n`);
    }
  });

  // The version is whatever answered the port, so it is escaped like every
  // other string the wire supplies.
  it("escapes a version carrying a control character rather than writing it to the terminal", async () => {
    const version = "0.0.0\u001b[2K\rtasma: fine";
    const server = await startServer(serveHealth({ name: DAEMON_NAME, version }));
    const { io, out } = capture();

    try {
      expect(await daemon.run(["status"], io, at(server.url))).toBe(0);
    } finally {
      await server.close();
    }

    expect(out.join("")).toBe(`${DAEMON_NAME} 0.0.0\\u001b[2K\\u000dtasma: fine at ${server.url}\n`);
  });

  it("prints a version that refuses to coerce rather than dying on it", async () => {
    const server = await startServer(serveHealth({ name: DAEMON_NAME, version: HOSTILE }));
    const { io, out, err } = capture();

    try {
      expect(await daemon.run(["status"], io, at(server.url))).toBe(0);
    } finally {
      await server.close();
    }

    expect(out.join("")).toBe(`${DAEMON_NAME} ${HOSTILE_TEXT} at ${server.url}\n`);
    expect(err).toEqual([]);
  });

  // The wire is read by a parser that nests iteratively and printed by a
  // renderer that recurses, so an answer can arrive at a depth no rendering of
  // it survives.
  it("prints a version too deeply nested to render rather than dying on it", async () => {
    const deep = `${"[".repeat(30_000)}${"]".repeat(30_000)}`;
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"ok":true,"data":{"name":"${DAEMON_NAME}","version":${deep}},"diagnostics":[]}`);
    });
    const { io, out, err } = capture();

    try {
      expect(await daemon.run(["status"], io, at(server.url))).toBe(0);
    } finally {
      await server.close();
    }

    expect(out.join("")).toBe(`${DAEMON_NAME} [unprintable] at ${server.url}\n`);
    expect(err).toEqual([]);
  });

  it("refuses an argument of its own rather than ignoring it", async () => {
    const { io, out, err } = capture();

    expect(await daemon.run(["status", "TASM"], io, at("http://127.0.0.1:8278"))).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("tasma: daemon status takes no arguments: TASM\nRun 'tasma --help' for usage.\n");
  });

  // A verb is handed every token after it, so a global typed after the command
  // name lands here; accepted silently it would act on a daemon nobody asked
  // about.
  it("refuses a flag of its own through the parser's own message", async () => {
    const { io, err } = capture();

    expect(await daemon.run(["status", "--daemon", "http://127.0.0.1:9000"], io, at("http://127.0.0.1:8278"))).toBe(2);
    expect(err.join("")).toContain("tasma: Unknown option '--daemon'");
  });

  it("reports a port nothing listens on", async () => {
    const url = await unusedUrl();
    const { io, out, err } = capture();

    expect(await daemon.run(["status"], io, at(url))).toBe(3);
    expect(out).toEqual([]);
    expect(err.join("")).toBe(`tasma: no daemon answered at ${url}\n`);
  });

  // Start-on-demand is the difference between the two verbs, and `status`
  // answers a question rather than reaching a goal state.
  it("starts nothing for a tree whose record names a port that answers nothing", async () => {
    const home = treeHome();
    const path = seedRecord(home, { port: Number(new URL(await unusedUrl()).port), pid: UNUSED_PID });
    const { io, out, err } = capture();

    expect(await run(["daemon", "status"], io, { HOME: home })).toBe(3);
    expect(out).toEqual([]);
    expect(err.join("")).toContain(`; the record at ${path} is stale\n`);
  });
});

describe("daemon start", () => {
  it("refuses an address stated by hand, naming the channel that stated it", async () => {
    for (const [argv, env, remove] of [
      [["--daemon", "http://127.0.0.1:9000", "daemon", "start"], {}, "remove --daemon"],
      [["daemon", "start"], { TASMA_DAEMON_URL: "http://127.0.0.1:9000" }, "unset TASMA_DAEMON_URL"],
    ] as const) {
      const { io, out, err } = capture();

      expect(await run([...argv], io, env)).toBe(2);
      expect(out).toEqual([]);
      expect(err.join("")).toBe(`tasma: daemon start acts on the daemon of this tree: ${remove}\n`
        + "Run 'tasma --help' for usage.\n");
    }
  });

  it("refuses an argument of its own rather than ignoring it", async () => {
    const { io, err } = capture();

    expect(await run(["daemon", "start", "now"], io, { HOME: "/tmp" })).toBe(2);
    expect(err.join("")).toBe("tasma: daemon start takes no arguments: now\nRun 'tasma --help' for usage.\n");
  });

  it("refuses a flag of its own through the parser's own message", async () => {
    const { io, err } = capture();

    expect(await run(["daemon", "start", "--now"], io, { HOME: "/tmp" })).toBe(2);
    expect(err.join("")).toContain("tasma: Unknown option '--now'");
  });

  // A daemon already serving is the goal state, so the verb prints the line
  // `status` would print and starts nothing.
  it("names the daemon already serving the tree", async () => {
    const home = treeHome();
    const url = await runningIn(home);
    const { io, out, err } = capture();

    expect(await run(["daemon", "start"], io, { HOME: home })).toBe(0);
    expect(out.join("")).toBe(`${DAEMON_NAME} 0.0.0 at ${url}\n`);
    expect(err).toEqual([]);
  });
});

describe("daemon stop", () => {
  it("ends the daemon of the tree and says where it was", async () => {
    const home = treeHome();
    const url = await runningIn(home);
    const { io, out, err } = capture();

    expect(await run(["daemon", "stop"], io, { HOME: home })).toBe(0);
    expect(out.join("")).toBe(`${DAEMON_NAME} at ${url} stopped\n`);
    expect(err).toEqual([]);
    expect(existsSync(recordPath(home))).toBe(false);
  });

  // The goal state is reached, so the code is 0 — unlike `status`, which
  // answers a question.
  it("reports a tree with no record at all as no daemon running", async () => {
    const home = treeHome();
    const { io, out, err } = capture();

    expect(await run(["daemon", "stop"], io, { HOME: home })).toBe(0);
    expect(out.join("")).toBe("no daemon is running\n");
    expect(err).toEqual([]);
  });

  // The record is never removed here: the daemon replaces it at its next start.
  it("names a record whose port answers nothing as stale, and leaves it standing", async () => {
    const home = treeHome();
    const path = seedRecord(home, { port: Number(new URL(await unusedUrl()).port), pid: UNUSED_PID });
    const { io, out, err } = capture();

    expect(await run(["daemon", "stop"], io, { HOME: home })).toBe(0);
    expect(out.join("")).toBe("no daemon is running\n");
    expect(err.join("")).toBe(`tasma: the record at ${path} is stale\n`);
    expect(existsSync(path)).toBe(true);
  });

  // A daemon of another tree took the recorded port, and this CLI does not own it.
  it("refuses to act where the record names a process that is not running and the port answers", async () => {
    const home = treeHome();
    const server = await startServer(tasmaHealth);
    const port = Number(new URL(server.url).port);

    seedRecord(home, { port, pid: UNUSED_PID });

    const { io, out, err } = capture();

    try {
      expect(await run(["daemon", "stop"], io, { HOME: home })).toBe(3);
    } finally {
      await server.close();
    }

    expect(out).toEqual([]);
    expect(err.join("")).toBe(
      `tasma: the record names process ${UNUSED_PID}, which is not running, while ${server.url} answers\n`,
    );
  });

  // A record naming a process of another account is a tree this user cannot
  // stop, which is a different sentence from one that is not there at all.
  it.skipIf(process.getuid?.() === 0)("reports a process it is not permitted to signal", async () => {
    const home = treeHome();
    const server = await startServer(tasmaHealth);

    // Process 1 is the one process every supported system runs under an account
    // this test is not. Sending it SIGTERM as any other account is refused.
    seedRecord(home, { port: Number(new URL(server.url).port), pid: 1 });

    const { io, out, err } = capture();

    try {
      expect(await run(["daemon", "stop"], io, { HOME: home })).toBe(3);
    } finally {
      await server.close();
    }

    expect(out).toEqual([]);
    expect(err.join("")).toBe("tasma: not permitted to signal process 1\n");
  });

  // Removing the record is the daemon's last act, so a process gone while the
  // record stands is a shutdown that did not reach it.
  it("reports the stop of a daemon that died without clearing its record", async () => {
    const home = treeHome();
    const url = await runningIn(home, "leaves-record");
    const path = recordPath(home);
    const { io, out, err } = capture();

    expect(await run(["daemon", "stop"], io, { HOME: home })).toBe(0);
    expect(out.join("")).toBe(`${DAEMON_NAME} at ${url} stopped\n`);
    expect(err.join("")).toBe(`tasma: the record at ${path} is stale\n`);
  });

  // A daemon whose event loop is held for a moment still answers `status`, and
  // `stop` has to reach the same conclusion: a liveness check on a shorter
  // budget calls a running daemon absent, reports the goal state reached and
  // signals nothing.
  it("signals a daemon that is slow to answer rather than reporting none running", async () => {
    const home = treeHome();
    const server = await startServer((request, response) => {
      setTimeout(() => tasmaHealth(request, response), SLOW_REPLY_MS);
    });
    const idle = spawn(execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const ended = once(idle, "exit");

    onTestFinished(() => {
      idle.kill("SIGKILL");
    });

    const path = seedRecord(home, { port: Number(new URL(server.url).port), pid: idle.pid ?? UNUSED_PID });
    const { io, out, err } = capture();

    try {
      expect(await run(["daemon", "stop"], io, { HOME: home })).toBe(0);
    } finally {
      await server.close();
    }

    await ended;
    expect(out.join("")).toBe(`${DAEMON_NAME} at ${server.url} stopped\n`);
    expect(err.join("")).toBe(`tasma: the record at ${path} is stale\n`);
  }, 20_000);

  it("refuses an address stated by hand, naming the channel that stated it", async () => {
    for (const [argv, env, remove] of [
      [["--daemon", "http://127.0.0.1:9000", "daemon", "stop"], {}, "remove --daemon"],
      [["daemon", "stop"], { TASMA_DAEMON_URL: "http://127.0.0.1:9000" }, "unset TASMA_DAEMON_URL"],
    ] as const) {
      const { io, out, err } = capture();

      expect(await run([...argv], io, env)).toBe(2);
      expect(out).toEqual([]);
      expect(err.join("")).toBe(`tasma: daemon stop acts on the daemon of this tree: ${remove}\n`
        + "Run 'tasma --help' for usage.\n");
    }
  });

  it("refuses an argument of its own rather than ignoring it", async () => {
    const { io, err } = capture();

    expect(await run(["daemon", "stop", "force"], io, { HOME: "/tmp" })).toBe(2);
    expect(err.join("")).toBe("tasma: daemon stop takes no arguments: force\nRun 'tasma --help' for usage.\n");
  });

  it("refuses a flag of its own through the parser's own message", async () => {
    const { io, err } = capture();

    expect(await run(["daemon", "stop", "--force"], io, { HOME: "/tmp" })).toBe(2);
    expect(err.join("")).toContain("tasma: Unknown option '--force'");
  });

  // No SIGKILL follows: a daemon that will not end is reported and left alone.
  it("gives up on a daemon that does not end, without escalating", async () => {
    const home = treeHome();
    const server = await startServer(tasmaHealth);
    // A process of the test's own that survives the signal, so the wait runs its
    // whole budget without the run signalling itself.
    const deaf = spawn(execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('deaf'); setInterval(() => {}, 1000)",
    ], { stdio: ["ignore", "pipe", "ignore"] });

    onTestFinished(() => {
      deaf.kill("SIGKILL");
    });

    // The handler is installed before the line is written, so a signal sent
    // after it is one the process survives.
    await once(deaf.stdout, "data");

    seedRecord(home, { port: Number(new URL(server.url).port), pid: deaf.pid ?? UNUSED_PID });

    const { io, out, err } = capture();

    try {
      expect(await stop([], io, { kind: "tree", home }, SHORT_BUDGET_MS)).toBe(3);
    } finally {
      await server.close();
    }

    expect(out).toEqual([]);
    expect(err.join("")).toBe(
      `tasma: the daemon at ${server.url} (process ${deaf.pid}) did not stop within 0.3 seconds\n`,
    );
  });
});

describe("the daemon noun", () => {
  // A bare `tasma daemon` is a request for orientation, one level below a bare
  // `tasma`.
  it("lists its verbs and exits 0 when no verb follows it", async () => {
    const { io, out, err } = capture();

    expect(await daemon.run([], io, at("http://127.0.0.1:8278"))).toBe(0);
    expect(out.join("")).toContain("start");
    expect(out.join("")).toContain("status");
    expect(out.join("")).toContain("stop");
    expect(err).toEqual([]);
  });

  // The same request spelled the way the top level accepts it, so the two
  // levels answer the same two spellings.
  it("lists its verbs for --help and -h as well", async () => {
    for (const flag of ["--help", "-h"]) {
      const { io, out, err } = capture();

      expect(await daemon.run([flag], io, at("http://127.0.0.1:8278"))).toBe(0);
      expect(out.join("")).toContain("status");
      expect(err).toEqual([]);
    }
  });

  it("reports an unknown verb as the whole invocation, not as a top-level command", async () => {
    const { io, out, err } = capture();

    expect(await daemon.run(["frobnicate"], io, at("http://127.0.0.1:8278"))).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("tasma: unknown command: daemon frobnicate\nRun 'tasma --help' for usage.\n");
  });

  // Every verb of every noun answers the flag the same way, so a reader who
  // learned it on one noun does not meet a usage error on the next.
  it("prints a usage block for every verb, reaching no daemon and starting none", async () => {
    for (const verb of ["start", "status", "stop"]) {
      for (const flag of ["--help", "-h"]) {
        const { io, out, err } = capture();

        expect(await run(["daemon", verb, flag], io, { HOME: "/tmp" }), `${verb} ${flag}`).toBe(0);
        expect(out.join("")).toContain(`tasma daemon ${verb}`);
        expect(err).toEqual([]);
      }
    }
  });
});
