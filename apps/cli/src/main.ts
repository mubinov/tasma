#!/usr/bin/env node
import { argv, cwd, env, stderr, stdin, stdout } from "node:process";
import { run } from "./run.js";
import { quietOnBrokenPipe } from "./stream.js";

// Both streams, because one redirection can put a single pipe under the two of
// them: `tasma task view <id> 2>&1 | head` closes it for both.
quietOnBrokenPipe(stdout);
quietOnBrokenPipe(stderr);

/**
 * The directory the shell stands in, empty where it could not be read.
 *
 * A removed directory makes `cwd()` throw. Only the two verbs that resolve a
 * project read the value, and each refuses the empty one with a line of its own,
 * rather than every verb dying on a stack trace.
 */
function here(): string {
  try {
    return cwd();
  } catch {
    return "";
  }
}

// Not process.exit(): a write to stdout is asynchronous when stdout is a pipe,
// and exiting would truncate it, so `tasma --help | less` would lose output.
process.exitCode = await run(argv.slice(2), { stdin, stdout, stderr }, env, here());
