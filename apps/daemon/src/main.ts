#!/usr/bin/env node
import { argv, env, stderr, stdout } from "node:process";
import { runDaemon } from "./lifecycle/run.js";

// Not process.exit(): a write to stderr is asynchronous when it is a pipe, and
// exiting would truncate it.
process.exitCode = await runDaemon(argv.slice(2), { stdout, stderr }, env);
