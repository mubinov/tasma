import type { RegisteredRouter } from "@tanstack/react-router";
import type { Chat, Frontmatter, Workflow } from "@tasma/protocol";

const STEP_ACTION = "data-step-action";

export const STEP_ACTION_MARK = { [STEP_ACTION]: "" };

export const STEP_ACTION_SELECTOR = `[${STEP_ACTION}]`;

/** The latest location is the task view of the task. A navigation that still loads counts as done. */
export function latestOnTask(router: RegisteredRouter, tag: string, id: string): boolean {
  const { pathname } = router.buildLocation({ to: "/tasks/$project/$task", params: { project: tag, task: id } });

  return router.latestLocation.pathname === pathname;
}

/**
 * The step that the start route runs for the task, or null when the task has
 * no workflow, its workflow is not read, or its step is not in the workflow.
 */
export function actionStep(
  { workflow: name, step }: Pick<Frontmatter, "workflow" | "step">,
  workflow: Workflow | null | undefined,
): string | null {
  if (name === undefined || !workflow) {
    return null;
  }
  if (step === undefined) {
    return workflow.steps[0]?.name ?? null;
  }
  return workflow.steps.some((candidate) => candidate.name === step) ? step : null;
}

export type StepAction
  = | { kind: "start"; step: string }
    | { kind: "open"; step: string; chat: number };

/**
 * `chats` in the order the daemon lists them, oldest first. The rule must agree
 * with `continues` of the start route in `apps/daemon/src/chats/start.ts`.
 */
export function stepAction(step: string, chats: readonly Chat[]): StepAction {
  const latest = chats.at(-1);

  return latest?.step === step && latest.seq > 0 && latest.state !== "failed"
    ? { kind: "open", step, chat: latest.chat }
    : { kind: "start", step };
}

export function stepActionVerb({ kind }: StepAction): string {
  return kind === "start" ? "Start" : "Open";
}
