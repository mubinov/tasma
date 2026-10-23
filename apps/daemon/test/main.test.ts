import { argv, stderr } from "node:process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The entry point reads the real argv and writes to the real stream, so the
// process is prepared around the one import that runs it. vitest keeps an
// imported module, so each test imports a new one.
const original = [...argv];

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  argv.splice(0, argv.length, ...original);
  process.exitCode = 0;
  vi.restoreAllMocks();
});

/** Runs the entry point with `args` after the script path, and gives the spy of the serve of each adapter. */
async function main(...args: string[]) {
  // Everything after the node executable is replaced: main.ts reads
  // argv.slice(2), so the script path has to be filled as well.
  argv.splice(1, argv.length, "tasma-daemon", ...args);
  const { AGENT_ADAPTERS } = await import("../src/lifecycle/run.js");
  const served = AGENT_ADAPTERS.map((adapter) => vi.spyOn(adapter, "serve").mockResolvedValue());
  await import("../src/main.js");
  return served;
}

it("hands argv to the daemon and reports the code it returns", async () => {
  const written = vi.spyOn(stderr, "write").mockReturnValue(true);
  // The value is no port at all, so the run ends while the flag is read and nothing binds.
  await main("--port", "nonsense");

  expect(written).toHaveBeenCalledWith('tasma-daemon: --port must be a whole number from 0 to 65535: "nonsense"\n');
  expect(process.exitCode).toBe(1);
});

it("serves the agent that --agent names, and starts no daemon", async () => {
  const written = vi.spyOn(stderr, "write").mockReturnValue(true);

  const [claude] = await main("--agent", "claude");

  expect(claude).toHaveBeenCalledTimes(1);
  expect(written).not.toHaveBeenCalled();
  expect(process.exitCode ?? 0).toBe(0);
});

it.each(["--agent nonsense", "--agent", "--agent claude --version"])("refuses %s, and serves nothing", async (line) => {
  const written = vi.spyOn(stderr, "write").mockReturnValue(true);

  const served = await main(...line.split(" "));

  expect(written).toHaveBeenCalledWith("tasma-daemon: --agent takes the name of one agent: claude\n");
  expect(process.exitCode).toBe(1);
  for (const serve of served) expect(serve).not.toHaveBeenCalled();
});
