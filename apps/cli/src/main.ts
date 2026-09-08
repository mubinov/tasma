#!/usr/bin/env node
import { argv, env, stderr, stdin, stdout } from "node:process";
import { run } from "./run.js";
import { quietOnBrokenPipe } from "./stream.js";

// Both streams, because one redirection can put a single pipe under the two of
// them: `tasma task view <id> 2>&1 | head` closes it for both.
quietOnBrokenPipe(stdout);
quietOnBrokenPipe(stderr);

// Not process.exit(): a write to stdout is asynchronous when stdout is a pipe,
// and exiting would truncate it, so `tasma --help | less` would lose output.
process.exitCode = await run(argv.slice(2), { stdin, stdout, stderr }, env);
