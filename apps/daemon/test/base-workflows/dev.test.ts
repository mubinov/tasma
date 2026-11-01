import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openWorkflows } from "@tasma/engine";

const BASE_WORKFLOWS = join(import.meta.dirname, "..", "..", "base-workflows");

describe("the base workflow dev", () => {
  it("names only documents that exist", async () => {
    const { workflow } = await openWorkflows({ path: BASE_WORKFLOWS }).read("dev");
    const named = [...workflow.instructions, ...workflow.steps.map((step) => step.file)];
    expect(named.filter((path) => !existsSync(path))).toEqual([]);
  });
});
