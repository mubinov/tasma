import { argv, stderr } from "node:process";
import { afterEach, expect, it, vi } from "vitest";

// The entry point reads the real argv and writes to the real stream, so the
// process is prepared around the one import that runs it. The value it is given
// is no port at all, so the run ends while the flag is read and nothing binds.
const original = [...argv];

afterEach(() => {
  argv.splice(0, argv.length, ...original);
  process.exitCode = 0;
  vi.restoreAllMocks();
});

it("hands argv to the daemon and reports the code it returns", async () => {
  const written = vi.spyOn(stderr, "write").mockReturnValue(true);
  // Everything after the node executable is replaced: main.ts reads
  // argv.slice(2), so the script path has to be filled as well.
  argv.splice(1, argv.length, "tasma-daemon", "--port", "nonsense");

  await import("../src/main.js");

  expect(written).toHaveBeenCalledWith('tasma-daemon: --port must be a whole number from 0 to 65535: "nonsense"\n');
  expect(process.exitCode).toBe(1);
});
