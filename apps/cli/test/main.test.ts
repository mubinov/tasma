import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv, chdir, cwd, stderr, stdout } from "node:process";
import { afterEach, expect, it, vi } from "vitest";
import { treeHome } from "./helpers.js";

// The entry point reads the real argv and writes to the real stream, so the
// process is prepared around the one import that runs it.
const original = [...argv];
const startedIn = cwd();

afterEach(() => {
  argv.splice(0, argv.length, ...original);
  chdir(startedIn);
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // The entry point runs on import, so each case needs its own.
  vi.resetModules();
});

it("hands argv to run and reports the code it returns", async () => {
  const written = vi.spyOn(stdout, "write").mockReturnValue(true);
  // Everything after the node executable is replaced: main.ts reads
  // argv.slice(2), so the script path has to be filled as well.
  argv.splice(1, argv.length, "tasma", "--version");

  await import("../src/main.js");

  expect(written).toHaveBeenCalledWith(expect.stringMatching(/^tasma \d+\.\d+\.\d+\n$/));
  expect(process.exitCode).toBe(0);
});

// The real fault rather than a stand-in for it: a shell whose directory was
// removed under it makes process.cwd() throw, and the verb that would have
// resolved a project from it says so instead of dying on a stack trace.
it("reports a working directory it could not read, without reaching a daemon", async () => {
  const written = vi.spyOn(stderr, "write").mockReturnValue(true);
  const gone = mkdtempSync(join(tmpdir(), "tasma-gone-"));

  chdir(gone);
  rmSync(gone, { recursive: true, force: true });

  argv.splice(1, argv.length, "tasma", "task", "list");
  // The entry point reads the real environment: an address stated there is
  // refused before the dispatch this case is about, and with none stated the
  // target is a tree, which without a home of the test's own is the real one.
  vi.stubEnv("TASMA_DAEMON_URL", "");
  vi.stubEnv("HOME", treeHome());

  await import("../src/main.js");

  expect(written).toHaveBeenCalledWith(
    "tasma: the working directory could not be read; state a project with --project <tag>\n"
    + "Run 'tasma --help' for usage.\n",
  );
  expect(process.exitCode).toBe(2);
});
