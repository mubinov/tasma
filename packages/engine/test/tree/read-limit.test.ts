import { mkdir } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { readTree } from "../../src/tree/state.js";
import { projectsRoot } from "../store/helpers.js";
import { workflowDir } from "../workflow/helpers.js";

const reads = vi.hoisted(() => ({ counting: false, running: 0, most: 0 }));

// A counted read takes a moment, so the reads that one list starts at once overlap.
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  function counted<T extends (...args: never[]) => Promise<unknown>>(call: T): T {
    return (async (...args: Parameters<T>) => {
      if (!reads.counting) return call(...args);
      reads.running += 1;
      reads.most = Math.max(reads.most, reads.running);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await call(...args);
      } finally {
        reads.running -= 1;
      }
    }) as T;
  }
  return { ...actual, stat: counted(actual.stat), lstat: counted(actual.lstat) };
});

describe("the read of a tree", () => {
  it("reads a few entries of a long list at a time, and reads them all", async () => {
    const tags = Array.from({ length: 100 }, (_, at) => `P${at}`);
    const root = await projectsRoot(...tags);
    for (let at = 0; at < 100; at += 1) await mkdir(workflowDir(root, `flow-${at}`), { recursive: true });

    reads.counting = true;
    const state = await readTree(root).finally(() => (reads.counting = false));

    expect(reads.most).toBeLessThan(50);
    expect(state.projects.tags.size).toBe(100);
    expect(state.workflows.names.size).toBe(100);
  });
});
