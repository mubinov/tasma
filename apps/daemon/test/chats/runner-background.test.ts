import { describe, expect, it, vi } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AcpObject, ChatEvent } from "@tasma/protocol";
import type { AgentAdapter, BackgroundState, RunningCommand } from "../../src/agents/adapter.js";
import { holdReason, ownTurnReason, stopNote } from "../../src/chats/idle.js";
import { faultLine } from "../../src/chats/registry.js";
import type { LiveChat } from "../../src/chats/registry.js";
import { logOf, logUntil, until } from "../helpers.js";
import { actAsAdapter, modelOption, modeOption, text } from "../agents/fake-agent.js";
import type { Script } from "../agents/fake-agent.js";
import { chatState, endedByRunner, fakeAdapter, filtered, gate, NEXT, PICK, requestOf, START, world } from "./runner-world.js";
import type { World, WorldOptions } from "./runner-world.js";

const META = { systemPrompt: { append: "Mark each command." } };

const LIMIT_MS = 50;

const JOB = { mark: "job", name: "Test loop" } as const satisfies RunningCommand;

const SERVICE = { mark: "service", name: "Dev server" } as const satisfies RunningCommand;

const UNMARKED = { mark: undefined, name: "pnpm watch" } as const satisfies RunningCommand;

const NOTHING: BackgroundState = { running: [], jobsEnded: 0 };

const JOB_RUNS: BackgroundState = { running: [JOB], jobsEnded: 0 };

const LONG_LIMIT = { idleLimit: async () => 60_000 };

const WAITS: ChatEvent = { kind: "background", job: true, ownTurn: false };

const OWN_TURN: ChatEvent = { kind: "background", job: false, ownTurn: true };

const OWN_TURN_WITH_JOB: ChatEvent = { kind: "background", job: true, ownTurn: true };

const CLEAR: ChatEvent = { kind: "background", job: false, ownTurn: false };

const STOPPED: ChatEvent = { ...CLEAR, stopReason: "cancelled" };

const CANCEL = { client: "web" };

/** What Claude sends at the end of an own turn. */
const MARKER: SessionUpdate = { sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 0.01, currency: "USD" } };

const PLAN: SessionUpdate = { sessionUpdate: "plan", entries: [] };

/** What Claude sends before the answer of a model change that leaves a mode the model does not support. */
const NOTICE = text("The mode changed to Accept edits.");

const MODEL_PICK = { configId: "model", value: "large", client: "web" } as const;

type Control = {
  /** What the next checks give, one for each check, before `state`. */
  planned: BackgroundState[];
  /** What a check gives with nothing planned, as it stands at its start. Only one check gets its `jobsEnded`. */
  state: BackgroundState;
  /** What each check waits for, from the check with the number `holdFrom` on. */
  hold: Promise<void>;
  holdFrom: number;
  /** What each check throws, after `hold`. */
  failure: Error | undefined;
  checks: number;
  notes: AcpObject[];
  logs: ((cause: string) => void)[];
};

function backgroundAdapter(): { adapter: AgentAdapter; control: Control } {
  const control: Control = {
    planned: [],
    state: NOTHING,
    hold: Promise.resolve(),
    holdFrom: 1,
    failure: undefined,
    checks: 0,
    notes: [],
    logs: [],
  };
  const adapter: AgentAdapter = {
    ...fakeAdapter().adapter,
    sessionMeta: META,
    projectSessionMeta: () => ({ systemPrompt: { append: "Only a project chat gets this." } }),
    backgroundCommands(log) {
      control.logs.push(log);
      return {
        note: (update) => control.notes.push(update),
        ownTurnEnded: (update) => update.sessionUpdate === "usage_update" && update.cost !== undefined,
        async running() {
          control.checks += 1;
          const check = control.checks;
          const planned = control.planned.shift();
          const { state } = control;
          if (planned === undefined) control.state = { ...state, jobsEnded: 0 };
          if (check >= control.holdFrom) await control.hold;
          if (control.failure !== undefined) throw control.failure;
          return planned ?? state;
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

async function withJob(options: WorldOptions = {}): Promise<Started> {
  return started(options, (control) => (control.state = JOB_RUNS));
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

function backgroundEvents(log: ChatEvent[]): ChatEvent[] {
  return log.filter((event) => event.kind === "background");
}

/** Sends an update of the agent, waits until the runner read it, and gives the log with its writes. */
async function agentSends(setup: Started, update: SessionUpdate): Promise<ChatEvent[]> {
  const notes = setup.control.notes.length;
  await setup.processes[0]?.update(update);
  await until(() => setup.control.notes.length > notes, "the runner read the update");
  await setup.live.written();
  return logOf(setup.live);
}

/** Holds the next check, and gives the function that ends the hold, once the check has started. */
async function holdNextCheck(setup: Started, trigger: () => Promise<unknown>): Promise<() => void> {
  const { opened, open } = gate();
  const { control } = setup;
  const check = control.checks + 1;
  control.hold = opened;
  control.holdFrom = check;
  await trigger();
  await until(() => control.checks >= check, "the check started");
  control.holdFrom = Infinity;
  return open;
}

/** Starts a cancel and holds its check. `cancelled` ends with the cancel, after `open`. */
async function cancelWithHeldCheck(setup: Started): Promise<{ cancelled: Promise<void>; open: () => void }> {
  let cancelled = Promise.resolve();
  const open = await holdNextCheck(setup, async () => {
    cancelled = setup.runner.cancel(setup.live, CANCEL);
  });
  return { cancelled, open };
}

/** The first prompt ends at once, and each later one stays open. */
const SECOND_TURN_HELD: Script = {
  prompt: async (_params, fake) => (fake.prompts.length === 1 ? { stopReason: "end_turn" } : new Promise(() => {})),
};

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
    expect(await logOf(setup.live)).toEqual(setup.log);
    setup.control.state = { running: [], jobsEnded: 0 };

    await stopped(setup);
    await setup.live.written();
    expect(await logOf(setup.live)).toEqual([...setup.log, CLEAR]);
  });

  it("gives one more limit after a job ended, and then stops the agent", async () => {
    const setup = await started({}, (control) => (control.state = { running: [], jobsEnded: 1 }));

    await stopped(setup);

    expect(setup.control.checks).toBe(3);
    expect(await logOf(setup.live)).toEqual(setup.log);
  });

  it("fails the chat with the reason when a job still runs at the hold limit, and notes every command, jobs first", async () => {
    // The chat must not fail before `started` has read the first turn end.
    const options = { jobHoldMs: 600 };
    const setup = await started(options, (control) => (control.state = { running: [SERVICE, JOB], jobsEnded: 0 }));

    const log = await logUntil(setup.live, "failed");
    await stopped(setup);

    expect(log).toEqual([...setup.log, { kind: "failed", reason: holdReason([JOB], [SERVICE], options.jobHoldMs) }]);
    expect(setup.control.checks).toBe(options.jobHoldMs / LIMIT_MS + 1);
    expect(setup.live.chat.state).toBe("failed");
    setup.control.state = { running: [], jobsEnded: 0 };

    await setup.runner.message(setup.live, NEXT);
    await logUntil(setup.live, "turn-end");
    expect(promptsOf(setup, 1)).toEqual([`${stopNote([JOB, SERVICE])}\n\n${NEXT.text}`]);
  });

  it("does not fail the chat when the clock passes the hold limit and the limits have not, as when the Mac sleeps", async () => {
    const jobHoldMs = 1000;
    const setup = await withJob({ jobHoldMs });

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
    expect(setup.control.checks).toBe(jobHoldMs / LIMIT_MS + 1);
    await stopped(setup);
  });

  describe("at the end of a turn", () => {
    it("writes that a job runs before the turn end, and the chat never needs the user between them", async () => {
      const setup = await withJob(LONG_LIMIT);

      expect(setup.log.slice(-2)).toEqual([WAITS, { kind: "turn-end", stopReason: "end_turn" }]);
      expect(setup.live.chat.state).toBe("working");
      expect(setup.feed.filter((event) => event.kind === "chat")).not.toContainEqual(chatState("needs-you"));
    });

    it.each<[string, BackgroundState]>([
      ["a service", { running: [SERVICE], jobsEnded: 0 }],
      ["a command with no mark", { running: [UNMARKED], jobsEnded: 0 }],
      ["nothing", NOTHING],
    ])("writes no background event when %s runs", async (_case, state) => {
      const setup = await started(LONG_LIMIT, (control) => (control.state = state));

      expect(backgroundEvents(setup.log)).toEqual([]);
      expect(setup.live.chat.state).toBe("needs-you");
    });

    it("writes the job again for a later turn, because the message clears it", async () => {
      const setup = await withJob(LONG_LIMIT);

      await setup.runner.message(setup.live, NEXT);
      const log = await logUntil(setup.live, "turn-end");

      expect(backgroundEvents(log)).toEqual([WAITS, WAITS]);
    });

    it("does not send a cancel during the check, because the prompt has returned", async () => {
      const setup = await started(LONG_LIMIT);
      const open = await holdNextCheck(setup, () => setup.runner.message(setup.live, NEXT));
      await until(() => promptsOf(setup, 0).length === 2, "the turn ran");

      await setup.runner.cancel(setup.live, CANCEL);
      open();
      await logUntil(setup.live, "turn-end");

      expect(setup.processes[0]?.cancels).toEqual([]);
    });

    it("writes no background event when the run becomes quiet during the check", async () => {
      const setup = await started(LONG_LIMIT);
      setup.control.state = JOB_RUNS;
      const open = await holdNextCheck(setup, () => setup.runner.message(setup.live, NEXT));

      setup.processes[0]?.exit({ code: 1, signal: null });
      const log = await logUntil(setup.live, "failed");
      open();
      await sleep(20);

      expect(backgroundEvents(log)).toEqual([]);
      expect(await logOf(setup.live)).toEqual(log);
    });
  });

  describe("with no turn of a message", () => {
    it.each<[string, SessionUpdate]>([
      ["agent_message_chunk", text("The tests passed")],
      ["agent_thought_chunk", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Reading" } }],
      ["tool_call", { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Read the log" }],
    ])("writes the own turn before the update, for %s", async (_case, update) => {
      const setup = await started(LONG_LIMIT);

      const log = await agentSends(setup, update);

      expect(log.slice(setup.log.length)).toEqual([OWN_TURN, { kind: "update", update: { ...update, filtered: true } }]);
      expect(setup.live.chat.state).toBe("working");
    });

    it("writes the own turn once, and keeps the job", async () => {
      const setup = await withJob(LONG_LIMIT);

      await agentSends(setup, text("The tests"));
      const log = await agentSends(setup, text(" passed"));

      expect(backgroundEvents(log)).toEqual([WAITS, OWN_TURN_WITH_JOB]);
    });

    it.each<[string, Script["setConfigOption"], boolean]>([
      ["a change", async (params, fake) => {
        await fake.update(NOTICE);
        return actAsAdapter(params, fake);
      }, true],
      ["a refused change", async (_params, fake) => {
        await fake.update(NOTICE);
        throw new Error("Not now");
      }, false],
    ])("opens no own turn for output during %s of an option, and output after it opens one", async (_case, setConfigOption, changes) => {
      const setup = await started({ ...LONG_LIMIT, script: { configOptions: [modelOption()], setConfigOption } });

      const picked = setup.runner.setOption(setup.live, MODEL_PICK);
      await (changes ? picked : expect(picked).rejects.toMatchObject({ code: "option-refused" }));
      await setup.live.written();

      expect(await logOf(setup.live)).toContainEqual({ kind: "update", update: { ...NOTICE, filtered: true } });
      expect(backgroundEvents(await logOf(setup.live))).toEqual([]);
      expect(setup.live.chat.state).toBe("needs-you");

      const log = await agentSends(setup, text("The tests passed"));

      expect(backgroundEvents(log)).toEqual([OWN_TURN]);
    });

    it.each<[string, SessionUpdate]>([
      ["tool_call_update", { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" }],
      ["usage_update with no cost", { sessionUpdate: "usage_update", used: 1, size: 2 }],
    ])("writes no background event for %s", async (_case, update) => {
      const setup = await started(LONG_LIMIT);

      const log = await agentSends(setup, update);

      expect(backgroundEvents(log)).toEqual([]);
      expect(setup.live.chat.state).toBe("needs-you");
    });

    it("does not read the marker during a turn of a message", async () => {
      const setup = await started(LONG_LIMIT);
      const open = await holdNextCheck(setup, () => setup.runner.message(setup.live, NEXT));
      const { checks } = setup.control;

      const log = await agentSends(setup, MARKER);
      open();
      await logUntil(setup.live, "turn-end");

      expect(setup.control.checks).toBe(checks);
      expect(backgroundEvents(log)).toEqual([]);
    });

    it("clears both values at the marker when no job runs, and only then needs the user", async () => {
      const setup = await withJob(LONG_LIMIT);
      await agentSends(setup, text("The tests passed"));
      setup.control.state = NOTHING;
      expect(setup.live.chat.state).toBe("working");

      await setup.processes[0]?.update(MARKER);
      const log = await logUntil(setup.live, "background");

      expect(log.at(-2)).toEqual({ kind: "update", update: { ...MARKER, filtered: true } });
      expect(log.at(-1)).toEqual(CLEAR);
      expect(setup.live.chat.state).toBe("needs-you");
      expect(setup.feed.filter((event) => event.kind === "chat").at(-1)).toEqual(chatState("needs-you"));
    });

    it("writes nothing and runs no check at a marker with no own turn, and the marker of the own turn then settles the state", async () => {
      const setup = await withJob(LONG_LIMIT);
      setup.control.state = NOTHING;
      const { checks } = setup.control;

      const log = await agentSends(setup, MARKER);
      await sleep(20);

      expect(setup.control.checks).toBe(checks);
      expect(backgroundEvents(log)).toEqual([WAITS]);
      expect(setup.live.chat.state).toBe("working");

      await agentSends(setup, text("Both test runs passed"));
      await setup.processes[0]?.update(MARKER);
      await until(() => !setup.live.fold.ownTurn, "the own turn ended");

      expect(backgroundEvents(await logOf(setup.live))).toEqual([WAITS, OWN_TURN_WITH_JOB, CLEAR]);
    });

    it("keeps a request of a subagent open at the marker of the own turn, and the answer reaches the agent", async () => {
      const setup = await started(LONG_LIMIT);
      await agentSends(setup, text("Started a subagent"));
      const asked = setup.processes[0]?.permission();
      const request = requestOf(await logUntil(setup.live, "permission"));

      await setup.processes[0]?.update(MARKER);
      await until(() => !setup.live.fold.ownTurn, "the own turn ended");

      expect(setup.live.fold.open).toEqual([request]);
      expect(setup.live.chat.state).toBe("needs-you");

      await setup.runner.answerPermission(setup.live, request, { optionId: "allow", client: CANCEL.client });

      expect(await asked).toMatchObject({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(setup.live.fold.open).toEqual([]);
    });

    it("keeps the job at the marker when another job runs", async () => {
      const setup = await withJob(LONG_LIMIT);
      await agentSends(setup, text("One test run passed"));

      await setup.processes[0]?.update(MARKER);
      await until(() => setup.runner.running(setup.live) !== undefined && setup.live.fold.ownTurn === false, "the turn ended");
      const log = await logOf(setup.live);

      expect(log.at(-1)).toEqual(WAITS);
      expect(setup.live.chat.state).toBe("working");
    });

    it("drops the check of a marker when output arrives during it, and the next marker settles the state", async () => {
      const setup = await started(LONG_LIMIT);
      await agentSends(setup, text("First"));
      const open = await holdNextCheck(setup, () => agentSends(setup, MARKER));

      await agentSends(setup, text("Second"));
      open();
      await sleep(20);
      expect((await logOf(setup.live)).at(-1)).toEqual({ kind: "update", update: { ...text("Second"), filtered: true } });

      await setup.processes[0]?.update(MARKER);
      expect((await logUntil(setup.live, "background")).at(-1)).toEqual(CLEAR);
    });

    it("writes nothing for the check of a marker when a message arrives during it", async () => {
      const setup = await started({ ...LONG_LIMIT, script: SECOND_TURN_HELD });
      await agentSends(setup, text("First"));
      setup.control.state = JOB_RUNS;
      const open = await holdNextCheck(setup, () => agentSends(setup, MARKER));

      await setup.runner.message(setup.live, NEXT);
      const log = await logOf(setup.live);
      open();
      await sleep(20);

      expect(await logOf(setup.live)).toEqual(log);
      expect(log.at(-1)).toEqual({ kind: "user", ...NEXT });
    });

    it("drops the check of a marker when a whole turn of a message runs during it, so the job of that turn stays", async () => {
      const setup = await started(LONG_LIMIT);
      await agentSends(setup, text("First"));
      const open = await holdNextCheck(setup, () => agentSends(setup, MARKER));

      setup.control.state = JOB_RUNS;
      await setup.runner.message(setup.live, NEXT);
      const log = await logUntil(setup.live, "turn-end");
      open();
      await sleep(20);

      expect(backgroundEvents(log).at(-1)).toEqual(WAITS);
      expect(await logOf(setup.live)).toEqual(log);
      expect(setup.live.chat.state).toBe("working");
    });

    it("writes nothing for the check of a marker when the process exits during it", async () => {
      const setup = await started(LONG_LIMIT);
      await agentSends(setup, text("First"));
      const open = await holdNextCheck(setup, () => agentSends(setup, MARKER));

      setup.processes[0]?.exit({ code: 1, signal: null });
      const log = await logUntil(setup.live, "failed");
      open();
      await sleep(20);

      expect(await logOf(setup.live)).toEqual(log);
    });

    it("writes nothing for the check of a marker when a new run of the chat starts", async () => {
      const setup = await started(LONG_LIMIT);
      await agentSends(setup, text("First"));
      setup.control.state = JOB_RUNS;
      const open = await holdNextCheck(setup, () => agentSends(setup, MARKER));

      setup.processes[0]?.exit({ code: 0, signal: null });
      await until(() => setup.runner.running(setup.live) === undefined, "the chat stopped running");
      setup.control.state = NOTHING;
      await setup.runner.message(setup.live, NEXT);
      const log = await logUntil(setup.live, "turn-end");
      open();
      await sleep(20);

      expect(await logOf(setup.live)).toEqual(log);
    });
  });

  describe("cancel", () => {
    it("reaches the agent in an own turn, and writes the stop with the job that runs", async () => {
      const setup = await withJob(LONG_LIMIT);
      await agentSends(setup, text("The tests passed"));

      await setup.runner.cancel(setup.live, CANCEL);

      expect(setup.processes[0]?.cancels).toHaveLength(1);
      expect((await logOf(setup.live)).at(-1)).toEqual({ ...WAITS, stopReason: "cancelled" });
      expect(setup.live.chat.state).toBe("working");
    });

    it("needs the user after a stop when no job runs", async () => {
      const setup = await started(LONG_LIMIT);
      await agentSends(setup, text("The tests passed"));

      await setup.runner.cancel(setup.live, CANCEL);

      expect((await logOf(setup.live)).at(-1)).toEqual(STOPPED);
      expect(setup.live.chat.state).toBe("needs-you");
    });

    it("writes the stop although output arrives during its check", async () => {
      const setup = await started(LONG_LIMIT);
      await agentSends(setup, text("First"));
      const { cancelled, open } = await cancelWithHeldCheck(setup);

      await agentSends(setup, text("Second"));
      open();
      await cancelled;

      expect((await logOf(setup.live)).at(-1)).toEqual(STOPPED);
    });

    describe("with late output of the stopped turn", () => {
      async function stoppedTurn(options: WorldOptions = LONG_LIMIT): Promise<Started> {
        const setup = await started(options);
        await agentSends(setup, text("First"));
        await setup.runner.cancel(setup.live, CANCEL);
        return setup;
      }

      it("does not open the own turn again", async () => {
        const setup = await stoppedTurn();

        const log = await agentSends(setup, text("Late"));

        expect(backgroundEvents(log)).toEqual([OWN_TURN, STOPPED]);
        expect(setup.live.chat.state).toBe("needs-you");
      });

      it("opens the own turn again for output after the marker", async () => {
        const setup = await stoppedTurn();
        await agentSends(setup, MARKER);

        const log = await agentSends(setup, text("A later turn"));

        expect(backgroundEvents(log)).toEqual([OWN_TURN, STOPPED, OWN_TURN]);
      });

      it("opens the own turn again for output after a message", async () => {
        const setup = await stoppedTurn();
        await setup.runner.message(setup.live, NEXT);
        await logUntil(setup.live, "turn-end");

        const log = await agentSends(setup, text("A later turn"));

        expect(backgroundEvents(log)).toEqual([OWN_TURN, STOPPED, OWN_TURN]);
      });
    });

    describe("with the check of a marker at the same time", () => {
      it("keeps the notice when the marker arrives during the check of the stop, and its check ends first", async () => {
        const setup = await started(LONG_LIMIT);
        await agentSends(setup, text("First"));
        const { cancelled, open } = await cancelWithHeldCheck(setup);
        const { checks } = setup.control;

        await agentSends(setup, MARKER);
        await until(() => setup.control.checks > checks, "the check of the marker started");
        await sleep(20);
        open();
        await cancelled;

        expect(backgroundEvents(await logOf(setup.live))).toEqual([OWN_TURN, STOPPED]);
      });

      it("keeps the notice when the check of an earlier marker ends during the check of the stop", async () => {
        const setup = await started(LONG_LIMIT);
        await agentSends(setup, text("First"));
        const openMarker = await holdNextCheck(setup, () => agentSends(setup, MARKER));
        const { cancelled, open: openStop } = await cancelWithHeldCheck(setup);

        openMarker();
        await sleep(20);
        openStop();
        await cancelled;

        expect(backgroundEvents(await logOf(setup.live))).toEqual([OWN_TURN, STOPPED]);
      });
    });

    it("drops the check of a stop when a whole turn of a message runs during it", async () => {
      const setup = await started(LONG_LIMIT);
      await agentSends(setup, text("First"));
      const { cancelled, open } = await cancelWithHeldCheck(setup);

      setup.control.state = JOB_RUNS;
      await setup.runner.message(setup.live, NEXT);
      const log = await logUntil(setup.live, "turn-end");
      open();
      await cancelled;

      expect(backgroundEvents(log).at(-1)).toEqual(WAITS);
      expect(await logOf(setup.live)).toEqual(log);
    });

    it("resolves the open requests of the own turn in the name of the client", async () => {
      const setup = await started(LONG_LIMIT);
      await agentSends(setup, text("First"));
      const asked = setup.processes[0]?.permission();
      const log = await logUntil(setup.live, "permission");

      await setup.runner.cancel(setup.live, CANCEL);
      await asked;

      const after = await logOf(setup.live);
      expect(after.slice(log.length)).toEqual([
        { kind: "permission-resolved", request: requestOf(log), outcome: { outcome: "cancelled" }, client: CANCEL.client },
        STOPPED,
      ]);
    });

    it.each<[string, BackgroundState]>([
      ["a job wait", JOB_RUNS],
      ["nothing running", NOTHING],
    ])("does nothing with %s", async (_case, state) => {
      const setup = await started(LONG_LIMIT, (control) => (control.state = state));

      await setup.runner.cancel(setup.live, CANCEL);

      expect(setup.processes[0]?.cancels).toEqual([]);
      expect(await logOf(setup.live)).toEqual(setup.log);
    });
  });

  describe("at the end of the agent, after a job wait", () => {
    it("clears the values at a stop, and then ends the process", async () => {
      const setup = await withJob(LONG_LIMIT);

      await setup.runner.stop(setup.live);

      expect(await logOf(setup.live)).toEqual([...setup.log, CLEAR]);
      expect(setup.live.chat.state).toBe("needs-you");
      expect(setup.processes[0]?.endCalls).toBeGreaterThan(0);
    });

    it("clears the values at an end, and then ends the process", async () => {
      const setup = await withJob(LONG_LIMIT);

      await setup.runner.end(setup.live, CANCEL);

      expect(await logOf(setup.live)).toEqual([...setup.log, CLEAR]);
      expect(setup.live.chat.state).toBe("needs-you");
      expect(setup.processes[0]?.endCalls).toBeGreaterThan(0);
    });

    it("clears the values at a clean exit", async () => {
      const setup = await withJob(LONG_LIMIT);

      setup.processes[0]?.exit({ code: 0, signal: null });
      await until(() => setup.runner.running(setup.live) === undefined, "the chat stopped running");
      await setup.live.written();

      expect(await logOf(setup.live)).toEqual([...setup.log, CLEAR]);
      expect(setup.live.chat.state).toBe("needs-you");
    });

    it("writes no second clear at the exit after a stop", async () => {
      const setup = await withJob(LONG_LIMIT);

      await setup.runner.stop(setup.live);
      await setup.live.written();

      expect(backgroundEvents(await logOf(setup.live))).toEqual([WAITS, CLEAR]);
    });

    it("leaves no working chat at a pick relaunch", async () => {
      const setup = await withJob({ ...LONG_LIMIT, script: { configOptions: [modeOption()] } });
      setup.processes[0]?.exit({ code: 1, signal: null });
      await logUntil(setup.live, "failed");

      await setup.runner.setOption(setup.live, PICK);

      expect(setup.live.chat.state).toBe("needs-you");
      expect(setup.live.fold.job).toBe(false);
    });
  });

  describe("at an idle check", () => {
    it("clears the job when no job runs, and the agent stays while an ended job gives one more limit", async () => {
      const setup = await withJob();
      setup.control.state = { running: [], jobsEnded: 1 };

      await until(() => !setup.live.fold.job, "the job was cleared");
      const log = await logOf(setup.live);

      expect(log).toEqual([...setup.log, CLEAR]);
      expect(setup.processes[0]?.endCalls).toBe(0);
      expect(setup.live.chat.state).toBe("needs-you");
      await stopped(setup);
      expect(await logOf(setup.live)).toEqual(log);
    });

    it("keeps the own turn when its job ended", async () => {
      const setup = await withJob();
      await agentSends(setup, text("Still testing"));
      setup.control.state = NOTHING;

      const log = await logUntil(setup.live, "background");

      expect(log.at(-1)).toEqual(OWN_TURN);
      expect(setup.live.chat.state).toBe("working");
    });

    it("keeps the agent in an own turn at the idle limit", async () => {
      const setup = await withJob();
      await agentSends(setup, text("Reading"));
      setup.control.state = NOTHING;
      const { checks } = setup.control;

      await until(() => setup.control.checks >= checks + 3, "three more checks ran");

      expect(setup.processes[0]?.endCalls).toBe(0);
      expect(setup.live.chat.state).toBe("working");
    });

    it("fails the chat with the reason when an own turn reaches the hold limit", async () => {
      const options = { jobHoldMs: 600 };
      const setup = await withJob(options);
      const sent = await agentSends(setup, text("Reading"));
      setup.control.state = NOTHING;

      const log = await logUntil(setup.live, "failed");
      await stopped(setup);

      expect(log).toEqual([...sent, OWN_TURN, { kind: "failed", reason: ownTurnReason(options.jobHoldMs) }]);
      expect(setup.live.chat.state).toBe("failed");
    });

    it("gives the reason of the job when a job also runs at the hold limit", async () => {
      const options = { jobHoldMs: 600 };
      const setup = await withJob(options);
      await agentSends(setup, text("Reading"));

      const log = await logUntil(setup.live, "failed");

      expect(log.at(-1)).toEqual({ kind: "failed", reason: holdReason([JOB], [], options.jobHoldMs) });
    });

    it("notes a service that the failure of an own turn ends", async () => {
      const setup = await withJob({ jobHoldMs: 600 });
      await agentSends(setup, text("Reading"));
      setup.control.state = { running: [SERVICE], jobsEnded: 0 };
      await logUntil(setup.live, "failed");
      await stopped(setup);
      setup.control.state = NOTHING;

      await setup.runner.message(setup.live, NEXT);
      await logUntil(setup.live, "turn-end");

      expect(promptsOf(setup, 1)).toEqual([`${stopNote([SERVICE])}\n\n${NEXT.text}`]);
    });
  });

  it("writes no background event for an adapter with no background commands, and an update with no turn opens no own turn", async () => {
    const setup = await world(LONG_LIMIT);
    const live = await setup.runner.start(START);
    const before = await logUntil(live, "turn-end");

    await setup.processes[0]?.update(text("Hello"));
    const log = await logUntil(live, "update");
    await setup.runner.cancel(live, CANCEL);

    expect(log).toEqual([...before, filtered(text("Hello") as unknown as AcpObject)]);
    expect(setup.processes[0]?.cancels).toEqual([]);
    expect(live.chat.state).toBe("needs-you");
  });

  describe("during a check", () => {
    function held(options: WorldOptions = {}, state: BackgroundState = NOTHING) {
      const { opened, open } = gate();
      const starting = started(options, (control) => {
        // The check at the end of the first turn passes, and the idle check after it is held.
        control.planned = [NOTHING];
        control.hold = opened;
        control.holdFrom = 2;
        control.state = state;
      });
      return { starting, open };
    }

    async function checking(setup: Started): Promise<void> {
      await until(() => setup.control.checks === 2, "the check started");
    }

    it("does not stop the agent at an update", async () => {
      const { starting, open } = held({ idleLimit: async () => 200 });
      const setup = await starting;
      await checking(setup);

      await setup.processes[0]?.update(PLAN);
      await until(() => setup.control.notes.length === 1, "the runner read the update");
      open();
      await sleep(100);

      expect(setup.processes[0]?.endCalls).toBe(0);
      await stopped(setup);
      expect(setup.control.checks).toBe(3);
    });

    it("keeps an ended job that the check found for the next check, when an update arrives during it", async () => {
      const { starting, open } = held({ idleLimit: async () => 200 }, { running: [], jobsEnded: 1 });
      const setup = await starting;
      await checking(setup);

      await setup.processes[0]?.update(PLAN);
      await until(() => setup.control.notes.length === 1, "the runner read the update");
      open();

      await stopped(setup);
      expect(setup.control.checks).toBe(4);
    });

    it("does not stop the agent at a message", async () => {
      const { starting, open } = held({ idleLimit: async () => 300 });
      const setup = await starting;
      await checking(setup);

      setup.control.holdFrom = Infinity;
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
      const { starting, open } = held(options, JOB_RUNS);
      const setup = await starting;
      await checking(setup);
      setup.control.state = { running: [], jobsEnded: 0 };
      setup.control.holdFrom = Infinity;

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
      const { starting, open } = held({ jobHoldMs: 0 }, JOB_RUNS);
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

    const fault = faultLine(setup.live.chat, "the check broke");
    expect(setup.errors).toEqual([fault, fault]);
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
