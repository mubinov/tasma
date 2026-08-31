import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceRoot } from "../workspace.js";
import { firstFencedBlock } from "./fenced-block.js";

const CONTRACT = join(workspaceRoot, "docs", "workflow-file-format.md");
const REFERENCE_FIXTURE = join(
  workspaceRoot,
  "packages",
  "engine",
  "test",
  "fixtures",
  "workflows",
  "valid",
  "full.yml",
);

describe("docs/workflow-file-format.md", () => {
  it("carries the reference workflow the engine fixture loads", () => {
    expect(firstFencedBlock(CONTRACT, "yaml")).toBe(readFileSync(REFERENCE_FIXTURE, "utf8"));
  });
});
