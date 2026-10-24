// The idle stop of the agent of a chat: the time limit, which depends on the
// owner of the step of the chat, and the timer that measures it.

import { openTreeWorkflows } from "@tasma/engine";
import type { StepOwner } from "@tasma/engine";
import type { ProjectHost } from "../projects/host.js";

export const HUMAN_STEP_IDLE_MS = 60 * 60 * 1000;

export const AGENT_STEP_IDLE_MS = 10 * 60 * 1000;

/** The idle limit of a chat, in milliseconds, from the place and the step of the chat. */
export type IdleLimit = (tag: string, task: string, step: string) => Promise<number>;

export type IdleTimer = {
  /** Starts the time again from zero, or stops it while `busy` gives true. */
  touch(): void;
  /** Stops the time for good: a later `touch` does nothing. */
  clear(): void;
};

/** The owner of the step in the current workflow of the task, or undefined when Tasma cannot find it. */
async function ownerOf(
  root: string | undefined,
  host: ProjectHost,
  place: { tag: string; task: string; step: string },
): Promise<StepOwner | undefined> {
  const { tag, task, step } = place;
  const { index } = await host.open(tag);
  const name = index.query().entries.find((entry) => entry.id === task)?.frontmatter.workflow;
  if (name === undefined) return undefined;
  const { workflows } = await openTreeWorkflows(root);
  const { workflow } = await workflows.read(name);
  return workflow.steps.find((one) => one.name === step)?.owner;
}

/** A failed read gives the limit of an agent step. */
export function idleLimit(options: { root?: string; host: ProjectHost }): IdleLimit {
  return async (tag, task, step) => {
    const owner = await ownerOf(options.root, options.host, { tag, task, step }).catch(() => undefined);
    return owner === "human" ? HUMAN_STEP_IDLE_MS : AGENT_STEP_IDLE_MS;
  };
}

export function idleTimer(options: { limitMs: number; busy: () => boolean; expire: () => void }): IdleTimer {
  let timer: NodeJS.Timeout | undefined;
  let cleared = false;
  return {
    touch() {
      clearTimeout(timer);
      if (cleared || options.busy()) return;
      timer = setTimeout(options.expire, options.limitMs);
    },
    clear() {
      cleared = true;
      clearTimeout(timer);
    },
  };
}
