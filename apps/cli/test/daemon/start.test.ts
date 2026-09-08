import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { daemonUrl, readRecord, recordPath } from "../../src/daemon/record.js";
import { daemonExecutable, OUTPUT_FILE, startDaemon } from "../../src/daemon/start.js";
import type { StartOutcome } from "../../src/daemon/start.js";
import { fakeDaemon, seedRecord, startServer, tasmaHealth, treeHome, UNUSED_PID } from "../helpers.js";

/** Long enough for a spawn to land on a cold machine, for the cases that end on the daemon rather than the clock. */
const ANSWER_BUDGET_MS = 8000;

/** The line the fixture writes before it stands down for a daemon of another tree. */
const STOOD_DOWN_LINE = "tasma-daemon: a daemon is already serving at http://127.0.0.1:8278";

/** What a start reported as its failure, so an assertion on it stays typed. */
function failureOf(outcome: StartOutcome): string {
  return "failure" in outcome ? outcome.failure : `started at ${outcome.url}`;
}

/** The captured output, in the tree of the test rather than the shared temporary directory. */
function outputIn(home: string): string {
  return join(home, OUTPUT_FILE);
}

/** A package directory holding the manifest text it is given, as module resolution would answer it. */
function packageAt(home: string, manifest: string | undefined): (specifier: string) => string {
  const directory = join(home, "daemon-package");

  mkdirSync(directory, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(directory, "package.json"), manifest);

  return () => pathToFileURL(join(directory, "package.json")).href;
}

describe("startDaemon", () => {
  it("answers the address of the daemon it started, appending its output behind what was there", async () => {
    const home = treeHome();
    const executable = fakeDaemon(home, "serves");
    const output = outputIn(home);

    writeFileSync(output, "older\n");

    const outcome = await startDaemon({ home, executable: () => executable, output, budgetMs: ANSWER_BUDGET_MS });
    const record = await readRecord(recordPath(home));

    expect(record).toBeDefined();
    expect(outcome).toEqual({ url: daemonUrl(record?.port ?? 0) });
    expect(readFileSync(output, "utf8")).toMatch(/^older\ntasma-daemon 0\.0\.0 at http:\/\/127\.0\.0\.1:\d+\n$/);
  });

  // A daemon that dies before it answers has nowhere but the captured output to
  // say why, so the line it wrote is what the failure carries.
  it("names the code a daemon exited with and the last line it wrote", async () => {
    const home = treeHome();
    const executable = fakeDaemon(home, "refuses");

    const outcome = await startDaemon({
      home,
      executable: () => executable,
      output: outputIn(home),
      budgetMs: ANSWER_BUDGET_MS,
    });

    expect(outcome).toEqual({ failure: "tasma-daemon exited with code 1: port 8278 cannot be bound: EACCES" });
  });

  // Whether the name still holds the output, and whether what was appended holds
  // a line at all, are the two ways there is nothing to quote back.
  it("names the code alone where nothing readable was appended", async () => {
    for (const scenario of ["vanishes", "blank"]) {
      const home = treeHome();
      const executable = fakeDaemon(home, scenario);

      const outcome = await startDaemon({
        home,
        executable: () => executable,
        output: outputIn(home),
        budgetMs: ANSWER_BUDGET_MS,
      });

      expect(outcome, scenario).toEqual({ failure: "tasma-daemon exited with code 1" });
    }
  });

  // A daemon killed outright writes no code, so the signal is what the failure
  // names instead.
  it("names the signal a daemon was ended by", async () => {
    const home = treeHome();
    const executable = fakeDaemon(home, "killed");

    const outcome = await startDaemon({
      home,
      executable: () => executable,
      output: outputIn(home),
      budgetMs: ANSWER_BUDGET_MS,
    });

    expect(outcome).toEqual({ failure: "tasma-daemon was ended by SIGKILL" });
  });

  // The defaults are the terminal path: the daemon of this install, the shared
  // temporary directory, and the standard budget. The runtime is made
  // unspawnable so the case proves which executable was chosen without starting
  // a daemon over the tree.
  it("takes the daemon of this install, the shared output file and the standard budget when given none", async () => {
    const home = treeHome();
    const runtime = process.execPath;

    process.execPath = join(home, "no-such-node");

    try {
      expect(failureOf(await startDaemon({ home })))
        .toMatch(/^(tasma-daemon could not be started: |no daemon executable at )/);
    } finally {
      process.execPath = runtime;
    }
  });

  // Two commands starting at once spawn two daemons, of which one stands down.
  // The winner's record is the answer, so a child exiting 0 never ends the wait.
  it("answers the record's address where the daemon it spawned stood down for another", async () => {
    const home = treeHome();
    const executable = fakeDaemon(home, "stands-down");
    const server = await startServer(tasmaHealth);
    const port = Number(new URL(server.url).port);

    seedRecord(home, { port, pid: UNUSED_PID });

    try {
      const outcome = await startDaemon({
        home,
        executable: () => executable,
        output: outputIn(home),
        budgetMs: ANSWER_BUDGET_MS,
      });

      expect(outcome).toEqual({ url: daemonUrl(port) });
    } finally {
      await server.close();
    }
  });

  // A daemon that stands down for one holding its port serves another tree, and
  // this tree is left with no daemon at all. Waiting out the budget for a record
  // nothing will write would spend it on every command, and the line the child
  // wrote is the only statement of what it stood down for.
  it("gives up on a daemon that stood down and left no record behind", async () => {
    const stood = "tasma-daemon exited without serving this tree";

    for (const [scenario, failure] of [
      ["stands-down-elsewhere", `${stood}: ${STOOD_DOWN_LINE}`],
      ["stands-down", stood],
    ] as const) {
      const home = treeHome();
      const executable = fakeDaemon(home, scenario);

      const outcome = await startDaemon({
        home,
        executable: () => executable,
        output: outputIn(home),
        budgetMs: ANSWER_BUDGET_MS,
      });

      expect(outcome, scenario).toEqual({ failure });
      expect(await readRecord(recordPath(home))).toBeUndefined();
    }
  });

  // The daemon a loser stands down for binds before it writes its record, so the
  // loser can exit while this tree still has none. Settling on the exit alone
  // would report a tree that is about to be served as one that is not.
  it("answers a record written after the daemon it spawned had already exited", async () => {
    const home = treeHome();
    const executable = fakeDaemon(home, "stands-down");
    const server = await startServer(tasmaHealth);
    const port = Number(new URL(server.url).port);
    const late = setTimeout(() => seedRecord(home, { port, pid: UNUSED_PID }), 250);

    try {
      const outcome = await startDaemon({
        home,
        executable: () => executable,
        output: outputIn(home),
        budgetMs: ANSWER_BUDGET_MS,
      });

      expect(outcome).toEqual({ url: daemonUrl(port) });
    } finally {
      clearTimeout(late);
      await server.close();
    }
  });

  // A name in a directory every account writes can be planted, and neither kind
  // is a file the CLI may hand a child: without `O_NONBLOCK` the open of a pipe
  // waits for a reader that never comes, and a device carries the output
  // somewhere else entirely.
  it("refuses a name that holds something other than a regular file", async () => {
    const home = treeHome();
    const fifo = join(home, "planted.out");

    execFileSync("mkfifo", [fifo]);

    for (const output of [fifo, "/dev/null"]) {
      expect(await startDaemon({ home, executable: () => "unused", output, budgetMs: 500 }), output).toEqual({
        failure: `the daemon output file could not be opened: ${output}`,
      });
    }
  });

  // A hard link needs nothing of the file it is made to, and no open sees one:
  // the name would be a second name for a file this account owns, which the mode
  // this start sets would narrow and the child's output would then overwrite.
  it("refuses a name that is a second link to a file already there", async () => {
    const home = treeHome();
    const owned = join(home, "notes.md");
    const output = join(home, "planted.out");

    writeFileSync(owned, "notes\n");
    linkSync(owned, output);

    expect(await startDaemon({ home, executable: () => "unused", output, budgetMs: 500 })).toEqual({
      failure: `the daemon output file could not be opened: ${output}`,
    });
    expect(readFileSync(owned, "utf8")).toBe("notes\n");
  });

  // A record is not an answer: the port it names has to answer as a daemon, so
  // one naming a port nothing listens on runs the wait to its deadline.
  it("gives up on a daemon whose record names a port that answers nothing", async () => {
    const home = treeHome();
    const executable = fakeDaemon(home, "hangs");

    const outcome = await startDaemon({
      home,
      executable: () => executable,
      output: outputIn(home),
      budgetMs: 1500,
    });

    expect(outcome).toEqual({ failure: "tasma-daemon did not answer within 1.5 seconds" });
    expect(await readRecord(recordPath(home))).toBeDefined();
  });

  it("reports a name the output cannot be opened under, before it spawns anything", async () => {
    const home = treeHome();
    const output = join(home, "no-such-directory", OUTPUT_FILE);

    expect(await startDaemon({ home, executable: () => "unused", output, budgetMs: 500 })).toEqual({
      failure: `the daemon output file could not be opened: ${output}`,
    });
  });

  it("reports a fault in finding the executable, whatever the fault was thrown as", async () => {
    const home = treeHome();

    for (const [thrown, failure] of [
      [new Error("the daemon package @tasma/daemon is not installed"), "the daemon package @tasma/daemon is not installed"],
      ["boom", "boom"],
    ] as const) {
      const outcome = await startDaemon({
        home,
        executable: () => {
          // A throw that is not an Error is the second half of the case.
          throw thrown;
        },
        output: outputIn(home),
        budgetMs: 500,
      });

      expect(outcome).toEqual({ failure });
    }
  });

  // A spawn refuses some arguments before it forks and fails on others after,
  // and both reach the reader as the same sentence.
  it("reports a spawn the runtime refused outright", async () => {
    const home = treeHome();

    const outcome = await startDaemon({
      // A null byte in an environment value is what a spawn refuses before it forks.
      home: `${home}\u0000`,
      executable: () => "unused",
      output: outputIn(home),
      budgetMs: 500,
    });

    expect(failureOf(outcome)).toContain("tasma-daemon could not be started: ");
  });

  it("reports a spawn that failed after it was accepted", async () => {
    const home = treeHome();
    const runtime = process.execPath;

    process.execPath = join(home, "no-such-node");

    try {
      const outcome = await startDaemon({
        home,
        executable: () => "unused",
        output: outputIn(home),
        budgetMs: 2000,
      });

      expect(failureOf(outcome)).toContain("tasma-daemon could not be started: ");
    } finally {
      process.execPath = runtime;
    }
  });
});

describe("daemonExecutable", () => {
  it("joins the executable the daemon's manifest declares onto the package it resolved", () => {
    const home = treeHome();
    const resolve = packageAt(home, JSON.stringify({ bin: { "tasma-daemon": "./dist/tasma-daemon.js" } }));
    const directory = join(home, "daemon-package");

    mkdirSync(join(directory, "dist"), { recursive: true });
    writeFileSync(join(directory, "dist", "tasma-daemon.js"), "");

    expect(daemonExecutable(resolve)).toBe(join(directory, "dist", "tasma-daemon.js"));
  });

  it("names an install that does not carry the daemon at all", () => {
    expect(() =>
      daemonExecutable(() => {
        throw new Error("Cannot find package");
      }),
    ).toThrow("the daemon package @tasma/daemon is not installed");
  });

  // A build that did not run, and a manifest naming no such command, are both
  // an install that resolved and still holds no program to spawn.
  it("names the package where the manifest declares no such executable, or names one that is not there", () => {
    const home = treeHome();
    const directory = join(home, "daemon-package");

    for (const manifest of [undefined, "{", JSON.stringify({}), JSON.stringify({ bin: "./dist/other.js" })]) {
      expect(() => daemonExecutable(packageAt(home, manifest)), String(manifest))
        .toThrow(`no daemon executable at ${directory}`);
    }

    expect(() => daemonExecutable(packageAt(home, JSON.stringify({ bin: { "tasma-daemon": "./dist/gone.js" } }))))
      .toThrow(`no daemon executable at ${join(directory, "dist", "gone.js")}`);
  });

  // The one thing resolution has to reach is the package this manifest declares
  // as a dependency; whether its build has run decides only which of the two
  // sentences comes back.
  it("reaches the daemon package through the dependency this package declares", () => {
    let found: string;

    try {
      found = daemonExecutable();
    } catch (error) {
      found = (error as Error).message;
    }

    expect(found).toContain("tasma-daemon.js");
  });
});
