import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { openWorkflows } from "@tasma/engine";

const BASE_WORKFLOWS = join(import.meta.dirname, "..", "..", "base-workflows");
const DEV = join(BASE_WORKFLOWS, "dev");

const NOT_WRITTEN_YET = [
  "steps/setup.md",
  "steps/implement.md",
  "steps/review.md",
  "steps/test.md",
  "steps/user-review.md",
  "steps/integrate.md",
];

describe("the base workflow dev", () => {
  it("names only documents that exist", async () => {
    const { workflow } = await openWorkflows({ path: BASE_WORKFLOWS }).read("dev");
    const named = [...workflow.instructions, ...workflow.steps.map((step) => step.file)];
    const missing = named
      .filter((path) => !existsSync(path))
      .map((path) => relative(DEV, path))
      .filter((path) => !NOT_WRITTEN_YET.includes(path));
    expect(missing).toEqual([]);
    expect(NOT_WRITTEN_YET.filter((path) => existsSync(join(DEV, path)))).toEqual([]);
  });
});
