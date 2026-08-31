import { stderr } from "node:process";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
});

it("reports that it is not implemented, on stderr, and fails", async () => {
  const written = vi.spyOn(stderr, "write").mockReturnValue(true);

  await import("../src/main.js");

  expect(written).toHaveBeenCalledWith("tasma-daemon: not implemented\n");
  expect(process.exitCode).toBe(1);
});
