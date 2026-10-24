import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AGENT_STEP_IDLE_MS, HUMAN_STEP_IDLE_MS, idleLimit, idleTimer } from "../../src/chats/idle.js";
import { createProjectHost } from "../../src/projects/host.js";
import { onWorkflow, plant, plantWorkflow, projectsRoot, taskFile, taskText, workflowDir } from "../helpers.js";

/**
 * The idle limit over project ALPHA. ALPHA-1 follows the workflow "flow",
 * whose step "plan" a person owns and "build" an agent. ALPHA-2 has no
 * workflow, and ALPHA-3 names a workflow that does not exist.
 */
async function limits() {
  const root = await projectsRoot("ALPHA");
  await plant(join(workflowDir(root, "flow"), "steps", "plan.md"), "Plan.\n");
  await plant(join(workflowDir(root, "flow"), "steps", "build.md"), "Build.\n");
  await plantWorkflow(root, "flow", [
    "steps:",
    "  - {name: plan, file: steps/plan.md, owner: human}",
    "  - {name: build, file: steps/build.md, owner: agent}",
    "",
  ].join("\n"));
  await plant(taskFile(root, "ALPHA", "ALPHA-1"), onWorkflow("ALPHA-1", "flow"));
  await plant(taskFile(root, "ALPHA", "ALPHA-2"), taskText("ALPHA-2"));
  await plant(taskFile(root, "ALPHA", "ALPHA-3"), onWorkflow("ALPHA-3", "gone"));
  const host = createProjectHost({ root });
  onTestFinished(() => host.close());
  return idleLimit({ root, host });
}

describe("idleLimit", () => {
  it("gives 1 hour in a step that a person owns, and 10 minutes in a step that an agent owns", async () => {
    const limit = await limits();

    expect(await limit("ALPHA", "ALPHA-1", "plan")).toBe(HUMAN_STEP_IDLE_MS);
    expect(await limit("ALPHA", "ALPHA-1", "build")).toBe(AGENT_STEP_IDLE_MS);
    expect([HUMAN_STEP_IDLE_MS, AGENT_STEP_IDLE_MS]).toEqual([60 * 60 * 1000, 10 * 60 * 1000]);
  });

  it("gives 10 minutes when Tasma cannot find the owner", async () => {
    const limit = await limits();

    expect(await Promise.all([
      limit("ALPHA", "ALPHA-1", "review"),
      limit("ALPHA", "ALPHA-2", "plan"),
      limit("ALPHA", "ALPHA-3", "plan"),
      limit("ALPHA", "ALPHA-9", "plan"),
      limit("BETA", "BETA-1", "plan"),
    ])).toEqual(Array<number>(5).fill(AGENT_STEP_IDLE_MS));
  });
});

describe("idleTimer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function timer(limitMs = 1000) {
    vi.useFakeTimers();
    const state = { busy: false, expired: 0 };
    const idle = idleTimer({ limitMs, busy: () => state.busy, expire: () => (state.expired += 1) });
    return { idle, state };
  }

  it("expires at the limit after a touch, and not before", () => {
    const { idle, state } = timer();

    idle.touch();
    vi.advanceTimersByTime(999);
    expect(state.expired).toBe(0);
    vi.advanceTimersByTime(1);

    expect(state.expired).toBe(1);
  });

  it("starts again from zero at each touch", () => {
    const { idle, state } = timer();

    idle.touch();
    vi.advanceTimersByTime(800);
    idle.touch();
    vi.advanceTimersByTime(800);
    expect(state.expired).toBe(0);
    vi.advanceTimersByTime(200);

    expect(state.expired).toBe(1);
  });

  it("does not run while busy, and starts from zero at the touch after it", () => {
    const { idle, state } = timer();
    idle.touch();
    vi.advanceTimersByTime(500);

    state.busy = true;
    idle.touch();
    vi.advanceTimersByTime(5000);
    expect(state.expired).toBe(0);
    state.busy = false;
    idle.touch();
    vi.advanceTimersByTime(999);
    expect(state.expired).toBe(0);
    vi.advanceTimersByTime(1);

    expect(state.expired).toBe(1);
  });

  it("stops for good at a clear", () => {
    const { idle, state } = timer();
    idle.touch();

    idle.clear();
    idle.touch();
    vi.advanceTimersByTime(5000);

    expect(state.expired).toBe(0);
  });
});
