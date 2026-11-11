import { QueryClient } from "@tanstack/react-query";
import type { AgentSetup, SetupCheck, SetupStatus, Success } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { daemonKeys } from "../../src/api/queries";
import {
  currentStep,
  doneCount,
  fullReadsFailing,
  hasFullAnswer,
  hasFullFailure,
  isChangeToDone,
  newestSetup,
  screenNeeded,
  setupNeeded,
  setupSteps,
  stepsNowDone,
  type SetupStep,
  type StepId,
  type StepInput,
} from "../../src/lib/setup-steps";
import { setupStatus, startOf } from "../helpers";

function input(overrides: Partial<StepInput> = {}): StepInput {
  return { status: setupStatus(), fullAnswered: true, fullFailed: false, skillCheckStopped: false, ...overrides };
}

function stepOf(steps: readonly SetupStep[], id: StepId): SetupStep {
  return steps.find((step) => step.id === id)!;
}

describe("setupNeeded", () => {
  const FAILING: Record<StepId, SetupStatus> = {
    install: setupStatus({}, { installed: "fail" }),
    login: setupStatus({}, { loggedIn: "fail" }),
    command: setupStatus({ cli: "fail" }),
    skill: setupStatus({}, { skill: "fail" }),
    project: setupStatus({ project: "fail" }),
    workflow: setupStatus({ workflow: "fail" }),
  };
  const steps = setupSteps(input()).map(({ id, name }) => [name, id] as const);

  it("is false with no status", () => {
    expect(setupNeeded(undefined, false)).toBe(false);
  });

  it("is false when every step passes", () => {
    expect(setupNeeded(setupStatus(), false)).toBe(false);
  });

  it.each(steps)("is true when the check of %s fails", (_name, id) => {
    const status = FAILING[id];

    expect(stepOf(setupSteps(input({ status })), id).state).toBe("to-do");
    expect(setupNeeded(status, false)).toBe(true);
  });

  it("does not count the skill after the check stopped", () => {
    expect(setupNeeded(FAILING.skill, true)).toBe(false);
    expect(setupNeeded(setupStatus({ project: "fail" }, { skill: "fail" }), true)).toBe(true);
  });

  it.each(steps.filter(([, id]) => id !== "skill"))("counts a failed check of %s after the check of the skill stopped", (_name, id) => {
    expect(setupNeeded(FAILING[id], true)).toBe(true);
  });

  it.each(["unknown", "not-run"] as const)("does not count %s", (check) => {
    const checks = { project: check, workflow: check, cli: check };
    const agent = { installed: check, loggedIn: check, skill: check };

    expect(setupNeeded(setupStatus(checks, agent), false)).toBe(false);
  });

  it("counts only the entry of Claude Code", () => {
    const other = { agent: "codex", installed: "fail", loggedIn: "fail", skill: "fail" } as unknown as AgentSetup;

    expect(setupNeeded(setupStatus({ agents: [other] }), false)).toBe(false);
    expect(setupNeeded(setupStatus({ agents: [other, ...setupStatus({}, { skill: "fail" }).agents] }), false)).toBe(true);
    expect(setupNeeded(setupStatus({ agents: [other, ...setupStatus({}, { installed: "fail" }).agents] }), false)).toBe(true);
    expect(setupNeeded(setupStatus({ agents: [other, ...setupStatus({}, { loggedIn: "fail" }).agents] }), false)).toBe(true);
  });
});

describe("screenNeeded", () => {
  const noFullEnd = { fullAnswered: false, fullFailed: false, skillCheckStopped: false };

  it("is true before the first full answer and the first full failure, also when no check fails", () => {
    expect(screenNeeded({ ...noFullEnd, status: startOf(setupStatus()) })).toBe(true);
    expect(screenNeeded({ ...noFullEnd, status: undefined })).toBe(true);
  });

  it.each([
    ["a full answer", { fullAnswered: true }],
    ["a full failure", { fullFailed: true }],
  ])("is false after %s when no check fails", (_end, end) => {
    expect(screenNeeded({ ...noFullEnd, ...end, status: setupStatus() })).toBe(false);
  });

  it("is true after a full answer when a check fails", () => {
    expect(screenNeeded({ ...noFullEnd, fullAnswered: true, status: setupStatus({}, { loggedIn: "fail" }) })).toBe(true);
    expect(screenNeeded({ ...noFullEnd, fullFailed: true, status: setupStatus({ project: "fail" }) })).toBe(true);
  });

  it("does not count the skill after the check stopped", () => {
    expect(screenNeeded({ ...noFullEnd, fullAnswered: true, skillCheckStopped: true, status: setupStatus({}, { skill: "fail" }) })).toBe(false);
  });
});

describe("newestSetup", () => {
  function entry(queryClient: QueryClient, key: readonly unknown[], data: SetupStatus, updatedAt: number): void {
    const answer: Success<SetupStatus> = { data, diagnostics: [] };

    queryClient.setQueryData([...daemonKeys.setup(), ...key], answer, { updatedAt });
  }

  it("is undefined with no entry", () => {
    expect(newestSetup(new QueryClient())).toBeUndefined();
  });

  it("skips an entry with no data", () => {
    const queryClient = new QueryClient();

    queryClient.getQueryCache().build(queryClient, { queryKey: [...daemonKeys.setup(), "full", undefined] });

    expect(newestSetup(queryClient)).toBeUndefined();
  });

  it("takes the latest answer across modes and skip values", () => {
    const queryClient = new QueryClient();
    const start = setupStatus({ project: "fail" });
    const full = setupStatus({ workflow: "fail" });
    const skipped = setupStatus({ cli: "fail" });

    entry(queryClient, ["full", true], skipped, 300);
    entry(queryClient, ["start", undefined], start, 100);
    entry(queryClient, ["full", undefined], full, 200);

    expect(newestSetup(queryClient)).toEqual(skipped);

    entry(queryClient, ["start", undefined], start, 400);

    expect(newestSetup(queryClient)).toEqual(start);
  });

  it("takes the entry made later when two answers carry the same time", () => {
    const queryClient = new QueryClient();
    const start = setupStatus({ project: "fail" });
    const full = setupStatus();

    entry(queryClient, ["start", undefined], start, 100);
    entry(queryClient, ["full", undefined], full, 100);

    expect(newestSetup(queryClient)).toEqual(full);
  });

  it("reads no other key", () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(daemonKeys.health(), { data: {}, diagnostics: [] });

    expect(newestSetup(queryClient)).toBeUndefined();
  });
});

describe("the full reads", () => {
  type Read = { mode?: "start" | "full"; skipSkill?: true; answeredAt?: number; failedAt?: number };

  const ANSWER: Success<SetupStatus> = { data: setupStatus(), diagnostics: [] };

  function reads(...entries: Read[]): QueryClient {
    const queryClient = new QueryClient();

    for (const { mode = "full", skipSkill, answeredAt, failedAt } of entries) {
      const queryKey = [...daemonKeys.setup(), mode, skipSkill];
      const query = queryClient.getQueryCache().build(queryClient, { queryKey });
      const answered = answeredAt === undefined ? {} : { data: ANSWER, dataUpdatedAt: answeredAt };
      const failed = failedAt === undefined ? {} : { errorUpdateCount: 1, errorUpdatedAt: failedAt };

      query.setState({ ...query.state, ...answered, ...failed });
    }

    return queryClient;
  }

  it("has no answer, no failure and no failing read with no entry", () => {
    const queryClient = reads();

    expect(hasFullAnswer(queryClient)).toBe(false);
    expect(hasFullFailure(queryClient)).toBe(false);
    expect(fullReadsFailing(queryClient)).toBe(false);
  });

  it("keeps an answer and a failure of another skip value", () => {
    const answered = reads({ answeredAt: 100 }, { skipSkill: true });
    const failed = reads({ failedAt: 100 }, { skipSkill: true });

    expect(hasFullAnswer(answered)).toBe(true);
    expect(hasFullFailure(answered)).toBe(false);
    expect(hasFullAnswer(failed)).toBe(false);
    expect(hasFullFailure(failed)).toBe(true);
  });

  it("reads as failing while the latest read of any skip value failed", () => {
    expect(fullReadsFailing(reads({ failedAt: 100 }, { skipSkill: true }))).toBe(true);
    expect(fullReadsFailing(reads({ answeredAt: 100 }, { skipSkill: true, failedAt: 200 }))).toBe(true);
    expect(fullReadsFailing(reads({ failedAt: 100 }, { skipSkill: true, answeredAt: 200 }))).toBe(false);

    const answeredAfterFailure = reads({ answeredAt: 100, failedAt: 200 }, { skipSkill: true, answeredAt: 300 });

    expect(fullReadsFailing(answeredAfterFailure)).toBe(false);
  });

  it("reads no start entry", () => {
    const queryClient = reads({ mode: "start", answeredAt: 100, failedAt: 200 });

    expect(hasFullAnswer(queryClient)).toBe(false);
    expect(hasFullFailure(queryClient)).toBe(false);
    expect(fullReadsFailing(queryClient)).toBe(false);
  });
});

describe("setupSteps", () => {
  it("lists the 6 steps in the order in which they depend on each other", () => {
    expect(setupSteps(input()).map(({ number, name }) => [number, name])).toEqual([
      [1, "Install the Claude Code CLI"],
      [2, "Log in to Claude Code"],
      [3, "Add the tasma command"],
      [4, "Install the tasma skill in Claude Code"],
      [5, "Add a project"],
      [6, "Add a workflow"],
    ]);
  });

  it("gives each step its owner label", () => {
    const fails = setupStatus({ cli: "fail", project: "fail", workflow: "fail" }, { installed: "fail", loggedIn: "fail", skill: "fail" });

    expect(setupSteps(input({ status: fails })).map(({ label }) => label)).toEqual([
      "You do this",
      "You do this",
      "Tasma does this",
      "Tasma does this",
      "You do this",
      "Tasma does this",
    ]);
  });

  it("gives each step its owner, in every state", () => {
    const owners = ["you", "you", "tasma", "tasma", "you", "tasma"];

    expect(setupSteps(input()).map(({ owner }) => owner)).toEqual(owners);
    expect(setupSteps(input({ status: undefined })).map(({ owner }) => owner)).toEqual(owners);
  });

  it("tells when the label names the owner", () => {
    const steps = setupSteps(input({ status: setupStatus({ project: "fail", workflow: "fail", cli: "unknown" }, { skill: "not-run" }) }));

    expect(steps.map(({ labelIsOwner }) => labelIsOwner)).toEqual([false, false, false, false, true, true]);
  });

  describe("the state table, in its order", () => {
    it("a: step 4 reads as not checked after the check stopped, whatever the answer says", () => {
      for (const skill of ["pass", "fail", "unknown", "not-run"] as const) {
        const step = stepOf(setupSteps(input({ status: setupStatus({}, { skill }), skillCheckStopped: true })), "skill");

        expect(step.state).toBe("stopped");
        expect(step.label).toBe("Not checked");
      }
    });

    it("a: step 4 also wins over no entry of Claude Code", () => {
      expect(stepOf(setupSteps(input({ status: setupStatus({ agents: [] }), skillCheckStopped: true })), "skill").state).toBe("stopped");
    });

    it("b: a pass is done", () => {
      for (const step of setupSteps(input())) {
        expect(step.state).toBe("done");
        expect(step.label).toBe("Done");
      }
    });

    it("c: steps 1 to 3 are in progress with no full answer and no failed read", () => {
      const steps = setupSteps(input({ fullAnswered: false, status: startOf(setupStatus()) }));

      for (const id of ["install", "login", "command"] as const) {
        expect(stepOf(steps, id).state).toBe("in-progress");
        expect(stepOf(steps, id).label).toBe("Check in progress");
      }
    });

    it("b wins over c: a step that passed in the start answer is done", () => {
      const steps = setupSteps(input({ fullAnswered: false }));

      expect(stepOf(steps, "install").state).toBe("done");
    });

    it("c applies only to steps 1 to 3", () => {
      const steps = setupSteps(input({ fullAnswered: false, status: setupStatus({ project: "fail" }, { skill: "fail" }) }));

      expect(stepOf(steps, "skill").state).toBe("to-do");
      expect(stepOf(steps, "project").state).toBe("to-do");
    });

    it("d: unknown cannot be checked", () => {
      const steps = setupSteps(input({ status: setupStatus({ project: "unknown" }) }));

      expect(stepOf(steps, "project").state).toBe("cannot-check");
      expect(stepOf(steps, "project").label).toBe("Cannot check");
    });

    it("d: with no entry of Claude Code, steps 1, 2 and 4 cannot be checked", () => {
      const steps = setupSteps(input({ status: setupStatus({ agents: [] }) }));

      expect(["install", "login", "skill"].map((id) => stepOf(steps, id as StepId).state)).toEqual(["cannot-check", "cannot-check", "cannot-check"]);
      expect(stepOf(steps, "command").state).toBe("done");
    });

    it("d: steps 1 to 3 cannot be checked after a failed read with no full answer", () => {
      const steps = setupSteps(input({
        fullAnswered: false,
        fullFailed: true,
        status: startOf(setupStatus()),
      }));

      for (const id of ["install", "login", "command"] as const) {
        expect(stepOf(steps, id).state).toBe("cannot-check");
      }
    });

    it("c wins over d: with no full answer, no entry of Claude Code is still in progress", () => {
      const steps = setupSteps(input({ fullAnswered: false, status: setupStatus({ agents: [] }) }));

      expect(stepOf(steps, "install").state).toBe("in-progress");
    });

    it("d wins over e: unknown of a step that waits cannot be checked", () => {
      const steps = setupSteps(input({ status: setupStatus({ project: "unknown", workflow: "unknown" }) }));

      expect(stepOf(steps, "project").state).toBe("cannot-check");
      expect(stepOf(steps, "workflow").state).toBe("cannot-check");
    });

    it("e: step 2 waits for step 1, and takes the owner label", () => {
      const step = stepOf(setupSteps(input({ status: setupStatus({}, { installed: "fail", loggedIn: "not-run" }) })), "login");

      expect(step.state).toBe("waits");
      expect(step.label).toBe("You do this");
      expect(step.waitsFor).toEqual({ number: 1, name: "Install the Claude Code CLI" });
    });

    it("e: step 6 waits for step 5", () => {
      const step = stepOf(setupSteps(input({ status: setupStatus({ project: "fail", workflow: "fail" }) })), "workflow");

      expect(step.state).toBe("waits");
      expect(step.waitsFor).toEqual({ number: 5, name: "Add a project" });
    });

    it("e wins over f: not-run of a step that waits waits", () => {
      const step = stepOf(setupSteps(input({ status: setupStatus({ project: "fail", workflow: "not-run" }) })), "workflow");

      expect(step.state).toBe("waits");
    });

    it("f: not-run with nothing to wait for cannot be checked", () => {
      const step = stepOf(setupSteps(input({ status: setupStatus({}, { skill: "not-run" }) })), "skill");

      expect(step.state).toBe("not-run");
      expect(step.label).toBe("Cannot check");
    });

    it("g: a fail shows its content, with the owner label", () => {
      const step = stepOf(setupSteps(input({ status: setupStatus({ project: "fail" }) })), "project");

      expect(step.state).toBe("to-do");
      expect(step.label).toBe("You do this");
    });

    it("reads as cannot-check with no status at all", () => {
      const steps = setupSteps(input({ status: undefined }));

      expect(steps.map(({ state }) => state)).toEqual(Array<string>(6).fill("cannot-check"));
    });
  });

  describe("the label of step 4 and the write", () => {
    const FAILS = setupStatus({}, { skill: "fail" });

    it("names the owner when the write has not started", () => {
      const step = stepOf(setupSteps(input({ status: FAILS })), "skill");

      expect(step.label).toBe("Tasma does this");
      expect(step.labelIsOwner).toBe(true);
    });

    it.each([
      ["running", "Install in progress"],
      ["cannot-install", "Cannot install"],
    ] as const)("follows the write while the step is to-do: %s", (skillInstall, label) => {
      const step = stepOf(setupSteps(input({ status: FAILS, skillInstall })), "skill");

      expect(step.state).toBe("to-do");
      expect(step.label).toBe(label);
      expect(step.labelIsOwner).toBe(false);
    });

    it.each(["running", "cannot-install"] as const)("keeps the labels of the other states with %s", (skillInstall) => {
      const label = (checks: Partial<StepInput>): string =>
        stepOf(setupSteps(input({ ...checks, skillInstall })), "skill").label;

      expect(label({ status: FAILS, skillCheckStopped: true })).toBe("Not checked");
      expect(label({ status: setupStatus() })).toBe("Done");
      expect(label({ status: setupStatus({}, { skill: "unknown" }) })).toBe("Cannot check");
      expect(label({ status: setupStatus({}, { skill: "not-run" }) })).toBe("Cannot check");
    });

    it.each(["running", "cannot-install"] as const)("changes no other step with %s", (skillInstall) => {
      const fails = setupStatus({ cli: "fail", project: "fail", workflow: "fail" }, { installed: "fail", loggedIn: "fail", skill: "fail" });
      const labels = setupSteps(input({ status: fails, skillInstall })).map(({ label }) => label);

      expect(labels.toSpliced(3, 1)).toEqual(["You do this", "You do this", "Tasma does this", "You do this", "Tasma does this"]);
    });
  });

  describe("step 5 and the project that the app added", () => {
    it("is done while the status does not see the project yet", () => {
      const steps = setupSteps(input({ status: setupStatus({ project: "fail", workflow: "fail" }), projectAdded: true }));

      expect(stepOf(steps, "project").state).toBe("done");
      expect(stepOf(steps, "project").label).toBe("Done");
      expect(stepOf(steps, "workflow").state).toBe("to-do");
    });

    it("is done also when the check of step 5 is unknown or did not run", () => {
      for (const project of ["unknown", "not-run"] as const) {
        const steps = setupSteps(input({ status: setupStatus({ project, workflow: "fail" }), projectAdded: true }));

        expect(stepOf(steps, "project").state).toBe("done");
      }
    });

    it("leaves step 6 done when its check passes", () => {
      const steps = setupSteps(input({ status: setupStatus({ project: "fail" }), projectAdded: true }));

      expect(stepOf(steps, "workflow").state).toBe("done");
    });

    it("follows the status when no project was added", () => {
      const steps = setupSteps(input({ status: setupStatus({ project: "fail", workflow: "fail" }), projectAdded: false }));

      expect(stepOf(steps, "project").state).toBe("to-do");
      expect(stepOf(steps, "workflow").state).toBe("waits");
    });
  });

  describe("the label of step 6 and the write", () => {
    const FAILS = setupStatus({ workflow: "fail" });

    it("names the owner when the write has not started", () => {
      const step = stepOf(setupSteps(input({ status: FAILS })), "workflow");

      expect(step.label).toBe("Tasma does this");
      expect(step.labelIsOwner).toBe(true);
    });

    it.each([
      ["running", "In progress"],
      ["cannot-add", "Cannot add"],
    ] as const)("follows the write while the step is to-do: %s", (workflowWrite, label) => {
      const step = stepOf(setupSteps(input({ status: FAILS, workflowWrite })), "workflow");

      expect(step.state).toBe("to-do");
      expect(step.label).toBe(label);
      expect(step.labelIsOwner).toBe(false);
    });

    it.each(["running", "cannot-add"] as const)("keeps the labels of the other states with %s", (workflowWrite) => {
      const label = (status: SetupStatus): string => stepOf(setupSteps(input({ status, workflowWrite })), "workflow").label;

      expect(label(setupStatus())).toBe("Done");
      expect(label(setupStatus({ workflow: "unknown" }))).toBe("Cannot check");
      expect(label(setupStatus({ workflow: "not-run" }))).toBe("Cannot check");
      expect(label(setupStatus({ project: "fail", workflow: "fail" }))).toBe("Tasma does this");
    });

    it.each(["running", "cannot-add"] as const)("changes no other step with %s", (workflowWrite) => {
      const fails = setupStatus({ cli: "fail", workflow: "fail" }, { installed: "fail", loggedIn: "fail", skill: "fail" });
      const labels = setupSteps(input({ status: fails, workflowWrite })).map(({ label }) => label);

      expect(labels.slice(0, 5)).toEqual(["You do this", "You do this", "Tasma does this", "Tasma does this", "Done"]);
    });
  });

  it("tells which steps can open", () => {
    const opens = (checks: Partial<StepInput>, id: StepId): boolean => stepOf(setupSteps(input(checks)), id).canOpen;

    expect(opens({}, "project")).toBe(false);
    expect(opens({ fullAnswered: false, status: setupStatus({}, { installed: "not-run" }) }, "install")).toBe(false);
    expect(opens({ skillCheckStopped: true }, "skill")).toBe(true);
    expect(opens({ status: setupStatus({ project: "unknown" }) }, "project")).toBe(true);
    expect(opens({ status: setupStatus({ project: "fail" }) }, "workflow")).toBe(false);
    expect(opens({ status: setupStatus({ project: "fail", workflow: "fail" }) }, "workflow")).toBe(true);
    expect(opens({ status: setupStatus({}, { skill: "not-run" }) }, "skill")).toBe(true);
    expect(opens({ status: setupStatus({ project: "fail" }) }, "project")).toBe(true);
  });
});

describe("currentStep", () => {
  it("is the first step to do", () => {
    const steps = setupSteps(input({ status: setupStatus({ project: "fail", workflow: "fail" }, { skill: "fail" }) }));

    expect(currentStep(steps)?.id).toBe("skill");
  });

  it("is none when no step is left", () => {
    expect(currentStep(setupSteps(input()))).toBeUndefined();
  });

  it("is none before the first full answer, also with a step to do", () => {
    const steps = setupSteps(input({
      fullAnswered: false,
      status: startOf(setupStatus({ project: "fail" })),
    }));

    expect(currentStep(steps)).toBeUndefined();
  });

  it("is step 1 after a failed first full read", () => {
    const steps = setupSteps(input({
      fullAnswered: false,
      fullFailed: true,
      status: startOf(setupStatus()),
    }));

    expect(currentStep(steps)?.id).toBe("install");
  });

  it("is a step that cannot be checked", () => {
    expect(currentStep(setupSteps(input({ status: setupStatus({ project: "unknown" }) })))?.id).toBe("project");
  });

  it("is not a step that waits, or a stopped step", () => {
    const waits = setupSteps(input({ status: setupStatus({ workflow: "fail", project: "not-run" }) }));
    const stopped = setupSteps(input({ skillCheckStopped: true, status: setupStatus({}, { skill: "fail" }) }));

    expect(currentStep(waits)).toBeUndefined();
    expect(currentStep(stopped)).toBeUndefined();
  });

  it("is not a step that the answer did not check", () => {
    expect(currentStep(setupSteps(input({ status: setupStatus({}, { skill: "not-run" }) })))).toBeUndefined();
  });
});

describe("doneCount", () => {
  it("counts only the steps that are done", () => {
    const check: SetupCheck = "fail";

    expect(doneCount(setupSteps(input()))).toBe(6);
    expect(doneCount(setupSteps(input({ status: setupStatus({ project: check, workflow: check }) })))).toBe(4);
    expect(doneCount(setupSteps(input({ skillCheckStopped: true })))).toBe(5);
  });
});

describe("isChangeToDone", () => {
  it.each(["cannot-check", "waits", "not-run", "to-do"] as const)("is a change from %s to done", (from) => {
    expect(isChangeToDone(from, "done")).toBe(true);
  });

  it.each(["in-progress", "stopped", "done"] as const)("is no change from %s", (from) => {
    expect(isChangeToDone(from, "done")).toBe(false);
  });

  it("is no change to a state other than done", () => {
    expect(isChangeToDone("to-do", "cannot-check")).toBe(false);
  });
});

describe("stepsNowDone", () => {
  it("names a step that was to do and now passes", () => {
    const before = setupSteps(input({ status: setupStatus({ project: "fail", workflow: "fail" }) }));
    const after = setupSteps(input({ status: setupStatus({ workflow: "fail" }) }));

    expect(stepsNowDone(before, after).map(({ id }) => id)).toEqual(["project"]);
  });

  it.each([
    ["cannot be checked", { project: "unknown" as const }],
    ["waits", { project: "fail" as const, workflow: "fail" as const }],
    ["was not run", { workflow: "not-run" as const }],
  ])("names a step that %s", (_name, checks) => {
    const before = setupSteps(input({ status: setupStatus(checks) }));
    const after = setupSteps(input());

    expect(stepsNowDone(before, after).length).toBeGreaterThan(0);
  });

  it("does not name a step that was in progress", () => {
    const before = setupSteps(input({ fullAnswered: false, status: startOf(setupStatus()) }));
    const after = setupSteps(input());

    expect(stepsNowDone(before, after)).toEqual([]);
  });

  it("does not name a step that stays done, or a step that does not pass", () => {
    const steps = setupSteps(input({ status: setupStatus({ project: "fail" }) }));

    expect(stepsNowDone(steps, steps)).toEqual([]);
  });

  it("does not name a stopped step", () => {
    const before = setupSteps(input({ skillCheckStopped: true, status: setupStatus({}, { skill: "not-run" }) }));
    const after = setupSteps(input());

    expect(stepsNowDone(before, after)).toEqual([]);
  });
});
