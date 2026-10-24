import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentLaunch } from "../../src/agents/adapter.js";
import type { IdleLimit } from "../../src/chats/idle.js";
import type { LiveChat } from "../../src/chats/registry.js";
import type { ChatAgent, ChatEvent } from "@tasma/protocol";
import { logOf, logUntil, target, until } from "../helpers.js";
import { forever, PERMISSION, SESSION, text } from "../agents/fake-agent.js";
import {
  chatState,
  endedByRunner,
  fakeAdapter,
  filtered,
  heldTurns,
  LAUNCH,
  NEXT,
  requestOf,
  slowEnd,
  START,
  USER,
  world,
} from "./runner-world.js";
import type { World } from "./runner-world.js";

/** An idle limit that each chat reaches within a test. */
const SHORT_IDLE: IdleLimit = async () => 30;

describe("createChatRunner idle stop", () => {
  it("ends the process after the limit, writes no event, and keeps the chat in needs-you", async () => {
    const { runner, processes, feed } = await world({ idleLimit: SHORT_IDLE });
    const live = await runner.start(START);
    const log = await logUntil(live, "turn-end");

    await endedByRunner(processes[0]);
    await processes[0]?.ended;
    await until(() => runner.running(live) === undefined, "the chat stopped running");

    expect(await logOf(live)).toEqual(log);
    expect(live.chat.state).toBe("needs-you");
    expect(feed.filter((event) => event.kind === "chat").at(-1)).toEqual(chatState("needs-you"));
  });

  it("reads the limit from the place and the step of the chat at each start of its agent", async () => {
    const asked: string[][] = [];
    const { runner } = await world({
      idleLimit: async (...place) => {
        asked.push(place);
        return 60_000;
      },
    });
    const live = await runner.start(START);
    await logUntil(live, "turn-end");
    await runner.stop(live);

    await runner.message(live, NEXT);
    await logUntil(live, "turn-end");

    expect(asked).toEqual([["ALPHA", "ALPHA-1", START.step], ["ALPHA", "ALPHA-1", START.step]]);
  });

  it("does not stop while a request of the agent's own work is open, and starts the time again at its answer", async () => {
    const { runner, processes } = await world({ idleLimit: async () => 300 });
    const live = await runner.start(START);
    await logUntil(live, "turn-end");
    void processes[0]?.permission().catch(() => undefined);
    const request = requestOf(await logUntil(live, "permission"));

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(processes[0]?.endCalls).toBe(0);
    await runner.answerPermission(live, request, { optionId: "allow", client: "web" });

    await endedByRunner(processes[0]);
    expect(live.chat.state).toBe("needs-you");
  });

  it("does not stop the agent in a turn that a message starts before the limit", async () => {
    const { script, finish } = heldTurns();
    const { runner, processes } = await world({ script, idleLimit: async () => 200 });
    const live = await runner.start(START);
    await until(() => processes[0]?.prompts.length === 1, "the first turn started");
    finish();
    await until(() => live.chat.state === "needs-you", "the first turn ended");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runner.message(live, NEXT);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(processes[0]?.endCalls).toBe(0);
    finish();
    await endedByRunner(processes[0]);
  });

  it("starts the time again at an update of the agent's own work", async () => {
    const { runner, processes } = await world({ idleLimit: async () => 400 });
    const live = await runner.start(START);
    await until(() => live.chat.state === "needs-you", "the turn ended");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await processes[0]?.update(text("The build passed"));

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(processes[0]?.endCalls).toBe(0);
    await endedByRunner(processes[0]);
    expect((await logOf(live)).at(-1)).toEqual(filtered(text("The build passed")));
  });

  it("does not fail the chat when a kill ends the process", async () => {
    const { runner, processes } = await world({
      idleLimit: SHORT_IDLE,
      started(fake) {
        fake.end = () => {
          fake.endCalls += 1;
          fake.exit({ code: null, signal: "SIGKILL" });
          return fake.ended.then(() => undefined);
        };
      },
    });
    const live = await runner.start(START);
    const log = await logUntil(live, "turn-end");

    await endedByRunner(processes[0]);
    await until(() => runner.running(live) === undefined, "the chat stopped running");
    await new Promise((resolve) => setImmediate(resolve));

    expect(await logOf(live)).toEqual(log);
    expect(live.chat.state).toBe("needs-you");
  });

  it("stops no agent after stopStarts", async () => {
    const { script, finish } = heldTurns();
    const { runner, processes } = await world({ script, idleLimit: SHORT_IDLE });
    const live = await runner.start(START);
    await until(() => processes[0]?.prompts.length === 1, "the turn started");

    runner.stopStarts();
    finish();
    await logUntil(live, "turn-end");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(processes[0]?.endCalls).toBe(0);
  });
});

describe("createChatRunner.message to a chat with no process", () => {
  /** Chat 1 of ALPHA-1, which the registry created with its first message and which no agent ever ran. */
  async function chatWithNoRun(setup: World, folder = setup.folder, agent: ChatAgent = "claude"): Promise<LiveChat> {
    return setup.chats.create("ALPHA", "ALPHA-1", { step: START.step, agent, folder }, { text: START.text, client: START.client });
  }

  it("starts a new process in the folder of the chat, resumes the stored session, and prompts with the message", async () => {
    const { runner, processes, folder } = await world();
    const live = await runner.start(START);
    const log = await logUntil(live, "turn-end");
    await runner.stop(live);

    await runner.message(live, NEXT);

    expect(live.chat.state).toBe("working");
    expect(await logUntil(live, "turn-end")).toEqual([
      ...log,
      { kind: "user", ...NEXT },
      { kind: "turn-end", stopReason: "end_turn" },
    ]);
    expect(processes.map((fake) => fake.folder)).toEqual([folder, folder]);
    expect(processes[1]?.resumes).toEqual([{ sessionId: SESSION, cwd: folder, mcpServers: [] }]);
    expect(processes[1]?.newSession).toBeUndefined();
    expect(processes[1]?.prompts).toEqual([{ sessionId: SESSION, prompt: [{ type: "text", text: NEXT.text }] }]);
    expect(runner.running(live)?.process).toBe(processes[1]);
  });

  for (const cause of ["an idle stop", "a failure"] as const) {
    it(`waits for the end of the last process after ${cause}, and refuses a second message meanwhile`, async () => {
      let prompts = 0;
      let firstEnded = false;
      const spawnedAfterEnd: boolean[] = [];
      const { runner, processes } = await world({
        script: {
          async prompt() {
            prompts += 1;
            if (cause === "a failure" && prompts === 1) throw RequestError.internalError({ details: "broken" });
            return { stopReason: "end_turn" };
          },
        },
        idleLimit: cause === "an idle stop" ? SHORT_IDLE : undefined,
        started(fake) {
          spawnedAfterEnd.push(firstEnded);
          slowEnd(100)(fake);
        },
      });
      const live = await runner.start(START);
      void processes[0]?.ended.then(() => (firstEnded = true));
      await endedByRunner(processes[0]);

      const sent = runner.message(live, NEXT);
      await expect(runner.message(live, { ...NEXT, client: "app" })).rejects.toMatchObject({ code: "turn-running" });
      await sent;

      expect(firstEnded).toBe(true);
      expect((await logUntil(live, "turn-end")).filter((event) => event.kind === "user")).toEqual([USER, { kind: "user", ...NEXT }]);
      expect(spawnedAfterEnd).toEqual([false, true]);
    });
  }

  it("makes a failed chat working, and resumes its session", async () => {
    const { runner, processes, feed } = await world();
    const live = await runner.start(START);
    await logUntil(live, "turn-end");
    processes[0]?.exit({ code: 137, signal: null });
    await logUntil(live, "failed");

    await runner.message(live, NEXT);
    await logUntil(live, "turn-end");

    expect(feed.flatMap((event) => (event.kind === "chat" ? [event.state] : []))).toEqual([
      "working",
      "needs-you",
      "failed",
      "working",
      "needs-you",
    ]);
    expect(processes[1]?.resumes).toHaveLength(1);
  });

  it("opens a new session for a chat with no session, prompts with all its messages, and keeps the new id", async () => {
    let launch: AgentLaunch | { failed: string } = { failed: "No agent here" };
    const { runner, processes, folder } = await world({ adapter: { ...fakeAdapter().adapter, launch: () => launch } });
    const live = await runner.start(START);
    expect(await logOf(live)).toEqual([USER, { kind: "failed", reason: "No agent here" }]);
    launch = LAUNCH;

    await runner.message(live, NEXT);

    expect((await logUntil(live, "turn-end")).slice(-2)).toEqual([{ kind: "user", ...NEXT }, { kind: "turn-end", stopReason: "end_turn" }]);
    expect(processes[0]?.resumes).toEqual([]);
    expect(processes[0]?.newSession).toEqual({ cwd: folder, mcpServers: [] });
    expect(processes[0]?.prompts.map((prompt) => prompt.prompt)).toEqual([[{ type: "text", text: `${START.text}\n\n${NEXT.text}` }]]);
    expect(live.chat.session).toBe(SESSION);
  });

  it("opens a new session with all the messages when the agent lost a session it never answered in", async () => {
    let sessions = 0;
    let release: (() => void) | undefined;
    const { runner, processes } = await world({
      script: {
        async newSession(_params, agent) {
          sessions += 1;
          await agent.update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          if (sessions === 1) await new Promise<void>((resolve) => (release = resolve));
          return { sessionId: `session-${sessions}` };
        },
        async resume() {
          throw RequestError.resourceNotFound("session-1");
        },
      },
    });
    const live = await runner.start(START);
    await until(() => release !== undefined, "the start of the session is held");
    await runner.cancel(live, { client: "web" });
    release?.();
    await logUntil(live, "turn-end");
    await runner.stop(live);

    await runner.message(live, NEXT);
    await logUntil(live, "turn-end");

    expect(processes[1]?.resumes).toMatchObject([{ sessionId: "session-1" }]);
    expect(processes[1]?.prompts).toEqual([
      { sessionId: "session-2", prompt: [{ type: "text", text: `${START.text}\n\n${NEXT.text}` }] },
    ]);
    expect(live.chat.session).toBe("session-2");
  });

  it("opens a new session with all the messages when the agent lost a session whose first turn the user cancelled at the agent", async () => {
    const { script, finish } = heldTurns();
    const { runner, processes } = await world({
      script: { ...script, resume: () => Promise.reject(RequestError.resourceNotFound(SESSION)) },
    });
    const live = await runner.start(START);
    await until(() => processes[0]?.prompts.length === 1, "the first turn started");
    await runner.cancel(live, { client: "web" });
    await logUntil(live, "turn-end");
    await runner.stop(live);

    await runner.message(live, NEXT);
    await until(() => processes[1]?.prompts.length === 1, "the turn of the new session started");

    expect(processes[1]?.prompts[0]?.prompt).toEqual([{ type: "text", text: `${START.text}\n\n${NEXT.text}` }]);
    finish();
  });

  it("resolves the open requests of the log and interrupts it before the message, and runs in the folder of the chat", async () => {
    const setup = await world();
    const elsewhere = await target();
    const live = await chatWithNoRun(setup, elsewhere);
    await live.append({ kind: "permission", request: "r-1", permission: PERMISSION });

    await setup.runner.message(live, NEXT);

    expect(await logUntil(live, "turn-end")).toEqual([
      USER,
      { kind: "permission", request: "r-1", permission: PERMISSION },
      { kind: "permission-resolved", request: "r-1", outcome: { outcome: "cancelled" } },
      { kind: "interrupted" },
      { kind: "user", ...NEXT },
      { kind: "turn-end", stopReason: "end_turn" },
    ]);
    expect(setup.processes.map((fake) => fake.folder)).toEqual([elsewhere]);
  });

  it("ends the turn as cancelled with no prompt at a cancel during the restart, and keeps the process", async () => {
    let release: (() => void) | undefined;
    const { runner, processes } = await world({
      script: { resume: () => new Promise((resolve) => (release = () => resolve({}))) },
    });
    const live = await runner.start(START);
    const log = await logUntil(live, "turn-end");
    await runner.stop(live);
    await runner.message(live, NEXT);
    await until(() => release !== undefined, "the resume is held");

    await expect(runner.message(live, NEXT)).rejects.toMatchObject({ code: "turn-running" });
    await runner.cancel(live, { client: "web" });
    release?.();

    expect(await logUntil(live, "turn-end")).toEqual([
      ...log,
      { kind: "user", ...NEXT },
      { kind: "turn-end", stopReason: "cancelled" },
    ]);
    expect(processes[1]?.prompts).toEqual([]);
    expect(processes[1]?.cancels).toEqual([]);
    expect(runner.running(live)?.process).toBe(processes[1]);
  });

  it("spawns nothing when the daemon stop begins during the launch, and the close interrupts the chat", async () => {
    let release: (() => void) | undefined;
    let reads = 0;
    const { runner, processes } = await world({
      async idleLimit() {
        reads += 1;
        if (reads > 1) await new Promise<void>((resolve) => (release = resolve));
        return 60_000;
      },
    });
    const live = await runner.start(START);
    const log = await logUntil(live, "turn-end");
    await runner.stop(live);
    await runner.message(live, NEXT);
    await until(() => release !== undefined, "the restart reads its limit");

    runner.stopStarts();
    release?.();
    await runner.close();

    expect(processes).toHaveLength(1);
    expect(await logOf(live)).toEqual([...log, { kind: "user", ...NEXT }, { kind: "interrupted" }]);
  });

  for (const how of ["stopStarts", "close"] as const) {
    it(`refuses a message whose wait for the last process ${how} overtakes, and writes nothing`, async () => {
      const { runner, processes } = await world({ started: slowEnd(100) });
      const live = await runner.start(START);
      const log = await logUntil(live, "turn-end");
      void runner.stop(live);
      await endedByRunner(processes[0]);
      const sent = runner.message(live, NEXT);

      if (how === "stopStarts") runner.stopStarts();
      else await runner.close();

      await expect(sent).rejects.toMatchObject({ code: "chat-not-running" });
      expect(await logOf(live)).toEqual(log);
      expect(processes).toHaveLength(1);
      expect(runner.running(live)).toBeUndefined();
    });
  }

  it("refuses a message when the daemon stop begins while the log is interrupted, and writes no message", async () => {
    const setup = await world();
    const live = await chatWithNoRun(setup);
    await live.append({ kind: "permission", request: "r-1", permission: PERMISSION });
    const interrupt = live.interrupt.bind(live);
    vi.spyOn(live, "interrupt").mockImplementation(async () => {
      setup.runner.stopStarts();
      await interrupt();
    });

    await expect(setup.runner.message(live, NEXT)).rejects.toMatchObject({ code: "chat-not-running" });

    expect((await logOf(live)).slice(-2)).toEqual([
      { kind: "permission-resolved", request: "r-1", outcome: { outcome: "cancelled" } },
      { kind: "interrupted" },
    ]);
    expect(setup.processes).toEqual([]);
  });

  for (const [crash, failure] of [
    ["an exit with an error between turns", [{ kind: "failed", reason: "The agent process ended with exit code 137" }]],
    ["an exit with code 0 between turns", []],
    ["an exit during a turn", [{ kind: "failed", reason: "The agent process ended with exit code 0" }]],
  ] as const) {
    it(`restarts after ${crash} while the group of the process ends, and writes the message after the exit`, async () => {
      let release!: () => void;
      let prompts = 0;
      const { runner, processes } = await world({
        script: {
          async prompt(_params, agent) {
            prompts += 1;
            if (crash !== "an exit during a turn" || prompts > 1) return { stopReason: "end_turn" };
            agent.exit({ code: 0, signal: null });
            return forever();
          },
        },
        started(fake) {
          if (processes.length === 1) fake.group = new Promise((resolve) => (release = resolve));
        },
      });
      const live = await runner.start(START);
      if (crash !== "an exit during a turn") {
        await logUntil(live, "turn-end");
        processes[0]?.exit({ code: crash === "an exit with code 0 between turns" ? 0 : 137, signal: null });
      }
      await until(() => runner.running(live) === undefined, "the chat stopped running");

      const sent = runner.message(live, NEXT);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(processes).toHaveLength(1);
      release();
      await sent;

      const before = crash === "an exit during a turn" ? [USER] : [USER, { kind: "turn-end", stopReason: "end_turn" }];
      expect(await logUntil(live, "turn-end")).toEqual([
        ...before,
        ...failure,
        { kind: "user", ...NEXT },
        { kind: "turn-end", stopReason: "end_turn" },
      ]);
      expect(processes[1]?.resumes).toHaveLength(1);
    });
  }

  it("sends a message that the agent did not get with the next message", async () => {
    let resumes = 0;
    const { runner, processes } = await world({
      script: {
        async resume() {
          resumes += 1;
          if (resumes === 1) throw RequestError.authRequired();
          return {};
        },
      },
    });
    const live = await runner.start(START);
    await logUntil(live, "turn-end");
    await runner.stop(live);
    await runner.message(live, NEXT);
    await logUntil(live, "failed");

    await runner.message(live, { text: "And the tests", client: "web" });
    await logUntil(live, "turn-end");

    expect(processes[1]?.prompts).toEqual([]);
    expect(processes[2]?.prompts.map((prompt) => prompt.prompt)).toEqual([
      [{ type: "text", text: `${NEXT.text}\n\nAnd the tests` }],
    ]);
  });

  for (const when of ["after an answer of the agent", "before any answer of the agent"] as const) {
    it(`sends no message again whose turn the user cancelled at the agent ${when}`, async () => {
      const { script, finish } = heldTurns();
      const { runner, processes } = await world({ script });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the first turn started");
      if (when === "after an answer of the agent") {
        finish();
        await logUntil(live, "turn-end");
        await runner.message(live, { text: "Delete the build folder", client: "web" });
        await until(() => processes[0]?.prompts.length === 2, "the second turn started");
      }
      await runner.cancel(live, { client: "web" });
      await logUntil(live, "turn-end");
      await runner.stop(live);

      await runner.message(live, NEXT);
      await until(() => processes[1]?.prompts.length === 1, "the turn of the restart started");

      expect(processes[1]?.prompts[0]?.prompt).toEqual([{ type: "text", text: NEXT.text }]);
      finish();
    });
  }

  for (const then of ["in the same process", "after a stop"] as const) {
    it(`sends the message of a restart that the user cancelled before its prompt to no later prompt ${then}`, async () => {
      let release: (() => void) | undefined;
      let resumes = 0;
      const { runner, processes } = await world({
        script: {
          async resume() {
            resumes += 1;
            if (resumes === 1) await new Promise<void>((resolve) => (release = resolve));
            return {};
          },
        },
      });
      const live = await runner.start(START);
      await logUntil(live, "turn-end");
      await runner.stop(live);
      await runner.message(live, { text: "Delete the build folder", client: "web" });
      await until(() => release !== undefined, "the resume is held");
      await runner.cancel(live, { client: "web" });
      release?.();
      await logUntil(live, "turn-end");
      if (then === "after a stop") await runner.stop(live);

      await runner.message(live, NEXT);
      await logUntil(live, "turn-end");

      expect(processes.at(-1)?.prompts.map((prompt) => prompt.prompt)).toEqual([[{ type: "text", text: NEXT.text }]]);
    });
  }

  it("prompts with every message of the log after the last answer of the agent and the last cancelled turn after it", async () => {
    const setup = await world();
    const live = await chatWithNoRun(setup);
    await live.setSession(SESSION);
    await live.append(filtered(text("Parsed")));
    await live.append({ kind: "turn-end", stopReason: "end_turn" });
    await live.append({ kind: "user", text: "Delete the build folder", client: "web" });
    await live.append({ kind: "update", update: { sessionUpdate: "available_commands_update", availableCommands: [] } });
    await live.append({ kind: "turn-end", stopReason: "cancelled" });
    await live.append({ kind: "user", text: "Add a lexer", client: "web" });
    await live.append({ kind: "interrupted" });
    await live.append({ kind: "user", text: "Add a printer", client: "web" });
    await live.append({ kind: "failed", reason: "No agent here" });

    await setup.runner.message(live, NEXT);
    await logUntil(live, "turn-end");

    expect(setup.processes[0]?.resumes).toHaveLength(1);
    expect(setup.processes[0]?.prompts.map((prompt) => prompt.prompt)).toEqual([
      [{ type: "text", text: `Add a lexer\n\nAdd a printer\n\n${NEXT.text}` }],
    ]);
  });

  describe("with a log longer than one page of a read", () => {
    const LONG = "x".repeat(1024 * 1024 + 1);

    /** The last event of the log. */
    async function lastOf(live: LiveChat): Promise<ChatEvent | undefined> {
      return (await live.read(live.chat.seq - 1)).at(-1)?.event;
    }

    it("opens a new session whose prompt holds every message of the chat", async () => {
      const setup = await world();
      const live = await chatWithNoRun(setup);
      await live.append({ kind: "failed", reason: LONG });
      await live.append({ kind: "user", text: "Add a lexer", client: "web" });
      await live.append({ kind: "failed", reason: "No agent here" });

      await setup.runner.message(live, NEXT);
      await until(() => live.chat.state === "needs-you", "the turn ended");

      expect(setup.processes[0]?.prompts.map((prompt) => prompt.prompt)).toEqual([
        [{ type: "text", text: `${START.text}\n\nAdd a lexer\n\n${NEXT.text}` }],
      ]);
    });

    it("fails the chat when the agent lost a session it answered in after the long part", async () => {
      const setup = await world({ script: { resume: () => Promise.reject(RequestError.resourceNotFound(SESSION)) } });
      const live = await chatWithNoRun(setup);
      await live.setSession(SESSION);
      await live.append({ kind: "failed", reason: LONG });
      await live.append({ kind: "user", text: "Add a lexer", client: "web" });
      await live.append(filtered(text("Added")));
      await live.append({ kind: "turn-end", stopReason: "end_turn" });

      await setup.runner.message(live, NEXT);
      await until(() => live.chat.state === "failed", "the chat failed");

      expect(await lastOf(live)).toEqual({ kind: "failed", reason: "The agent lost the chat" });
      expect(setup.processes[0]?.newSession).toBeUndefined();
    });
  });

  describe("fails the chat", () => {
    it("when the agent lost a session it answered in, with the text of the adapter", async () => {
      const { runner, processes } = await world({
        script: {
          async prompt(_params, agent) {
            await agent.update(text("Done"));
            return { stopReason: "end_turn" };
          },
          async resume() {
            throw RequestError.resourceNotFound(SESSION);
          },
        },
      });
      const live = await runner.start(START);
      await logUntil(live, "turn-end");
      await runner.stop(live);

      await runner.message(live, NEXT);

      expect((await logUntil(live, "failed")).slice(-2)).toEqual([
        { kind: "user", ...NEXT },
        { kind: "failed", reason: "The agent lost the chat" },
      ]);
      expect(processes[1]?.newSession).toBeUndefined();
      expect(processes[1]?.prompts).toEqual([]);
      await endedByRunner(processes[1]);
    });

    it("when the resume needs a login, with the login text of the adapter", async () => {
      const { runner } = await world({ script: { resume: () => Promise.reject(RequestError.authRequired()) } });
      const live = await runner.start(START);
      await logUntil(live, "turn-end");
      await runner.stop(live);

      await runner.message(live, NEXT);

      expect((await logUntil(live, "failed")).at(-1)).toEqual({ kind: "failed", reason: "Log in to the agent first" });
    });

    it("when the folder of the chat is gone, and spawns nothing", async () => {
      const setup = await world();
      const gone = join(await target(), "moved");
      const live = await chatWithNoRun(setup, gone);

      await setup.runner.message(live, NEXT);

      expect((await logUntil(live, "failed")).slice(-2)).toEqual([
        { kind: "user", ...NEXT },
        { kind: "failed", reason: `The folder of this chat no longer exists: ${gone}. Start a new chat for this step.` },
      ]);
      expect(setup.processes).toEqual([]);
      expect(setup.runner.running(live)).toBeUndefined();
    });

    it("when no adapter runs its agent", async () => {
      const setup = await world();
      const live = await chatWithNoRun(setup, setup.folder, "codex");

      await setup.runner.message(live, NEXT);

      expect((await logUntil(live, "failed")).at(-1)).toEqual({ kind: "failed", reason: "Tasma cannot run codex yet" });
      expect(setup.processes).toEqual([]);
    });

    it("when the launch fails", async () => {
      const setup = await world({ adapter: fakeAdapter({ failed: "No agent here" }).adapter });
      const live = await chatWithNoRun(setup);

      await setup.runner.message(live, NEXT);

      expect((await logUntil(live, "failed")).at(-1)).toEqual({ kind: "failed", reason: "No agent here" });
      expect(setup.processes).toEqual([]);
    });
  });
});

describe("createChatRunner.stop", () => {
  it("refuses in a turn, and while a request of the agent's own work is open", async () => {
    const { script, finish } = heldTurns();
    const { runner, processes } = await world({ script });
    const live = await runner.start(START);
    await until(() => processes[0]?.prompts.length === 1, "the turn started");

    await expect(runner.stop(live)).rejects.toMatchObject({ code: "turn-running" });
    finish();
    await logUntil(live, "turn-end");
    void processes[0]?.permission().catch(() => undefined);
    await logUntil(live, "permission");

    await expect(runner.stop(live)).rejects.toMatchObject({
      code: "turn-running",
      message: "chat 1 of ALPHA-1 has a request open",
    });
    expect(processes[0]?.endCalls).toBe(0);
  });

  it("ends the process with no event, and resolves after its end", async () => {
    const { runner, processes } = await world({ started: slowEnd(50) });
    const live = await runner.start(START);
    const log = await logUntil(live, "turn-end");
    let ended = false;
    void processes[0]?.ended.then(() => (ended = true));

    await runner.stop(live);

    expect(ended).toBe(true);
    expect(runner.running(live)).toBeUndefined();
    expect(await logOf(live)).toEqual(log);
    expect(live.chat.state).toBe("needs-you");
  });

  it("resolves after the end of an idle stop of the same chat that is still in progress", async () => {
    const { runner, processes } = await world({ idleLimit: SHORT_IDLE, started: slowEnd(100) });
    const live = await runner.start(START);
    await logUntil(live, "turn-end");
    await endedByRunner(processes[0]);
    let ended = false;
    void processes[0]?.ended.then(() => (ended = true));

    await runner.stop(live);

    expect(ended).toBe(true);
  });
});
