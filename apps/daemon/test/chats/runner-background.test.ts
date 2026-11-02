import { describe, expect, it, vi } from "vitest";
import type { AcpObject, ChatEvent } from "@tasma/protocol";
import type { AgentAdapter, BackgroundState, RunningCommand } from "../../src/agents/adapter.js";
import { holdReason, stopNote } from "../../src/chats/idle.js";
import { faultLine } from "../../src/chats/registry.js";
import type { LiveChat } from "../../src/chats/registry.js";
import { logOf, logUntil, until } from "../helpers.js";
import { modeOption, text } from "../agents/fake-agent.js";
import { chatState, endedByRunner, fakeAdapter, gate, NEXT, PICK, START, world } from "./runner-world.js";
import type { World, WorldOptions } from "./runner-world.js";

const META = { systemPrompt: { append: "Mark each command." } };

const LIMIT_MS = 50;

const JOB = { mark: "job", name: "Test loop" } as const satisfies RunningCommand;

const SERVICE = { mark: "service", name: "Dev server" } as const satisfies RunningCommand;

const UNMARKED = { mark: undefined, name: "pnpm watch" } as const satisfies RunningCommand;

type Control = {
  /** What each check gives, as it stands when the check starts. Its `jobsEnded` goes to one check alone. */
  state: BackgroundState;
  /** What each check waits for. */
  hold: Promise<void>;
  /** What each check throws, after `hold`. */
  failure: Error | undefined;
  checks: number;
  notes: AcpObject[];
  logs: ((cause: string) => void)[];
};

function backgroundAdapter(): { adapter: AgentAdapter; control: Control } {
  const control: Control = {
    state: { running: [], jobsEnded: 0 },
    hold: Promise.resolve(),
    failure: undefined,
    checks: 0,
    notes: [],
    logs: [],
  };
  const adapter: AgentAdapter = {
    ...fakeAdapter().adapter,
    sessionMeta: META,
    backgroundCommands(log) {
      control.logs.push(log);
      return {
        note: (update) => control.notes.push(update),
        async running() {
          control.checks += 1;
          const { state } = control;
          control.state = { ...state, jobsEnded: 0 };
          await control.hold;
          if (control.failure !== undefined) throw control.failure;
          return state;
        },
      };
    },
  };
  return { adapter, control };
}

type Started = World & { live: LiveChat; log: ChatEvent[]; control: Control };

/**
 * A chat whose first turn has ended, with an idle limit of `LIMIT_MS`. Its
 * first check can run before the turn end is read, so `prepare` sets the
 * checks up before the start.
 */
async function started(options: WorldOptions = {}, prepare: (control: Control) => void = () => {}): Promise<Started> {
  const { adapter, control } = backgroundAdapter();
  prepare(control);
  const setup = await world({ adapter, idleLimit: async () => LIMIT_MS, ...options });
  const live = await setup.runner.start(START);
  const log = await logUntil(live, "turn-end");
  return { ...setup, live, log, control };
}

async function stopped(setup: Started, index = 0): Promise<void> {
  await endedByRunner(setup.processes[index]);
  await until(() => setup.runner.running(setup.live) === undefined, "the chat stopped running");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The text of each prompt that the process got. */
function promptsOf(setup: Started, index: number): string[] {
  return (setup.processes[index]?.prompts ?? []).map((prompt) => (prompt.prompt[0] as { text: string }).text);
}

describe("createChatRunner with the background commands of the adapter", () => {
  it("opens and resumes the session with the meta of the adapter", async () => {
    const setup = await started();
    await setup.runner.stop(setup.live);
    await setup.runner.message(setup.live, NEXT);
    await logUntil(setup.live, "turn-end");

    expect(setup.processes[0]?.newSession).toEqual({ cwd: setup.folder, mcpServers: [], _meta: META });
    expect(setup.processes[1]?.resumes).toEqual([
      { sessionId: setup.live.chat.session, cwd: setup.folder, mcpServers: [], _meta: META },
    ]);
  });

  it("gives each update to the background commands as the agent sent it, and to the log as the adapter filters it", async () => {
    const setup = await started({ idleLimit: async () => 60_000 });
    const update = { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Run the tests" } as const;

    await setup.processes[0]?.update(update);
    const log = await logUntil(setup.live, "update");

    expect(setup.control.notes).toEqual([update]);
    expect(log.at(-1)).toEqual({ kind: "update", update: { ...update, filtered: true } });
  });

  it("stops the agent at the limit with no event when nothing runs, and the next prompt gets no note", async () => {
    const setup = await started();

    await stopped(setup);
    expect(await logOf(setup.live)).toEqual(setup.log);
    expect(setup.live.chat.state).toBe("needs-you");
    expect(setup.feed.filter((event) => event.kind === "chat").at(-1)).toEqual(chatState("needs-you"));

    await setup.runner.message(setup.live, NEXT);
    await logUntil(setup.live, "turn-end");
    expect(promptsOf(setup, 1)).toEqual([NEXT.text]);
  });

  it("stops the agent with no event when only a service and a command with no mark run, and notes them once", async () => {
    const setup = await started({}, (control) => (control.state = { running: [SERVICE, UNMARKED], jobsEnded: 0 }));

    await stopped(setup);
    expect(await logOf(setup.live)).toEqual(setup.log);
    expect(setup.live.chat.state).toBe("needs-you");
    setup.control.state = { running: [], jobsEnded: 0 };

    await setup.runner.message(setup.live, NEXT);
    await logUntil(setup.live, "turn-end");
    await stopped(setup, 1);
    await setup.runner.message(setup.live, { text: "And the printer", client: "web" });
    const log = await logUntil(setup.live, "turn-end");

    expect([...promptsOf(setup, 1), ...promptsOf(setup, 2)]).toEqual([
      `${stopNote([SERVICE, UNMARKED])}\n\n${NEXT.text}`,
      "And the printer",
    ]);
    expect(log.filter((event) => event.kind === "user").slice(1)).toEqual([
      { kind: "user", ...NEXT },
      { kind: "user", text: "And the printer", client: "web" },
    ]);
  });

  it("keeps the agent while a job runs, and stops it at the first limit after", async () => {
    const setup = await started({}, (control) => (control.state = { running: [JOB, SERVICE], jobsEnded: 0 }));

    await until(() => setup.control.checks >= 8, "eight checks ran");
    expect(setup.processes[0]?.endCalls).toBe(0);
    setup.control.state = { running: [], jobsEnded: 0 };

    await stopped(setup);
    expect(await logOf(setup.live)).toEqual(setup.log);
  });

  it("gives one more limit after a job ended, and then stops the agent", async () => {
    const setup = await started({}, (control) => (control.state = { running: [], jobsEnded: 1 }));

    await stopped(setup);

    expect(setup.control.checks).toBe(2);
    expect(await logOf(setup.live)).toEqual(setup.log);
  });

  it("fails the chat with the reason when a job still runs at the hold limit, and notes every command, jobs first", async () => {
    // The chat must not fail before `started` has read the first turn end.
    const options = { jobHoldMs: 600 };
    const setup = await started(options, (control) => (control.state = { running: [SERVICE, JOB], jobsEnded: 0 }));

    const log = await logUntil(setup.live, "failed");
    await stopped(setup);

    expect(log).toEqual([...setup.log, { kind: "failed", reason: holdReason([JOB], [SERVICE], options.jobHoldMs) }]);
    expect(setup.control.checks).toBe(options.jobHoldMs / LIMIT_MS);
    expect(setup.live.chat.state).toBe("failed");
    setup.control.state = { running: [], jobsEnded: 0 };

    await setup.runner.message(setup.live, NEXT);
    await logUntil(setup.live, "turn-end");
    expect(promptsOf(setup, 1)).toEqual([`${stopNote([JOB, SERVICE])}\n\n${NEXT.text}`]);
  });

  it("does not fail the chat when the clock passes the hold limit and the limits have not, as when the Mac sleeps", async () => {
    const jobHoldMs = 1000;
    const setup = await started({ jobHoldMs }, (control) => (control.state = { running: [JOB], jobsEnded: 0 }));

    const checks = setup.control.checks;
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * jobHoldMs);
    try {
      await until(() => setup.control.checks >= checks + 2, "two more checks ran");
    } finally {
      now.mockRestore();
    }

    expect(await logOf(setup.live)).toEqual(setup.log);
    expect(setup.processes[0]?.endCalls).toBe(0);
    await logUntil(setup.live, "failed");
    expect(setup.control.checks).toBe(jobHoldMs / LIMIT_MS);
    await stopped(setup);
  });

  describe("during a check", () => {
    function held(options: WorldOptions = {}, state?: BackgroundState) {
      const { opened, open } = gate();
      const starting = started(options, (control) => {
        control.hold = opened;
        if (state !== undefined) control.state = state;
      });
      return { starting, open };
    }

    async function checking(setup: Started): Promise<void> {
      await until(() => setup.control.checks === 1, "the check started");
    }

    it("does not stop the agent at an update", async () => {
      const { starting, open } = held({ idleLimit: async () => 200 });
      const setup = await starting;
      await checking(setup);

      await setup.processes[0]?.update(text("Still testing"));
      await until(() => setup.control.notes.length === 1, "the runner read the update");
      open();
      await sleep(100);

      expect(setup.processes[0]?.endCalls).toBe(0);
      await stopped(setup);
      expect(setup.control.checks).toBe(2);
    });

    it("keeps an ended job that the check found for the next check, when an update arrives during it", async () => {
      const { starting, open } = held({ idleLimit: async () => 200 }, { running: [], jobsEnded: 1 });
      const setup = await starting;
      await checking(setup);

      await setup.processes[0]?.update(text("The tests passed"));
      await until(() => setup.control.notes.length === 1, "the runner read the update");
      open();

      await stopped(setup);
      expect(setup.control.checks).toBe(3);
    });

    it("does not stop the agent at a message", async () => {
      const { starting, open } = held({ idleLimit: async () => 300 });
      const setup = await starting;
      await checking(setup);

      await setup.runner.message(setup.live, NEXT);
      await until(() => setup.runner.running(setup.live)?.session !== undefined && promptsOf(setup, 0).length === 2, "the turn ran");
      open();
      await sleep(50);

      expect(setup.processes[0]?.endCalls).toBe(0);
      expect(promptsOf(setup, 0)).toEqual([START.text, NEXT.text]);
    });

    it("writes nothing and stops nothing when a new run of the chat starts", async () => {
      // The new run must not reach its own idle check before the assertions.
      const options = { idleLimit: async () => 1000, jobHoldMs: 0 };
      const { starting, open } = held(options, { running: [JOB], jobsEnded: 0 });
      const setup = await starting;
      await checking(setup);
      setup.control.state = { running: [], jobsEnded: 0 };

      await setup.runner.stop(setup.live);
      await setup.runner.message(setup.live, NEXT);
      const log = await logUntil(setup.live, "turn-end");
      open();
      await sleep(50);

      expect(await logOf(setup.live)).toEqual(log);
      expect(setup.processes[1]?.endCalls).toBe(0);
      await stopped(setup, 1);
    });

    it("writes nothing when the process exits", async () => {
      const { starting, open } = held({ jobHoldMs: 0 }, { running: [JOB], jobsEnded: 0 });
      const setup = await starting;
      await checking(setup);

      setup.processes[0]?.exit({ code: 0, signal: null });
      await until(() => setup.runner.running(setup.live) === undefined, "the chat stopped running");
      open();
      await sleep(50);

      expect(await logOf(setup.live)).toEqual(setup.log);
      expect(setup.live.chat.state).toBe("needs-you");
    });

    it("stops no agent after stopStarts", async () => {
      const { starting, open } = held();
      const setup = await starting;
      await checking(setup);

      setup.runner.stopStarts();
      open();
      await sleep(100);

      expect(setup.processes[0]?.endCalls).toBe(0);
    });
  });

  it("writes the lines of the background commands with the name of the chat", async () => {
    const setup = await started({ idleLimit: async () => 60_000 });

    setup.control.logs[0]?.("lsof could not run");

    expect(setup.errors).toEqual([faultLine(setup.live.chat, "lsof could not run")]);
  });

  it("stops the agent and reports the fault when a check fails", async () => {
    const setup = await started({}, (control) => (control.failure = new Error("the check broke")));

    await stopped(setup);

    expect(setup.errors).toEqual([faultLine(setup.live.chat, "the check broke")]);
    expect(await logOf(setup.live)).toEqual(setup.log);
  });

  it("keeps the note through a pick relaunch with no prompt and a later stop that found nothing", async () => {
    const setup = await started(
      { script: { configOptions: [modeOption()] } },
      (control) => (control.state = { running: [SERVICE], jobsEnded: 0 }),
    );
    await stopped(setup);
    setup.control.state = { running: [], jobsEnded: 0 };

    await setup.runner.setOption(setup.live, PICK);
    await stopped(setup, 1);
    await setup.runner.message(setup.live, NEXT);
    await logUntil(setup.live, "turn-end");

    expect(promptsOf(setup, 1)).toEqual([]);
    expect(promptsOf(setup, 2)).toEqual([`${stopNote([SERVICE])}\n\n${NEXT.text}`]);
  });

  it("replaces the note at a later stop that found running commands", async () => {
    const setup = await started(
      { script: { configOptions: [modeOption()] } },
      (control) => (control.state = { running: [SERVICE], jobsEnded: 0 }),
    );
    await stopped(setup);
    setup.control.state = { running: [UNMARKED], jobsEnded: 0 };

    await setup.runner.setOption(setup.live, PICK);
    await stopped(setup, 1);
    await setup.runner.message(setup.live, NEXT);
    await logUntil(setup.live, "turn-end");

    expect(promptsOf(setup, 2)).toEqual([`${stopNote([UNMARKED])}\n\n${NEXT.text}`]);
  });
});
