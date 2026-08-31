import { argv, stdout } from "node:process";
import { afterEach, expect, it, vi } from "vitest";

// The entry point reads the real argv and writes to the real stream, so the
// process is prepared around the one import that runs it.
const original = [...argv];

afterEach(() => {
  argv.splice(0, argv.length, ...original);
  process.exitCode = 0;
  vi.restoreAllMocks();
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
