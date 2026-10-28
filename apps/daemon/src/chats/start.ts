// The start of the chat of the current step of a task: the rule that gives
// back the chat the step already has, starts a new one or restarts the step,
// and the lock that runs the starts of one task one after the other.

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
   * With `restart`, a new chat always starts. When the latest chat of the task
   * is of the step, its agent stops first, and the step is read again then:
   * the start is refused with `chat-not-current` when the step changed.
   */
  start(tag: string, task: string, client: string, restart?: boolean): Promise<{
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

function movedTo(stopped: LiveChat, step: string): DaemonError {
  const { chat, task } = stopped.chat;
  return notCurrent(`${task} moved to the step "${step}" while the agent of chat ${chat} stopped, so no chat started`);
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

  async function startOf(tag: string, task: string, client: string, restart = false): ReturnType<StepChats["start"]> {
    const { step, diagnostics: stepFindings } = await stepOf(tag, task);
    const listed = await chats.list(tag, task);
    const latest = listed.chats.at(-1);
    if (restart && latest?.chat.step === step) {
      await runner.end(latest, { client });
      // The agent of the old chat can move the task to another step before it stops.
      const now = await stepOf(tag, task);
      if (now.step !== step) throw movedTo(latest, now.step);
      const diagnostics = [...now.diagnostics, ...listed.diagnostics];
      return { live: await launch(tag, task, step, client), started: true, diagnostics };
    }

    const diagnostics = [...stepFindings, ...listed.diagnostics];
    if (!restart && latest !== undefined && continues(latest, step)) {
      return { live: latest, started: false, diagnostics };
    }
    return { live: await launch(tag, task, step, client), started: true, diagnostics };
  }

  return {
    start: (tag, task, client, restart) => locked(taskKey(tag, task), () => startOf(tag, task, client, restart)),
  };
}
