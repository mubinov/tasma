// A stand-in for the daemon, for the paths that spawn one.
//
// It imports nothing from the workspace: what those paths drive is a program
// found by resolution and run by Node, so the fixture repeats the three names it
// shares with the daemon rather than importing them.
//
// The scenario stands in a file at the root of the home, because the CLI spawns
// the executable with no arguments and hands it the tree through `HOME` alone.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import process from "node:process";

const DAEMON_NAME = "tasma-daemon";
const TREE_DIRNAME = ".tasma";
const DAEMON_RECORD_FILE = "daemon.json";

/** How long a scenario that waits for a signal stands, so a fixture never outlives the run that spawned it. */
const LIFETIME_MS = 60_000;

const home = process.env.HOME ?? "";
const record = join(home, TREE_DIRNAME, DAEMON_RECORD_FILE);

function writeRecord(port: number): void {
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, JSON.stringify({ port, pid: process.pid }));
}

/** Holds the process until the test ends it, and ends it in any case. */
function stand(onSignal: () => void): void {
  setTimeout(() => {
    process.exit(0);
  }, LIFETIME_MS);
  process.on("SIGTERM", onSignal);
}

/** A port bound and released, so nothing listens on it and a probe of it fails at once. */
async function freePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  return port;
}

async function serves(options: { clearsRecord: boolean }): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, data: { name: DAEMON_NAME, version: "0.0.0" }, diagnostics: [] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  writeRecord(port);
  process.stdout.write(`${DAEMON_NAME} 0.0.0 at http://127.0.0.1:${port}\n`);

  stand(() => {
    server.closeAllConnections();
    server.close(() => {
      // The record last, as the daemon removes it last: it is what a caller
      // waiting for the stop reads. A shutdown that fails before it gets there
      // leaves the record standing, which is what `leaves-record` is.
      if (options.clearsRecord) rmSync(record, { force: true });
      process.exit(0);
    });
  });
}

async function hangs(): Promise<void> {
  writeRecord(await freePort());

  stand(() => {
    process.exit(0);
  });
}

const scenario = readFileSync(join(home, "scenario"), "utf8").trim();

switch (scenario) {
  case "serves":
    await serves({ clearsRecord: true });
    break;
  case "leaves-record":
    await serves({ clearsRecord: false });
    break;
  case "hangs":
    await hangs();
    break;
  case "refuses":
    process.stderr.write("port 8278 cannot be bound: EACCES\n");
    process.exit(1);
    break;
  // The captured output survives as an open descriptor and its name does not,
  // which is how a reader of that name finds nothing to quote back.
  case "vanishes":
    rmSync(join(home, "tasma-daemon.out"), { force: true });
    process.stderr.write("gone\n");
    process.exit(1);
    break;
  case "blank":
    process.stderr.write("\n \n");
    process.exit(1);
    break;
  case "killed":
    process.kill(process.pid, "SIGKILL");
    break;
  case "stands-down":
    process.exit(0);
    break;
  // A daemon of another tree holds the port this one asked for. It stands down
  // as it does for one of its own tree, and this tree gets no record.
  case "stands-down-elsewhere":
    process.stderr.write(`${DAEMON_NAME}: a daemon is already serving at http://127.0.0.1:8278\n`);
    process.exit(0);
    break;
  default:
    process.stderr.write(`no such scenario: ${scenario}\n`);
    process.exit(1);
}
