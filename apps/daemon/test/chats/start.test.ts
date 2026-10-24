import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { TaskStoreError } from "@tasma/engine";
import { createChatRegistry } from "../../src/chats/registry.js";
import type { ChatRegistry, LiveChat } from "../../src/chats/registry.js";
import { ChatStartRefusal } from "../../src/chats/runner.js";
import type { ChatRunner } from "../../src/chats/runner.js";
import { createStepChats } from "../../src/chats/start.js";
import type { StepChats } from "../../src/chats/start.js";
import { DaemonError } from "../../src/http/failure.js";
import { createProjectHost } from "../../src/projects/host.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import {
  chatFolder,
  onWorkflow,
  plant,
  plantChat,
  plantSteps,
  projectConfig,
  projectsRoot,
  stepsOnly,
  stillPending,
  taskFile,
  taskText,
  userConfig,
} from "../helpers.js";

type StartInput = Parameters<ChatRunner["start"]>[0];

type World = {
  root: string;
  chats: ChatRegistry;
  starts: StepChats;
  /** Each call of the runner, in call order. */
  calls: StartInput[];
  /** Replaces what the next calls of the runner do. Without it, a call creates the chat with its first message. */
  next: { start?: (input: StartInput) => Promise<LiveChat> };
};

/**
 * Project ALPHA declares the workflow "flow", with the steps "plan" and
 * "build". ALPHA-1 is at "build", ALPHA-2 is at "plan", ALPHA-3 follows "flow"
 * with no step, and ALPHA-4 has no workflow.
 */
async function world(): Promise<World> {
  const root = await projectsRoot("ALPHA");
  await plantSteps(root, "flow", "plan", "build");
  await plant(projectConfig(root, "ALPHA"), "workflows: [flow]\n");
  await plant(taskFile(root, "ALPHA", "ALPHA-1"), onWorkflow("ALPHA-1", "flow", "build"));
  await plant(taskFile(root, "ALPHA", "ALPHA-2"), onWorkflow("ALPHA-2", "flow", "plan"));
  await plant(taskFile(root, "ALPHA", "ALPHA-3"), onWorkflow("ALPHA-3", "flow"));
  await plant(taskFile(root, "ALPHA", "ALPHA-4"), taskText("ALPHA-4"));
  const host = createProjectHost({ root });
  const chats = createChatRegistry({ root, host, writes: new WriteQueue() });
  onTestFinished(async () => {
    chats.close();
    await host.close();
  });
  const calls: StartInput[] = [];
  const next: World["next"] = {};
  const runner: Pick<ChatRunner, "start"> = {
    start(input) {
      calls.push(input);
      if (next.start !== undefined) return next.start(input);
      const { tag, task, step, agent, text, client } = input;
      return chats.create(tag, task, { step, agent, folder: "/srv/alpha" }, { text, client });
    },
  };
  return { root, chats, starts: createStepChats({ root, host, chats, runner }), calls, next };
}

/** The refusal a start rejects with. */
async function refusal(start: Promise<unknown>): Promise<unknown> {
  return start.then(
    () => {
      throw new Error("the start was not refused");
    },
    (error: unknown) => error,
  );
}

describe("a start of the chat of a step", () => {
  it("starts a chat for the step of the task with the agent claude and the first message", async () => {
    const { starts, calls } = await world();

    const { live, started } = await starts.start("ALPHA", "ALPHA-1", "cli");

    expect(started).toBe(true);
    expect(live.chat).toMatchObject({ task: "ALPHA-1", chat: 1, step: "build", agent: "claude", seq: 1, state: "working" });
    expect(calls).toEqual([{
      tag: "ALPHA",
      task: "ALPHA-1",
      step: "build",
      agent: "claude",
      text: "Run the current step of Tasma task ALPHA-1.",
      client: "cli",
    }]);
  });

  it("gives back the latest chat of the same step, and calls no runner", async () => {
    const { starts, calls } = await world();
    const first = await starts.start("ALPHA", "ALPHA-1", "cli");

    const second = await starts.start("ALPHA", "ALPHA-1", "app");

    expect(second.started).toBe(false);
    expect(second.live).toBe(first.live);
    expect(calls).toHaveLength(1);
  });

  it("gives back a latest chat that needs the user", async () => {
    const { root, starts, calls } = await world();
    await plantChat(root, { tag: "ALPHA", digits: "1", chat: 1 }, { step: "build" }, [
      { kind: "user", text: "Build the parser", client: "app" },
      { kind: "turn-end", stopReason: "end_turn" },
    ]);

    const { live, started } = await starts.start("ALPHA", "ALPHA-1", "cli");

    expect(started).toBe(false);
    expect(live.chat).toMatchObject({ chat: 1, state: "needs-you" });
    expect(calls).toEqual([]);
  });

  it("starts a new chat when the latest chat is of another step", async () => {
    const { root, starts, calls } = await world();
    await plantChat(root, { tag: "ALPHA", digits: "1", chat: 1 }, { step: "build" }, [
      { kind: "user", text: "Build the parser", client: "app" },
    ]);
    await plantChat(root, { tag: "ALPHA", digits: "1", chat: 2 }, { step: "plan" }, [
      { kind: "user", text: "Plan the parser", client: "app" },
    ]);

    const { live, started } = await starts.start("ALPHA", "ALPHA-1", "cli");

    expect(started).toBe(true);
    expect(live.chat).toMatchObject({ chat: 3, step: "build" });
    expect(calls).toHaveLength(1);
  });

  it("starts a new chat when the latest chat of the step failed", async () => {
    const { starts } = await world();
    const first = await starts.start("ALPHA", "ALPHA-1", "cli");
    await first.live.append({ kind: "failed", reason: "The agent process ended with exit code 1" });

    const { live, started } = await starts.start("ALPHA", "ALPHA-1", "cli");

    expect(started).toBe(true);
    expect(live.chat).toMatchObject({ chat: 2, step: "build", state: "working" });
  });

  it("starts a new chat when the latest chat of the step has an empty log", async () => {
    const { root, starts } = await world();
    await plantChat(root, { tag: "ALPHA", digits: "1", chat: 1 }, { step: "build" }, []);

    const { live, started } = await starts.start("ALPHA", "ALPHA-1", "cli");

    expect(started).toBe(true);
    expect(live.chat).toMatchObject({ chat: 2, seq: 1 });
  });

  it("starts a task with no step at the first step of its workflow, and leaves the task as it is", async () => {
    const { root, starts, calls } = await world();
    const before = await readFile(taskFile(root, "ALPHA", "ALPHA-3"), "utf8");

    const first = await starts.start("ALPHA", "ALPHA-3", "cli");
    const second = await starts.start("ALPHA", "ALPHA-3", "cli");

    expect(first).toMatchObject({ started: true, live: { chat: { step: "plan" } } });
    expect(second.started).toBe(false);
    expect(second.live).toBe(first.live);
    expect(calls.map((call) => call.step)).toEqual(["plan"]);
    expect(await readFile(taskFile(root, "ALPHA", "ALPHA-3"), "utf8")).toBe(before);
  });

  it("refuses a task with no workflow with task-has-no-workflow", async () => {
    const { starts, calls } = await world();

    const error = await refusal(starts.start("ALPHA", "ALPHA-4", "cli"));

    expect(error).toBeInstanceOf(DaemonError);
    expect(error).toMatchObject({ code: "task-has-no-workflow" });
    expect(calls).toEqual([]);
  });

  it("refuses a workflow that the project does not declare with workflow-unknown", async () => {
    const { root, starts } = await world();
    await plantSteps(root, "other", "draft");
    await plant(taskFile(root, "ALPHA", "ALPHA-5"), onWorkflow("ALPHA-5", "other", "draft"));

    const error = await refusal(starts.start("ALPHA", "ALPHA-5", "cli"));

    expect(error).toBeInstanceOf(TaskStoreError);
    expect(error).toMatchObject({ code: "workflow-unknown" });
  });

  it("refuses a step that the workflow does not have with step-stale", async () => {
    const { root, starts, calls } = await world();
    await plant(taskFile(root, "ALPHA", "ALPHA-5"), onWorkflow("ALPHA-5", "flow", "ship"));

    const error = await refusal(starts.start("ALPHA", "ALPHA-5", "cli"));

    expect(error).toBeInstanceOf(DaemonError);
    expect(error).toMatchObject({ code: "step-stale" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["an unknown task", "ALPHA", "ALPHA-9", "task-not-found"],
    ["an unknown project", "BETA", "BETA-1", "project-not-found"],
  ])("passes the refusal of %s through", async (_case, tag, task, code) => {
    const { starts } = await world();

    const error = await refusal(starts.start(tag, task, "cli"));

    expect(error).toBeInstanceOf(TaskStoreError);
    expect(error).toMatchObject({ code });
  });

  it.each(["project-has-no-folder", "agent-not-supported"] as const)(
    "turns the runner refusal %s into a refusal of the daemon with the same code",
    async (code) => {
      const { starts, next } = await world();
      next.start = () => Promise.reject(new ChatStartRefusal(code, `refused with ${code}`));

      const error = await refusal(starts.start("ALPHA", "ALPHA-1", "cli"));

      expect(error).toBeInstanceOf(DaemonError);
      expect(error).toMatchObject({ code, message: `refused with ${code}` });
    },
  );

  it("passes any other fault of the runner through", async () => {
    const { starts, next } = await world();
    const fault = new Error("the disk is full");
    next.start = () => Promise.reject(fault);

    await expect(starts.start("ALPHA", "ALPHA-1", "cli")).rejects.toBe(fault);
  });

  it("runs the next start of a task after a start that failed", async () => {
    const { starts, next } = await world();
    next.start = () => Promise.reject(new ChatStartRefusal("project-has-no-folder", "no folder"));
    await refusal(starts.start("ALPHA", "ALPHA-1", "cli"));
    delete next.start;

    const { started } = await starts.start("ALPHA", "ALPHA-1", "cli");

    expect(started).toBe(true);
  });

  it("makes one chat for two starts of one task at the same time", async () => {
    const { starts, calls } = await world();

    const [one, other] = await Promise.all([
      starts.start("ALPHA", "ALPHA-1", "cli"),
      starts.start("ALPHA", "ALPHA-1", "app"),
    ]);

    expect(calls).toHaveLength(1);
    expect(one.live).toBe(other.live);
    expect([one.started, other.started]).toEqual([true, false]);
  });

  it("does not make a start of one task wait for a start of another task", async () => {
    const { chats, starts, next } = await world();
    let release: (() => void) | undefined;
    next.start = async ({ tag, task, step, agent, text, client }) => {
      if (task === "ALPHA-1") await new Promise<void>((resolve) => (release = resolve));
      return chats.create(tag, task, { step, agent, folder: "/srv/alpha" }, { text, client });
    };

    const held = starts.start("ALPHA", "ALPHA-1", "cli");
    const other = await starts.start("ALPHA", "ALPHA-2", "cli");

    expect(other.started).toBe(true);
    expect(await stillPending(held)).toBe(true);
    release!();
    await expect(held).resolves.toMatchObject({ started: true });
  });

  it("reads the workflow from the directory that the user configuration names", async () => {
    const { root, starts } = await world();
    const elsewhere = join(root, "elsewhere");
    await plant(join(elsewhere, "flow", "workflow.yml"), stepsOnly("draft"));
    await plant(join(elsewhere, "flow", "steps", "draft.md"), "Do draft.\n");
    await plant(userConfig(root), `workflows_path: ${JSON.stringify(elsewhere)}\n`);

    const { live } = await starts.start("ALPHA", "ALPHA-3", "cli");

    expect(live.chat.step).toBe("draft");
  });

  it("gives the findings of its reads, each finding of the user configuration one time", async () => {
    const { root, starts } = await world();
    await plant(userConfig(root), "colour: blue\n");
    await mkdir(chatFolder(root, "ALPHA", "1", 1), { recursive: true });

    const { live, diagnostics } = await starts.start("ALPHA", "ALPHA-1", "cli");

    expect(live.chat.chat).toBe(2);
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "config-key-unknown")).toEqual([
      expect.objectContaining({ path: userConfig(root) }),
    ]);
    expect(diagnostics.filter((diagnostic) => diagnostic.path?.startsWith(chatFolder(root, "ALPHA", "1", 1)))).toHaveLength(1);
  });
});
