// The start of the chat of the current step of a task: the rule that gives
// back the chat the step already has, starts a new one or replaces one, and
// the lock that runs the starts of one task one after the other.

import { openWorkflows, TaskStoreError } from "@tasma/engine";
import type { ChatAgent, Diagnostic } from "@tasma/protocol";
import { DaemonError } from "../http/failure.js";
import type { ProjectHost } from "../projects/host.js";
import { taskKey } from "../tasks/serialize.js";
import type { ChatRegistry, LiveChat } from "./registry.js";
import { ChatStartRefusal } from "./runner.js";
import type { ChatRunner } from "./runner.js";

const AGENT: ChatAgent = "claude";

export type StepChats = {
  /**
   * Gives back the latest chat of the task when it is of the step, holds its
   * first message and has not failed. In other cases it starts a new chat.
   * The step is the step of the task, or the first step of its workflow when
   * the task has no step; the task does not change.
   *
   * With `replaces`, the chat of that number must be the latest chat of the
   * task, and of the step, or the start is refused with `chat-not-current`.
   * Its agent stops before a new chat starts, and the step is read again then.
   */
  start(tag: string, task: string, client: string, replaces?: number): Promise<{
    live: LiveChat;
    started: boolean;
    diagnostics: Diagnostic[];
  }>;
};

function firstMessage(task: string): string {
  return `Run the current step of Tasma task ${task}.`;
}

function continues(live: LiveChat, step: string): boolean {
  const { chat } = live;
  return chat.step === step && chat.seq > 0 && chat.state !== "failed";
}

function notCurrent(message: string): DaemonError {
  return new DaemonError("chat-not-current", message);
}

function otherStep(live: LiveChat, step: string): DaemonError {
  const { chat, task, step: own } = live.chat;
  return notCurrent(`chat ${chat} of ${task} is of the step "${own}", and the task is at the step "${step}"`);
}

/** The chat `replaces` names, when it is the latest chat of the task and of the step. */
function replaced(task: string, chats: readonly LiveChat[], replaces: number, step: string): LiveChat {
  const named = chats.find((live) => live.chat.chat === replaces);
  if (named === undefined) throw notCurrent(`${task} has no chat ${replaces}`);
  const latest = chats.at(-1)!;
  if (latest !== named) {
    throw notCurrent(`chat ${replaces} of ${task} is not the latest chat of the task: chat ${latest.chat.chat} is`);
  }
  if (named.chat.step !== step) throw otherStep(named, step);
  return named;
}

export function createStepChats(options: {
  root?: string;
  host: ProjectHost;
  chats: ChatRegistry;
  runner: Pick<ChatRunner, "start" | "end">;
}): StepChats {
  const { root, host, chats, runner } = options;
  /** The last start of each task that runs or waits. */
  const locks = new Map<string, Promise<void>>();

  /**
   * Not a turn of the write queue: a start can wait seconds for the login
   * shell, and a turn would hold every write to the task for that time.
   */
  async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (locks.get(key) ?? Promise.resolve()).then(work);
    const settled = run.then(() => undefined, () => undefined);
    locks.set(key, settled);
    try {
      return await run;
    } finally {
      if (locks.get(key) === settled) locks.delete(key);
    }
  }

  async function stepOf(tag: string, task: string): Promise<{ step: string; diagnostics: Diagnostic[] }> {
    const { index } = await host.open(tag);
    const read = await index.readTask(task);
    const { workflow: name, step } = read.task.frontmatter;
    if (name === undefined) throw new DaemonError("task-has-no-workflow", `task ${task} has no workflow`);

    const { config, diagnostics: configFindings } = await index.config();
    const workflows = openWorkflows({ root, path: config.workflows_path });
    // The engine makes the same check on a workflow that a write names, but does not export it.
    if (!config.workflows.includes(name)) {
      throw new TaskStoreError("workflow-unknown", `this project declares no workflow "${name}"`, workflows.pathsOf(name).directory);
    }
    const { workflow, diagnostics: workflowFindings } = await workflows.read(name);
    const diagnostics = [...read.diagnostics, ...configFindings, ...workflowFindings];

    // The loader refuses a workflow with no steps.
    if (step === undefined) return { step: workflow.steps[0]!.name, diagnostics };
    if (!workflow.steps.some((entry) => entry.name === step)) {
      throw new DaemonError("step-stale", `task ${task} carries the step "${step}", which the workflow "${name}" does not declare`);
    }
    return { step, diagnostics };
  }

  async function launch(tag: string, task: string, step: string, client: string): Promise<LiveChat> {
    try {
      return await runner.start({ tag, task, step, agent: AGENT, text: firstMessage(task), client });
    } catch (error) {
      if (error instanceof ChatStartRefusal) throw new DaemonError(error.code, error.message);
      throw error;
    }
  }

  async function startOf(tag: string, task: string, client: string, replaces?: number): ReturnType<StepChats["start"]> {
    const { step, diagnostics: stepFindings } = await stepOf(tag, task);
    const listed = await chats.list(tag, task);
    if (replaces === undefined) {
      const diagnostics = [...stepFindings, ...listed.diagnostics];
      const latest = listed.chats.at(-1);
      if (latest !== undefined && continues(latest, step)) return { live: latest, started: false, diagnostics };
      return { live: await launch(tag, task, step, client), started: true, diagnostics };
    }

    const old = replaced(task, listed.chats, replaces, step);
    await runner.end(old, { client });
    // The agent of the old chat can move the task to another step before it stops.
    const now = await stepOf(tag, task);
    if (now.step !== step) throw otherStep(old, now.step);
    const diagnostics = [...now.diagnostics, ...listed.diagnostics];
    return { live: await launch(tag, task, step, client), started: true, diagnostics };
  }

  return {
    start: (tag, task, client, replaces) => locked(taskKey(tag, task), () => startOf(tag, task, client, replaces)),
  };
}
