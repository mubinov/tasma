import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// A setup file runs once per test file, so each file gets a home of its own and
// a test that never stubs HOME still cannot reach the real tree.
const home = mkdtempSync(join(tmpdir(), "tasma-test-home-"));

process.env.HOME = home;

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
