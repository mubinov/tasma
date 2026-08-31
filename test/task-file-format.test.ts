import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTask } from "@tasma/engine";
import { workspaceRoot } from "../workspace.js";
import { firstFencedBlock } from "./fenced-block.js";

const CONTRACT = join(workspaceRoot, "docs", "task-file-format.md");
const REFERENCE_FIXTURE = join(workspaceRoot, "packages", "engine", "test", "fixtures", "valid", "example.md");

describe("docs/task-file-format.md", () => {
  it("carries the reference example the engine fixture parses", () => {
    expect(firstFencedBlock(CONTRACT, "markdown")).toBe(readFileSync(REFERENCE_FIXTURE, "utf8"));
  });

  it("carries an example that parses without a diagnostic", () => {
    expect(parseTask(firstFencedBlock(CONTRACT, "markdown")).diagnostics).toEqual([]);
  });
});
