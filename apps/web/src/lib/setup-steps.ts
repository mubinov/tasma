import type { QueryClient, QueryState } from "@tanstack/react-query";
import {
  isAgentReady,
  type AgentSetup,
  type AgentSkillInstall,
  type ChatAgent,
  type SetupCheck,
  type SetupStatus,
  type Success,
} from "@tasma/protocol";
import type { SkillInstallEnd } from "../api/mutations";
import { daemonKeys } from "../api/queries";
import { useUiStore } from "../store/ui";
import { agentTexts } from "./agent-texts";

export const SETUP_PATH = "/setup";

export const READ_INTERVAL_MS = 5000;

export const READ_FAILED_WORDS = `Tasma cannot check the steps now. It tries again every ${String(READ_INTERVAL_MS / 1000)} seconds.`;

export const STILL_CANNOT_CHECK_WORDS = "Tasma still cannot check this.";

/** The daemon gives the install of each agent 2 minutes, one agent after the other. */
export function installMinutes(agentCount: number): number {
  return 2 * agentCount;
}

export function installStartedWords(agentCount: number): string {
  return `Install in progress. This can take up to ${String(installMinutes(agentCount))} minutes.`;
}

export function installFailedWords(step: number): string {
  return `Tasma cannot install the skill. The output is in step ${String(step)}, above the Try again button.`;
}

export function noNpxWords(step: number): string {
  return `Tasma cannot find npx. The plugin commands are in step ${String(step)}, above the Try again button.`;
}

export type ScreenStepId = "agent" | "command" | "skill" | "project" | "workflow";

/** The steps of the dialog of one agent. */
export type AgentStepId = "install" | "login" | "skill";

export type StepId = ScreenStepId | AgentStepId;

/**
 * In the order in which a step takes its state: `stopped` is the skill step
 * after the check stopped, `waits` a step whose needed step is not done, and
 * `not-run` a check that did not run although nothing holds it back.
 */
export type StepState = "stopped" | "done" | "in-progress" | "cannot-check" | "waits" | "not-run" | "to-do";

export type SetupOwner = "you" | "tasma";

/** The write that installs the skill runs, or ended with a result that installed nothing. */
export type SkillInstallState = "running" | "cannot-install";

/** The writes of steps 4 and 5 run, or the last workflow write failed. */
export type WorkflowWriteState = "running" | "cannot-add";

export type SetupStep<Id extends StepId = StepId> = {
  id: Id;
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
  /** The state of the write that installs the skill, for the label of the skill step. */
  skillInstall?: SkillInstallState | undefined;
  /** The app created a project, and no status since then gave `project: "pass"`. Step 4 is then done. */
  projectAdded?: boolean;
  /** The state of the writes that add the workflow, for the label of step 5. */
  workflowWrite?: WorkflowWriteState | undefined;
};

const OWNER_LABELS: Record<SetupOwner, string> = { you: "You do this", tasma: "Tasma does this" };

type StepDefinition<Source, Id extends StepId> = {
  id: Id;
  name: string;
  owner: SetupOwner;
  needs?: Id;
  /** Only a full read answers its check. */
  fullOnly?: boolean;
  check: (source: Source) => SetupCheck | undefined;
};

/** One pass is enough. */
function anyPasses(checks: readonly SetupCheck[]): SetupCheck {
  if (checks.includes("pass")) {
    return "pass";
  }
  if (checks.every((check) => check === "fail")) {
    return "fail";
  }

  return checks.includes("unknown") ? "unknown" : "not-run";
}

/** Whether an agent is ready, as one check. */
function readiness(entry: AgentSetup): SetupCheck {
  const { installed, loggedIn } = entry;

  if (isAgentReady(entry)) {
    return "pass";
  }
  if (installed === "fail" || loggedIn === "fail") {
    return "fail";
  }

  return installed === "unknown" || loggedIn === "unknown" ? "unknown" : "not-run";
}

/** The skill of a ready agent counts. With no ready agent, as in a start read, the skill of each agent counts. */
function skillCheck(status: SetupStatus): SetupCheck {
  const ready = status.agents.filter(isAgentReady);

  return anyPasses((ready.length > 0 ? ready : status.agents).map(({ skill }) => skill));
}

type Status = SetupStatus | undefined;

const SCREEN_STEPS: readonly StepDefinition<Status, ScreenStepId>[] = [
  {
    id: "agent",
    name: "Set up a coding agent",
    owner: "you",
    fullOnly: true,
    check: (status) => (status === undefined ? undefined : anyPasses(status.agents.map(readiness))),
  },
  { id: "command", name: "Add the tasma command", owner: "tasma", fullOnly: true, check: (status) => status?.cli },
  {
    id: "skill",
    name: "Install the tasma skill",
    owner: "tasma",
    needs: "agent",
    check: (status) => (status === undefined ? undefined : skillCheck(status)),
  },
  { id: "project", name: "Add a project", owner: "you", check: (status) => status?.project },
  { id: "workflow", name: "Add a workflow", owner: "tasma", needs: "project", check: (status) => status?.workflow },
];

type Entry = AgentSetup | undefined;

function agentDefinitions(agent: ChatAgent): StepDefinition<Entry, AgentStepId>[] {
  const { cli, account } = agentTexts(agent);

  return [
    { id: "install", name: `Install the ${cli}`, owner: "you", fullOnly: true, check: (entry) => entry?.installed },
    { id: "login", name: `Log in to ${account}`, owner: "you", fullOnly: true, needs: "install", check: (entry) => entry?.loggedIn },
    { id: "skill", name: `Install the tasma skill in ${account}`, owner: "tasma", needs: "login", check: (entry) => entry?.skill },
  ];
}

const STATE_LABELS: Partial<Record<StepState, string>> = {
  "stopped": "Not checked",
  "done": "Done",
  "in-progress": "Check in progress",
  "cannot-check": "Cannot check",
  "not-run": "Cannot check",
};

const SKILL_INSTALL_LABELS: Record<SkillInstallState, string> = { "running": "Install in progress", "cannot-install": "Cannot install" };

const WORKFLOW_WRITE_LABELS: Record<WorkflowWriteState, string> = { "running": "In progress", "cannot-add": "Cannot add" };

/** The label of a step to do whose write runs or failed. */
function writeLabel(id: StepId, input: StepInput): string | undefined {
  if (id === "skill" && input.skillInstall !== undefined) {
    return SKILL_INSTALL_LABELS[input.skillInstall];
  }
  if (id === "workflow" && input.workflowWrite !== undefined) {
    return WORKFLOW_WRITE_LABELS[input.workflowWrite];
  }

  return undefined;
}

/** The agents that step 3 of the screen installs the skill for. */
export function skillTargets(status: SetupStatus): ChatAgent[] {
  return status.agents.filter(isAgentReady).map(({ agent }) => agent);
}

/** An install that installed the skill for no agent: each entry failed. */
export type NothingInstalled
  = | Exclude<SkillInstallEnd, { result: "ended" }>
    | { result: "ended"; agents: Extract<AgentSkillInstall, { result: "failed" }>[] };

/** Its step shows the result of such an install. */
export function installsNothing(answer: SkillInstallEnd): answer is NothingInstalled {
  return answer.result !== "ended" || !answer.agents.some(({ result }) => result === "installed");
}

/** The answer of an install that installed nothing, and the agents that it was for. */
export type InstallResult = { answer: NothingInstalled; agents: readonly ChatAgent[] };

/** An install of any place runs, or the last install of this place installed nothing. */
export function skillInstallState(running: boolean, result: InstallResult | undefined): SkillInstallState | undefined {
  if (running) {
    return "running";
  }

  return result === undefined ? undefined : "cannot-install";
}

/**
 * Whether a step of setup fails. Each step counts, but steps 1 and 2 cannot
 * open the screen at start, because a start read gives `not-run` for them.
 * `unknown` and `not-run` never count, and neither does no status.
 */
export function setupNeeded(status: SetupStatus | undefined, skillCheckStopped: boolean): boolean {
  return SCREEN_STEPS.some(({ id, check }) => (id !== "skill" || !skillCheckStopped) && check(status) === "fail");
}

/** The open screen also waits for the first end of a full read, as steps 1 and 2 have no state before it. */
export function screenNeeded({
  status,
  fullAnswered,
  fullFailed,
  skillCheckStopped,
}: Pick<StepInput, "status" | "fullAnswered" | "fullFailed" | "skillCheckStopped">): boolean {
  return setupNeeded(status, skillCheckStopped) || (!fullAnswered && !fullFailed);
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

/** A render holds the state of the answers before it, and an end of a read or a write needs the newest. */
export function stepInputNow(queryClient: QueryClient): StepInput {
  return {
    status: newestSetup(queryClient),
    fullAnswered: hasFullAnswer(queryClient),
    fullFailed: hasFullFailure(queryClient),
    skillCheckStopped: useUiStore.getState().skillCheckStopped,
  };
}

function stateOf<Source, Id extends StepId>(
  definition: StepDefinition<Source, Id>,
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

function stepsOf<Source, Id extends StepId>(
  definitions: readonly StepDefinition<Source, Id>[],
  source: Source,
  input: StepInput,
): SetupStep<Id>[] {
  const steps: SetupStep<Id>[] = [];

  definitions.forEach((definition, index) => {
    const needed = steps.find(({ id }) => id === definition.needs);
    const needDone = needed === undefined || needed.state === "done";
    const check = definition.id === "project" && input.projectAdded === true ? "pass" : definition.check(source);
    const state = stateOf(definition, check, needDone, input);
    const stateLabel = state === "to-do" ? writeLabel(definition.id, input) : STATE_LABELS[state];

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

export function setupSteps(input: StepInput): SetupStep<ScreenStepId>[] {
  return stepsOf(SCREEN_STEPS, input.status, input);
}

/** The steps of the dialog of one agent, from its entry in the status. */
export function agentSteps(agent: ChatAgent, input: StepInput): SetupStep<AgentStepId>[] {
  return stepsOf(agentDefinitions(agent), input.status?.agents.find((entry) => entry.agent === agent), input);
}

export function agentSetUp(steps: readonly SetupStep<AgentStepId>[]): boolean {
  return steps.every(({ state }) => state === "done" || state === "stopped");
}

/** No step is current while a step of the full read has no state yet. */
export function currentStep<Id extends StepId>(steps: readonly SetupStep<Id>[]): SetupStep<Id> | undefined {
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
export function stepsNowDone<Id extends StepId>(
  before: readonly SetupStep<Id>[],
  after: readonly SetupStep<Id>[],
): SetupStep<Id>[] {
  return after.filter(({ state }, index) => isChangeToDone(before[index]!.state, state));
}
