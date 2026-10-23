#!/usr/bin/env node
import { argv, env, stderr, stdout } from "node:process";
import { DAEMON_NAME } from "@tasma/protocol";
import { AGENT_MODE } from "./agents/adapter.js";
import { AGENT_ADAPTERS, runDaemon } from "./lifecycle/run.js";

const args = argv.slice(2);

if (args[0] === AGENT_MODE) {
  const served = AGENT_ADAPTERS.filter((adapter) => adapter.serve !== undefined);
  // One name and nothing after it: the Claude adapter reads `--version`, `-v` and `--cli` anywhere in argv.
  const adapter = args.length === 2 ? served.find((one) => one.agent === args[1]) : undefined;
  if (adapter?.serve === undefined) {
    stderr.write(`${DAEMON_NAME}: ${AGENT_MODE} takes the name of one agent: ${served.map((one) => one.agent).join(", ")}\n`);
    process.exitCode = 1;
  } else {
    // The adapter owns the process from here: it serves ACP and exits when its stdin closes.
    await adapter.serve();
  }
} else {
  // Not process.exit(): a write to stderr is asynchronous when it is a pipe, and
  // exiting would truncate it.
  process.exitCode = await runDaemon(args, { stdout, stderr }, env);
}
