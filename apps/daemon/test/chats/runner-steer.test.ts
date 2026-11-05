// The runner tests of a message that comes while a turn runs: a steer of the
// turn, or a text that waits for the next prompt of the same turn.

import { describe, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { ChatEvent } from "@tasma/protocol";
import type { LiveChat } from "../../src/chats/registry.js";
import type { ChatRunner } from "../../src/chats/runner.js";
import { logOf, logUntil, until } from "../helpers.js";
import { forever, PERMISSION, SESSION, text } from "../agents/fake-agent.js";
import type { FakeProcess, Script } from "../agents/fake-agent.js";
import {
  endedByRunner,
  gate,
  heldTurns,
  NEXT,
  PICK,
  promptText,
  requestOf,
  slowEnd,
  START,
  USER,
  world,
} from "./runner-world.js";

const LATER = { text: "And the tests", client: "app" } as const;

const AGAIN = { text: "And the docs", client: "web" } as const;

const TURN_END: ChatEvent = { kind: "turn-end", stopReason: "end_turn" };

const INJECTED = { outcome: "injected" } as const;

const PROMPT_REQUIRED = { outcome: "promptRequired", reason: "noRunningTurn" } as const;

const STOPPING = { status: "rejected", reason: { code: "chat-not-running" } } as const;

function userOf(message: { text: string; client: string }): ChatEvent {
  return { kind: "user", ...message };
}

/** The text of each prompt that the agent got, in order. */
function promptsOf(fake: FakeProcess | undefined): string[] {
  return (fake?.prompts ?? []).map(promptText);
}

/** The text of each steering request that the agent got, in order. */
function steersOf(fake: FakeProcess | undefined): string[] {
  return (fake?.steers ?? []).map(promptText);
}

/** Calls `stopStarts()` as the write of the `user` event of the message starts. */
function stopAtWrite(runner: ChatRunner, live: LiveChat, message: { text: string }): void {
  const append = live.append.bind(live);
  vi.spyOn(live, "append").mockImplementation((event) => {
    if (event.kind === "user" && event.text === message.text) runner.stopStarts();
    return append(event);
  });
}

/** A script whose prompts stay open until `finish` ends the oldest one. A cancel ends none of them. */
function turnsThatIgnoreCancel(): { script: Script; finish: (stopReason?: PromptResponse["stopReason"]) => void } {
  const turns: ((result: PromptResponse) => void)[] = [];
  return {
    script: { prompt: () => new Promise((resolve) => turns.push(resolve)) },
    finish: (stopReason = "end_turn") => turns.shift()?.({ stopReason }),
  };
}

describe("createChatRunner.message", () => {
  it("takes two messages sent in one synchronous step: the first starts a turn, and the second steers it", async () => {
    const { runner, processes } = await world();
    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    await Promise.all([runner.message(live, NEXT), runner.message(live, LATER)]);

    await logUntil(live, "turn-end");
    expect(promptsOf(processes[0])).toEqual([START.text, NEXT.text]);
    expect(steersOf(processes[0])).toEqual([LATER.text]);
    expect((await logOf(live)).slice(2)).toEqual([userOf(NEXT), userOf(LATER), TURN_END]);
  });

  describe("during a turn whose prompt is sent", () => {
    it("steers the first turn and a later turn with its text, sends no other prompt, and ends each turn once", async () => {
      const { script, finish } = heldTurns();
      const { runner, processes } = await world({ script });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the first turn started");

      await runner.message(live, NEXT);
      expect(await logOf(live)).toEqual([USER, userOf(NEXT)]);
      await until(() => processes[0]?.steers.length === 1, "the agent got the first steer");
      finish();
      const first = await logUntil(live, "turn-end");
      await runner.message(live, LATER);
      await until(() => processes[0]?.prompts.length === 2, "the later turn started");
      await runner.message(live, AGAIN);
      await until(() => processes[0]?.steers.length === 2, "the agent got the second steer");
      finish();

      expect(first).toEqual([USER, userOf(NEXT), TURN_END]);
      expect((await logUntil(live, "turn-end")).slice(first.length)).toEqual([userOf(LATER), userOf(AGAIN), TURN_END]);
      expect(promptsOf(processes[0])).toEqual([START.text, LATER.text]);
      expect(processes[0]?.steers).toEqual([NEXT, AGAIN].map((message) => ({
        sessionId: SESSION,
        prompt: [{ type: "text", text: message.text }],
        _meta: { steering: { idleBehavior: "promptRequired" } },
      })));
    });

    it("resolves when its user event is in the log, before the steering answer", async () => {
      const answer = gate();
      const { script, finish } = heldTurns();
      const { runner, processes } = await world({
        script: { ...script, steer: () => answer.opened.then(() => INJECTED) },
      });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");

      await runner.message(live, NEXT);
      await until(() => processes[0]?.steers.length === 1, "the agent got the steer");

      expect(await logOf(live)).toEqual([USER, userOf(NEXT)]);
      answer.open();
      finish();
      expect(await logUntil(live, "turn-end")).toEqual([USER, userOf(NEXT), TURN_END]);
      expect(processes[0]?.prompts).toHaveLength(1);
    });

    it("steers the turn while a permission request waits, and keeps the request open", async () => {
      const { runner, processes } = await world({
        script: {
          async prompt(_params, agent) {
            void agent.permission().catch(() => undefined);
            return forever();
          },
        },
      });
      const live = await runner.start(START);
      const request = requestOf(await logUntil(live, "permission"));

      await runner.message(live, NEXT);
      await until(() => processes[0]?.steers.length === 1, "the agent got the steer");

      expect(steersOf(processes[0])).toEqual([NEXT.text]);
      expect(await logOf(live)).toEqual([USER, { kind: "permission", request, permission: PERMISSION }, userOf(NEXT)]);
      expect(live.fold.open).toEqual([request]);
      await runner.answerPermission(live, request, { optionId: "allow", client: "web" });
    });

    it.each([
      ["answers promptRequired", () => Promise.resolve(PROMPT_REQUIRED)],
      ["refuses the steer", () => Promise.reject(RequestError.internalError(undefined, "the session ended"))],
    ] as const)("sends the text as the next prompt of the same turn when the agent %s", async (_case, steer) => {
      const { script, finish } = heldTurns();
      const { runner, processes } = await world({ script: { ...script, steer } });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");
      await runner.message(live, NEXT);
      await until(() => processes[0]?.steers.length === 1, "the agent got the steer");

      finish();
      await until(() => processes[0]?.prompts.length === 2, "the agent got the next prompt");
      expect(await logOf(live)).toEqual([USER, userOf(NEXT)]);
      finish();

      expect(await logUntil(live, "turn-end")).toEqual([USER, userOf(NEXT), TURN_END]);
      expect(promptsOf(processes[0])).toEqual([START.text, NEXT.text]);
    });

    it.each([
      ["refuses the steer", () => Promise.reject(RequestError.internalError({ details: "the session ended" })), "the session ended"],
      ["answers with an unknown outcome", () => Promise.resolve({ outcome: "queued" }), "the agent answered a steer with the outcome queued"],
    ] as const)("reports a fault of the agent on stderr when the agent %s", async (_case, steer, reason) => {
      const { script, finish } = heldTurns();
      const { runner, processes, errors } = await world({ script: { ...script, steer } });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");
      await runner.message(live, NEXT);
      await until(() => processes[0]?.steers.length === 1, "the agent got the steer");

      finish();
      await until(() => processes[0]?.prompts.length === 2, "the agent got the next prompt");
      finish();
      await logUntil(live, "turn-end");

      expect(errors).toEqual([`tasma-daemon: chat 1 of ALPHA-1: the steer of a message failed: ${reason}\n`]);
    });

    it("reports no fault on stderr for a steer that the end of the process closes", async () => {
      const { runner, processes, errors } = await world({ script: { prompt: forever, steer: forever } });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");
      await runner.message(live, NEXT);
      await until(() => processes[0]?.steers.length === 1, "the agent got the steer");

      processes[0]?.exit({ code: 1, signal: null });
      await logUntil(live, "failed");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(errors).toEqual([]);
    });

    it("sends the next prompt when the prompt result comes before the promptRequired answer", async () => {
      const { script, finish } = heldTurns();
      const { runner, processes } = await world({
        script: {
          ...script,
          async steer() {
            finish();
            await new Promise((resolve) => setTimeout(resolve, 20));
            return PROMPT_REQUIRED;
          },
        },
      });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");

      await runner.message(live, NEXT);
      await until(() => processes[0]?.prompts.length === 2, "the agent got the next prompt");
      finish();

      expect(await logUntil(live, "turn-end")).toEqual([USER, userOf(NEXT), TURN_END]);
      expect(promptsOf(processes[0])).toEqual([START.text, NEXT.text]);
    });

    it("waits for a steering answer at the end of a prompt, and sends no next prompt for an injected text", async () => {
      const answer = gate();
      const { script, finish } = heldTurns();
      const { runner, processes } = await world({
        script: { ...script, steer: () => answer.opened.then(() => INJECTED) },
      });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");
      await runner.message(live, NEXT);
      await until(() => processes[0]?.steers.length === 1, "the agent got the steer");

      finish();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await logOf(live)).toEqual([USER, userOf(NEXT)]);
      answer.open();

      expect(await logUntil(live, "turn-end")).toEqual([USER, userOf(NEXT), TURN_END]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(processes[0]?.prompts).toHaveLength(1);
    });

    it("waits again for the steer of a message that comes during the wait for a steering answer", async () => {
      const first = gate();
      const second = gate();
      const { script, finish } = heldTurns();
      const { runner, processes } = await world({
        script: {
          ...script,
          steer: (_params, fake) => (fake.steers.length === 1 ? first : second).opened.then(() => INJECTED),
        },
      });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");
      await runner.message(live, NEXT);
      await until(() => processes[0]?.steers.length === 1, "the agent got the first steer");
      finish();
      await new Promise((resolve) => setTimeout(resolve, 20));

      await runner.message(live, LATER);
      await until(() => processes[0]?.steers.length === 2, "the agent got the second steer");
      first.open();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await logOf(live)).toEqual([USER, userOf(NEXT), userOf(LATER)]);
      second.open();

      expect(await logUntil(live, "turn-end")).toEqual([USER, userOf(NEXT), userOf(LATER), TURN_END]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(processes[0]?.prompts).toHaveLength(1);
    });

    it("sends no steer after a Stop, and sends the text as the next prompt with no cancelled turn end", async () => {
      const { script, finish } = turnsThatIgnoreCancel();
      const { runner, processes } = await world({ script });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");

      await runner.cancel(live, { client: "web" });
      await runner.message(live, NEXT);
      finish("cancelled");
      await until(() => processes[0]?.prompts.length === 2, "the agent got the next prompt");
      finish();

      expect(await logUntil(live, "turn-end")).toEqual([USER, userOf(NEXT), TURN_END]);
      expect(processes[0]?.cancels).toEqual([{ sessionId: SESSION }]);
      expect(processes[0]?.steers).toEqual([]);
      expect(promptsOf(processes[0])).toEqual([START.text, NEXT.text]);
    });

    it("drops a text that waits at a Stop, and ends the turn once with no next prompt", async () => {
      const { script } = heldTurns();
      const { runner, processes } = await world({ script: { ...script, steer: async () => PROMPT_REQUIRED } });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");
      await runner.message(live, NEXT);
      await until(() => processes[0]?.steers.length === 1, "the agent got the steer");

      await runner.cancel(live, { client: "web" });

      expect(await logUntil(live, "turn-end")).toEqual([USER, userOf(NEXT), { kind: "turn-end", stopReason: "cancelled" }]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(processes[0]?.prompts).toHaveLength(1);
    });

    it("steers once for each of two messages at the same moment, and ends the turn once", async () => {
      const { script, finish } = heldTurns();
      const { runner, processes } = await world({ script });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");

      await Promise.all([runner.message(live, NEXT), runner.message(live, LATER)]);
      await until(() => processes[0]?.steers.length === 2, "the agent got both steers");
      finish();

      expect(await logUntil(live, "turn-end")).toEqual([USER, userOf(NEXT), userOf(LATER), TURN_END]);
      expect(steersOf(processes[0])).toEqual([NEXT.text, LATER.text]);
      expect(processes[0]?.prompts).toHaveLength(1);
    });

    it("keeps each text that waits in its place when another text with the same words is injected", async () => {
      let steers = 0;
      const { script, finish } = heldTurns();
      const { runner, processes } = await world({
        script: { ...script, steer: async () => ((steers += 1) === 3 ? INJECTED : PROMPT_REQUIRED) },
      });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");

      await runner.message(live, NEXT);
      await runner.message(live, LATER);
      await runner.message(live, NEXT);
      await until(() => processes[0]?.steers.length === 3, "the agent got every steer");
      finish();
      await until(() => processes[0]?.prompts.length === 2, "the agent got the next prompt");
      finish();

      await logUntil(live, "turn-end");
      expect(promptsOf(processes[0])).toEqual([START.text, `${NEXT.text}\n\n${LATER.text}`]);
    });

    it("sends no cancel and no next prompt at a Stop while it waits for a steering answer, and ends the turn once", async () => {
      const answer = gate();
      const { script, finish } = heldTurns();
      const { runner, processes } = await world({
        script: { ...script, steer: () => answer.opened.then(() => PROMPT_REQUIRED) },
      });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");
      await runner.message(live, NEXT);
      await until(() => processes[0]?.steers.length === 1, "the agent got the steer");
      finish();
      await new Promise((resolve) => setTimeout(resolve, 20));

      await runner.cancel(live, { client: "web" });
      answer.open();

      expect(await logUntil(live, "turn-end")).toEqual([USER, userOf(NEXT), TURN_END]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(processes[0]?.cancels).toEqual([]);
      expect(processes[0]?.prompts).toHaveLength(1);
    });

    it("drops a text that waits at an end, which the cancelled prompt ends within its grace", async () => {
      const { script } = heldTurns();
      const { runner, processes } = await world({
        script: { ...script, steer: async () => PROMPT_REQUIRED },
        endGraceMs: 60_000,
      });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");
      await runner.message(live, NEXT);
      await until(() => processes[0]?.steers.length === 1, "the agent got the steer");

      await runner.end(live, { client: "web" });

      expect(await logOf(live)).toEqual([USER, userOf(NEXT), { kind: "turn-end", stopReason: "cancelled" }]);
      expect(processes[0]?.prompts).toHaveLength(1);
      expect(runner.running(live)).toBeUndefined();
    });

    it("sends no next prompt for a text that waits when the daemon stops, and leaves the turn and the text to the close", async () => {
      const answer = gate();
      const { script, finish } = heldTurns();
      const { runner, processes } = await world({
        script: {
          async prompt(params, agent) {
            await agent.update(text("Working"));
            return script.prompt!(params, agent);
          },
          steer: () => answer.opened.then(() => PROMPT_REQUIRED),
        },
      });
      const live = await runner.start(START);
      await logUntil(live, "update");
      await runner.message(live, NEXT);
      await until(() => processes[0]?.steers.length === 1, "the agent got the steer");
      finish();
      await new Promise((resolve) => setTimeout(resolve, 20));

      runner.stopStarts();
      answer.open();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await logOf(live)).at(-1)).toEqual(userOf(NEXT));
      await runner.close();

      expect((await logOf(live)).slice(-2)).toEqual([userOf(NEXT), { kind: "interrupted" }]);
      expect(processes[0]?.prompts).toHaveLength(1);
      expect(live.unanswered).toEqual([NEXT.text]);
    });

    it("sends a text that waits when the process ends with the next message, before its text", async () => {
      const { script } = heldTurns();
      const { runner, processes } = await world({ script: { ...script, steer: async () => PROMPT_REQUIRED } });
      const live = await runner.start(START);
      await until(() => processes[0]?.prompts.length === 1, "the turn started");
      await runner.message(live, NEXT);
      await until(() => processes[0]?.steers.length === 1, "the agent got the steer");

      processes[0]?.exit({ code: 1, signal: null });
      await logUntil(live, "failed");
      await runner.message(live, LATER);
      await until(() => processes[1]?.prompts.length === 1, "the restarted agent got its prompt");

      expect(promptsOf(processes[1])).toEqual([`${NEXT.text}\n\n${LATER.text}`]);
    });
  });

  describe("during the start of the agent", () => {
    it("joins the first prompt, with its user event after the events before it", async () => {
      const session = gate();
      const { runner, processes } = await world({
        script: { newSession: () => session.opened.then(() => ({ sessionId: SESSION })) },
      });
      const live = await runner.start(START);
      await until(() => processes[0]?.newSession !== undefined, "the session opens");

      await runner.message(live, NEXT);
      await runner.message(live, LATER);
      expect(await logOf(live)).toEqual([USER, userOf(NEXT), userOf(LATER)]);
      session.open();

      expect(await logUntil(live, "turn-end")).toEqual([USER, userOf(NEXT), userOf(LATER), TURN_END]);
      expect(promptsOf(processes[0])).toEqual([`${START.text}\n\n${NEXT.text}\n\n${LATER.text}`]);
      expect(processes[0]?.steers).toEqual([]);
    });

    it("sends the text of a message that joins during the wait for the write of an earlier message in the first prompt, once", async () => {
      const session = gate();
      const write = gate();
      const { runner, processes } = await world({
        script: { newSession: () => session.opened.then(() => ({ sessionId: SESSION })) },
      });
      const live = await runner.start(START);
      await until(() => processes[0]?.newSession !== undefined, "the session opens");
      const append = live.append.bind(live);
      vi.spyOn(live, "append").mockImplementation(async (event) => {
        if (event.kind === "user" && event.text === NEXT.text) await write.opened;
        return append(event);
      });

      const held = runner.message(live, NEXT);
      session.open();
      await until(() => runner.running(live)?.session !== undefined, "the session opened");
      const joined = runner.message(live, LATER);
      write.open();
      await Promise.all([held, joined]);

      expect(await logUntil(live, "turn-end")).toEqual([USER, userOf(NEXT), userOf(LATER), TURN_END]);
      expect(promptsOf(processes[0])).toEqual([`${START.text}\n\n${NEXT.text}\n\n${LATER.text}`]);
    });

    it("sends every text of the start with a message after a Stop, in a chat with no answer", async () => {
      const session = gate();
      const { runner, processes } = await world({
        script: { newSession: () => session.opened.then(() => ({ sessionId: SESSION })) },
      });
      const live = await runner.start(START);
      await until(() => processes[0]?.newSession !== undefined, "the session opens");

      await runner.cancel(live, { client: "web" });
      await runner.message(live, NEXT);
      session.open();

      expect(await logUntil(live, "turn-end")).toEqual([USER, userOf(NEXT), TURN_END]);
      expect(promptsOf(processes[0])).toEqual([`${START.text}\n\n${NEXT.text}`]);
    });

    it("sends only the texts after a Stop, in a chat with an answer", async () => {
      const resume = gate();
      const { runner, processes } = await world({ script: { resume: () => resume.opened.then(() => ({})) } });
      const live = await runner.start(START);
      await logUntil(live, "turn-end");
      await runner.stop(live);
      await runner.message(live, NEXT);
      await until(() => processes[1]?.resumes.length === 1, "the restart resumes the session");

      await runner.message(live, LATER);
      await runner.cancel(live, { client: "web" });
      await runner.message(live, AGAIN);
      resume.open();

      expect((await logUntil(live, "turn-end")).slice(2)).toEqual([userOf(NEXT), userOf(LATER), userOf(AGAIN), TURN_END]);
      expect(promptsOf(processes[1])).toEqual([AGAIN.text]);
    });

    it("drops the texts of the last run at a Stop while the restart waits for the last process, in a chat with an answer", async () => {
      let resumes = 0;
      const { runner, processes } = await world({
        script: {
          async resume() {
            resumes += 1;
            if (resumes === 1) throw RequestError.authRequired();
            return {};
          },
        },
        started: slowEnd(100),
      });
      const live = await runner.start(START);
      await logUntil(live, "turn-end");
      await runner.stop(live);
      await runner.message(live, NEXT);
      await logUntil(live, "failed");
      await endedByRunner(processes[1]);

      const sent = runner.message(live, LATER);
      await runner.cancel(live, { client: "web" });
      await runner.message(live, AGAIN);
      await sent;

      expect((await logUntil(live, "turn-end")).slice(-3)).toEqual([userOf(LATER), userOf(AGAIN), TURN_END]);
      expect(promptsOf(processes[2])).toEqual([AGAIN.text]);
    });

    it("interrupts the turn at an end and sends no prompt", async () => {
      const { runner, processes } = await world({ script: { newSession: forever }, endGraceMs: 60_000 });
      const live = await runner.start(START);
      await until(() => processes[0]?.newSession !== undefined, "the session opens");
      await runner.message(live, NEXT);

      await runner.end(live, { client: "web" });

      expect(await logOf(live)).toEqual([USER, userOf(NEXT), { kind: "interrupted" }]);
      expect(processes[0]?.prompts).toEqual([]);
    });

    it("leaves the start to the close, and refuses each later message and a waiting pick, when the daemon stop comes during the write of an earlier message", async () => {
      const { runner, processes } = await world({ script: { newSession: forever } });
      const live = await runner.start(START);
      await until(() => processes[0]?.newSession !== undefined, "the session opens");
      const picked = runner.setOption(live, PICK);
      stopAtWrite(runner, live, LATER);

      const messages = [NEXT, LATER, AGAIN, AGAIN];
      const sent = await Promise.allSettled(messages.map((message) => runner.message(live, message)));

      expect(sent).toMatchObject([{ status: "fulfilled" }, { status: "fulfilled" }, STOPPING, STOPPING]);
      await expect(picked).rejects.toMatchObject(STOPPING.reason);
      await runner.close();
      expect(await logOf(live)).toEqual([USER, userOf(NEXT), userOf(LATER), { kind: "interrupted" }]);
    });

    it("leaves a restart to the close when the daemon stop comes during the write of an earlier message", async () => {
      const { runner } = await world();
      const live = await runner.start(START);
      await logUntil(live, "turn-end");
      await runner.stop(live);
      stopAtWrite(runner, live, LATER);

      const sent = await Promise.allSettled([NEXT, LATER, AGAIN].map((message) => runner.message(live, message)));
      await runner.close();

      expect(sent).toMatchObject([{ status: "fulfilled" }, { status: "fulfilled" }, STOPPING]);
      expect((await logOf(live)).slice(2)).toEqual([userOf(NEXT), userOf(LATER), { kind: "interrupted" }]);
    });
  });
});
