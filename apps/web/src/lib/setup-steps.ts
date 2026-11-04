import type { QueryClient, QueryState } from "@tanstack/react-query";
import type { AgentSetup, SetupCheck, SetupStatus, Success } from "@tasma/protocol";
import { daemonKeys } from "../api/queries";

export const SETUP_PATH = "/setup";

export type StepId = "install" | "login" | "command" | "skill" | "project" | "workflow";

/**
 * In the order in which a step takes its state: `stopped` is step 4 after the
 * check stopped, `waits` a step whose needed step is not done, and `not-run` a
 * check that did not run although nothing holds it back.
 */
export type StepState = "stopped" | "done" | "in-progress" | "cannot-check" | "waits" | "not-run" | "to-do";

export type SetupOwner = "you" | "tasma";

/** The write that installs the skill runs, or ended with a result that installed nothing. */
export type SkillInstallState = "running" | "cannot-install";

export type SetupStep = {
  id: StepId;
  number: number;
  name: string;
  owner: SetupOwner;
  state: StepState;
  label: string;
  labelIsOwner: boolean;
  /** A step that is done or in progress is a plain row. */
  canOpen: boolean;
  /** The step that a step in `waits` needs. */
  waitsFor?: { number: number; name: string };
};

export type StepInput = {
  status: SetupStatus | undefined;
  /** A full read answered, also under another skip value. */
  fullAnswered: boolean;
  /** A full read failed. */
  fullFailed: boolean;
  skillCheckStopped: boolean;
  /** The state of the write that installs the skill, for the label of step 4. */
  skillInstall?: SkillInstallState | undefined;
};

const OWNER_LABELS: Record<SetupOwner, string> = { you: "You do this", tasma: "Tasma does this" };

type StepDefinition = {
  id: StepId;
  name: string;
  owner: SetupOwner;
  needs?: StepId;
  /** Only a full read answers its check. */
  fullOnly?: boolean;
  check: (status: SetupStatus | undefined, agent: AgentSetup | undefined) => SetupCheck | undefined;
};

const DEFINITIONS: readonly StepDefinition[] = [
  { id: "install", name: "Install Claude Code", owner: "you", fullOnly: true, check: (_status, agent) => agent?.installed },
  { id: "login", name: "Log in to Claude Code", owner: "you", fullOnly: true, needs: "install", check: (_status, agent) => agent?.loggedIn },
  { id: "command", name: "Add the tasma command", owner: "tasma", fullOnly: true, check: (status) => status?.cli },
  { id: "skill", name: "Install the tasma skill in Claude Code", owner: "tasma", check: (_status, agent) => agent?.skill },
  { id: "project", name: "Add a project", owner: "you", check: (status) => status?.project },
  { id: "workflow", name: "Add a workflow", owner: "you", needs: "project", check: (status) => status?.workflow },
];

const STATE_LABELS: Partial<Record<StepState, string>> = {
  "stopped": "Not checked",
  "done": "Done",
  "in-progress": "Check in progress",
  "cannot-check": "Cannot check",
  "not-run": "Cannot check",
};

const SKILL_INSTALL_LABELS: Record<SkillInstallState, string> = { "running": "Install in progress", "cannot-install": "Cannot install" };

function claudeOf(status: SetupStatus | undefined): AgentSetup | undefined {
  return status?.agents.find(({ agent }) => agent === "claude");
}

/** Whether a setup trigger fails. `unknown` and `not-run` never count, and neither does no status. */
export function setupNeeded(status: SetupStatus | undefined, skillCheckStopped: boolean): boolean {
  return status?.project === "fail"
    || status?.workflow === "fail"
    || (!skillCheckStopped && claudeOf(status)?.skill === "fail");
}

/**
 * The answer with the latest time of all setup entries in the cache. An entry
 * made later wins a tie, as the start read always comes before a full read.
 */
export function newestSetup(queryClient: QueryClient): SetupStatus | undefined {
  let newest: { at: number; status: SetupStatus } | undefined;

  for (const { state } of queryClient.getQueryCache().findAll({ queryKey: daemonKeys.setup() })) {
    const answer = state.data as Success<SetupStatus> | undefined;

    if (answer !== undefined && (newest === undefined || state.dataUpdatedAt >= newest.at)) {
      newest = { at: state.dataUpdatedAt, status: answer.data };
    }
  }

  return newest?.status;
}

/**
 * Every skip value counts: a change of the stored choice starts an entry with
 * no answer and no failure of its own.
 */
function fullReads(queryClient: QueryClient): QueryState[] {
  return queryClient.getQueryCache().findAll({ queryKey: [...daemonKeys.setup(), "full"] }).map(({ state }) => state);
}

export function hasFullAnswer(queryClient: QueryClient): boolean {
  return fullReads(queryClient).some(({ data }) => data !== undefined);
}

export function hasFullFailure(queryClient: QueryClient): boolean {
  return fullReads(queryClient).some(({ errorUpdateCount }) => errorUpdateCount > 0);
}

/** The latest full read that ended failed. */
export function fullReadsFailing(queryClient: QueryClient): boolean {
  const reads = fullReads(queryClient);
  const failedAt = Math.max(0, ...reads.map(({ errorUpdatedAt }) => errorUpdatedAt));
  const answeredAt = Math.max(0, ...reads.map(({ dataUpdatedAt }) => dataUpdatedAt));

  return failedAt > answeredAt;
}

function stateOf(
  definition: StepDefinition,
  check: SetupCheck | undefined,
  needDone: boolean,
  input: StepInput,
): StepState {
  const noFullAnswer = definition.fullOnly === true && !input.fullAnswered;

  if (definition.id === "skill" && input.skillCheckStopped) {
    return "stopped";
  }
  if (check === "pass") {
    return "done";
  }
  if (noFullAnswer && !input.fullFailed) {
    return "in-progress";
  }
  if (check === "unknown" || check === undefined || noFullAnswer) {
    return "cannot-check";
  }
  if (!needDone) {
    return "waits";
  }

  return check === "not-run" ? "not-run" : "to-do";
}

export function setupSteps(input: StepInput): SetupStep[] {
  const agent = claudeOf(input.status);
  const steps: SetupStep[] = [];

  DEFINITIONS.forEach((definition, index) => {
    const needed = steps.find(({ id }) => id === definition.needs);
    const needDone = needed === undefined || needed.state === "done";
    const state = stateOf(definition, definition.check(input.status, agent), needDone, input);
    const stateLabel = definition.id === "skill" && state === "to-do" && input.skillInstall !== undefined
      ? SKILL_INSTALL_LABELS[input.skillInstall]
      : STATE_LABELS[state];

    steps.push({
      id: definition.id,
      number: index + 1,
      name: definition.name,
      owner: definition.owner,
      state,
      label: stateLabel ?? OWNER_LABELS[definition.owner],
      labelIsOwner: stateLabel === undefined,
      canOpen: state !== "done" && state !== "in-progress",
      ...(state === "waits" && needed !== undefined ? { waitsFor: { number: needed.number, name: needed.name } } : {}),
    });
  });

  return steps;
}

/** No step is current while a step of the full read has no state yet. */
export function currentStep(steps: readonly SetupStep[]): SetupStep | undefined {
  return steps.some(({ state }) => state === "in-progress")
    ? undefined
    : steps.find(({ state }) => state === "cannot-check" || state === "to-do");
}

export function doneCount(steps: readonly SetupStep[]): number {
  return steps.filter(({ state }) => state === "done").length;
}

const CAN_CHANGE_TO_DONE: ReadonlySet<StepState> = new Set(["cannot-check", "waits", "not-run", "to-do"]);

/** A step that was in progress had no state to change from. */
export function isChangeToDone(from: StepState, to: StepState): boolean {
  return to === "done" && CAN_CHANGE_TO_DONE.has(from);
}

/** The steps that the answer after `before` completed. */
export function stepsNowDone(before: readonly SetupStep[], after: readonly SetupStep[]): SetupStep[] {
  return after.filter(({ state }, index) => isChangeToDone(before[index]!.state, state));
}
