#!/usr/bin/env node
import { argv, env, stderr, stdout } from "node:process";
import { run } from "./run.js";

// Not process.exit(): a write to stdout is asynchronous when stdout is a pipe,
// and exiting would truncate it, so `tasma --help | less` would lose output.
process.exitCode = await run(argv.slice(2), { stdout, stderr }, env);
