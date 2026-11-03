// The idle stop of the agent of a chat: the time limit, which depends on the
// owner of the step of the chat, the timer that measures it, and the texts of
// a stop that ends background commands.

import { openTreeWorkflows } from "@tasma/engine";
import type { StepOwner } from "@tasma/engine";
import type { RunningCommand } from "../agents/adapter.js";
import type { ProjectHost } from "../projects/host.js";

export const HUMAN_STEP_IDLE_MS = 60 * 60 * 1000;

export const AGENT_STEP_IDLE_MS = 10 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/** How long after the last activity a running `job` command keeps the agent. */
export const JOB_HOLD_MS = 2 * HOUR_MS;

/** The idle limit of a chat, in milliseconds, from the place and the step of the chat. */
export type IdleLimit = (tag: string, task: string, step: string) => Promise<number>;

export type IdleTimer = {
  /** Records activity, and starts the time again from zero, or stops it while `busy` gives true. */
  touch(): void;
  /** Starts the time again from zero, as `touch` does, and records no activity. */
  rearm(): void;
  /**
   * The time since the last `touch`, from the limits that ended since it. A
   * clock also counts the time that the Mac sleeps, when no command runs.
   */
  idleMs(): number;
  touches(): number;
  /** Stops the time for good: a later `touch` or `rearm` does nothing. */
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

/** Escaped, so that a quote in a name cannot end it. */
function quoted(commands: RunningCommand[]): string {
  return commands.map((command) => JSON.stringify(command.name)).join(", ");
}

/** The reason of the failure of a chat whose `job` commands still ran `holdMs` after the last activity. */
export function holdReason(jobs: RunningCommand[], others: RunningCommand[], holdMs: number): string {
  const held = jobs.length === 1 ? "The background command" : "The background commands";
  const also = others.length === 1 ? "This background command" : "These background commands";
  const stopped = others.length === 0 ? "" : ` ${also} stopped with it: ${quoted(others)}.`;
  const hours = String(holdMs / HOUR_MS);
  return `${held} ${quoted(jobs)} ran for ${hours} hours with no update from the agent, so Tasma stopped the agent.${stopped} Send a message to continue.`;
}

/** The reason of the failure of a chat whose agent still ran an own turn `holdMs` after the last activity. */
export function ownTurnReason(holdMs: number): string {
  return `The agent ran a turn by itself with no update for ${String(holdMs / HOUR_MS)} hours, so Tasma stopped the agent. Send a message to continue.`;
}

/** The text that the next prompt of a chat begins with, after an idle stop ended `commands`. */
export function stopNote(commands: RunningCommand[]): string {
  return `Tasma stopped this agent while it was idle. These background commands ended and did not finish their work: ${quoted(commands)}. Start them again if you still need them.`;
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
  let limitsEnded = 0;
  let touches = 0;
  function rearm(): void {
    clearTimeout(timer);
    if (cleared || options.busy()) return;
    timer = setTimeout(() => {
      limitsEnded += 1;
      options.expire();
    }, options.limitMs);
  }
  return {
    touch() {
      limitsEnded = 0;
      touches += 1;
      rearm();
    },
    rearm,
    idleMs: () => limitsEnded * options.limitMs,
    touches: () => touches,
    clear() {
      cleared = true;
      clearTimeout(timer);
    },
  };
}
