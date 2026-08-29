import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTask } from "@tasma/engine";
import { workspaceRoot } from "../workspace.js";

const CONTRACT = join(workspaceRoot, "docs", "task-file-format.md");
const REFERENCE_FIXTURE = join(workspaceRoot, "packages", "engine", "test", "fixtures", "valid", "example.md");

const contract = readFileSync(CONTRACT, "utf8");

/**
 * The reference example. The contract carries it as the first block it fences
 * with three backticks and the `markdown` info string; a document that stops
 * doing so fails here rather than comparing some other block.
 */
function referenceExample(): string {
  const open = "\n```markdown\n";
  const start = contract.indexOf(open);
  const end = start === -1 ? -1 : contract.indexOf("\n```\n", start + open.length);
  if (end === -1) throw new Error(`${CONTRACT} carries no fenced markdown block`);
  return contract.slice(start + open.length, end + 1);
}

describe("docs/task-file-format.md", () => {
  it("carries the reference example the engine fixture parses", () => {
    expect(referenceExample()).toBe(readFileSync(REFERENCE_FIXTURE, "utf8"));
  });

  it("carries an example that parses without a diagnostic", () => {
    expect(parseTask(referenceExample()).diagnostics).toEqual([]);
  });
});
