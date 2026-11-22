import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { AgentAdapter } from "../../src/agents/adapter.js";
import { logOf, logUntil, until } from "../helpers.js";
import { forever, SESSION } from "../agents/fake-agent.js";
import type { FakeProcess, Script } from "../agents/fake-agent.js";
import { endedByRunner, fakeAdapter, gate, slowEnd, START, world } from "./runner-world.js";
import type { WorldOptions } from "./runner-world.js";

const CODEX_START = { ...START, agent: "codex" } as const;

/** An adapter whose agent gets `session/close` before each end of its process. */
function closing(): AgentAdapter {
  return { ...fakeAdapter().adapter, agent: "codex", closeBeforeEnd: true };
}

function fault(text: string): string {
  return `tasma-daemon: chat 1 of ALPHA-1: ${text}\n`;
}

/** Records in `seen` each `session/close` that reaches the agent, and the first end of each process. */
function ordered(extra: Script = {}) {
  const seen: string[] = [];
  const script: Script = {
    ...extra,
    async close(params, fake) {
      seen.push("close");
      return extra.close?.(params, fake) ?? {};
    },
  };
  const started = (fake: FakeProcess) => {
    const end = fake.end.bind(fake);
    fake.end = () => {
      if (fake.endCalls === 0) seen.push("end");
      return end();
    };
  };
  return { seen, script, started };
}

/** A chat of the closing adapter whose first turn has ended. */
async function opened(extra: Script = {}, options: WorldOptions = {}) {
  const { seen, script, started } = ordered(extra);
  const setup = await world({ adapter: closing(), script, started, ...options });
  const live = await setup.runner.start(CODEX_START);
  await logUntil(live, "turn-end");
  return { ...setup, live, seen };
}

describe("the close of the session of an agent that asks for it", () => {
  it("reaches the agent at the idle stop before its process ends", async () => {
    const { seen, script, started } = ordered();
    const { runner, processes } = await world({ adapter: closing(), script, started, idleLimit: async () => 50 });
    const live = await runner.start(CODEX_START);
    await logUntil(live, "turn-end");

    await until(() => runner.running(live) === undefined, "the idle stop");
    await endedByRunner(processes[0]);

    expect(processes[0]?.closes).toEqual([{ sessionId: SESSION }]);
    expect(seen).toEqual(["close", "end"]);
  });

  it("reaches the agent at the end for a restart before its process ends", async () => {
    const { runner, live, processes, seen } = await opened();

    await runner.end(live, { client: "app" });

    expect(processes[0]?.closes).toEqual([{ sessionId: SESSION }]);
    expect(seen).toEqual(["close", "end"]);
  });

  it("reaches the agent of a failed run before its process ends", async () => {
    const { seen, script, started } = ordered({ prompt: () => Promise.reject(new Error("the model is gone")) });
    const { runner, processes } = await world({ adapter: closing(), script, started });
    const live = await runner.start(CODEX_START);

    expect((await logUntil(live, "failed")).at(-1)).toEqual({ kind: "failed", reason: "the model is gone" });
    await endedByRunner(processes[0]);

    expect(seen).toEqual(["close", "end"]);
  });

  it("reaches the agent at the daemon stop, which interrupts the turn, before its process ends", async () => {
    let finish: (result: PromptResponse) => void = () => {};
    const { seen, script, started } = ordered({
      prompt: () => new Promise((resolve) => (finish = resolve)),
      async close() {
        finish({ stopReason: "cancelled" });
        return {};
      },
    });
    const { runner, processes } = await world({ adapter: closing(), script, started });
    const live = await runner.start(CODEX_START);
    await until(() => processes[0]?.prompts.length === 1, "the turn runs");

    await runner.close();

    expect(seen).toEqual(["close", "end"]);
    expect((await logOf(live)).at(-1)).toEqual({ kind: "interrupted" });
  });

  it("holds no other process at the daemon stop while it waits for the answer", async () => {
    const held = gate();
    const { runner, processes } = await world({
      adapters: [fakeAdapter().adapter, closing()],
      script: {
        async close() {
          await held.opened;
          return {};
        },
      },
    });
    await logUntil(await runner.start(START), "turn-end");
    await logUntil(await runner.start(CODEX_START), "turn-end");

    const closed = runner.close();
    await until(() => processes[1]?.closes.length === 1, "the close reaches the agent of codex");
    await until(() => (processes[0]?.endCalls ?? 0) > 0, "the agent of claude ends");

    expect(processes[1]?.endCalls).toBe(0);

    held.open();
    await closed;

    expect(processes[1]?.endCalls).toBeGreaterThan(0);
    expect(processes[0]?.closes).toEqual([]);
  });

  it("ends the process at the daemon stop after a close that an idle stop started, and sends no second close", async () => {
    const held = gate();
    const { seen, script, started } = ordered({
      async close() {
        await held.opened;
        return {};
      },
    });
    const { runner, processes } = await world({ adapter: closing(), script, started, idleLimit: async () => 50 });
    const live = await runner.start(CODEX_START);
    await logUntil(live, "turn-end");
    await until(() => processes[0]?.closes.length === 1, "the idle stop closes the session");

    const closed = runner.close();
    await sleep(50);

    expect(processes[0]?.endCalls).toBe(0);

    held.open();
    await closed;

    expect(seen).toEqual(["close", "end"]);
    expect(processes[0]?.closes).toHaveLength(1);
  });

  it("writes one line on stderr when the agent refuses the close, and ends the process", async () => {
    const { runner, live, processes, errors } = await opened({
      close: () => Promise.reject(new Error("a background terminal did not stop")),
    });

    await runner.stop(live);

    expect(errors).toEqual([fault("the session did not close: a background terminal did not stop")]);
    expect(processes[0]?.endCalls).toBeGreaterThan(0);
  });

  it("ends the process after the limit when the agent does not answer the close, with one line on stderr", async () => {
    const { runner, live, processes, errors } = await opened({ close: () => forever() }, { closeLimitMs: 200 });

    const stopped = runner.stop(live);
    await until(() => processes[0]?.closes.length === 1, "the close reaches the agent");

    expect(processes[0]?.endCalls).toBe(0);

    await stopped;

    expect(processes[0]?.endCalls).toBeGreaterThan(0);
    expect(errors).toEqual([fault("the session did not close in 200 ms")]);
  });

  it("writes no second line for a close that the agent refuses after the limit", async () => {
    let ending = false;
    const { runner, live, errors } = await opened(
      {
        async close() {
          await until(() => ending, "the end of the process starts");
          throw new Error("a background terminal did not stop");
        },
      },
      { closeLimitMs: 50, started: slowEnd(200, () => (ending = true)) },
    );

    await runner.stop(live);

    expect(errors).toEqual([fault("the session did not close in 50 ms")]);
  });

  it("writes no line about the close when the process exits by itself", async () => {
    const { live, processes, errors } = await opened({}, { closeLimitMs: 10 });

    processes[0]?.exit({ code: 1, signal: null });

    expect((await logUntil(live, "failed")).at(-1)).toEqual({ kind: "failed", reason: "The agent process ended with exit code 1" });
    await sleep(50);
    expect(errors).toEqual([]);
    expect(processes[0]?.closes).toEqual([]);
  });

  it("is sent one time when a fault of the log halts a run that fails", async () => {
    const turn = gate();
    const { seen, script, started } = ordered({
      async prompt() {
        await turn.opened;
        throw new Error("the model is gone");
      },
    });
    const { runner, processes, errors } = await world({ adapter: closing(), script, started });
    const live = await runner.start(CODEX_START);
    const append = live.append.bind(live);
    vi.spyOn(live, "append").mockImplementation(async (event) => {
      if (event.kind === "failed") throw new Error("the disk is gone");
      return append(event);
    });

    turn.open();
    await until(() => errors.length > 0, "the fault of the log is reported");
    await endedByRunner(processes[0]);

    expect(errors).toEqual([fault("the disk is gone")]);
    expect(seen).toEqual(["close", "end"]);
  });

  it("reaches the agent at a daemon stop during the write of the failure of the run, one time", async () => {
    const turn = gate();
    const written = gate();
    const { seen, script, started } = ordered({
      async prompt() {
        await turn.opened;
        throw new Error("the model is gone");
      },
    });
    const { runner, processes } = await world({ adapter: closing(), script, started });
    const live = await runner.start(CODEX_START);
    const append = live.append.bind(live);
    let failing = false;
    vi.spyOn(live, "append").mockImplementation(async (event) => {
      if (event.kind === "failed") {
        failing = true;
        await written.opened;
      }
      return append(event);
    });

    turn.open();
    await until(() => failing, "the write of the failure starts");
    await runner.close();

    expect(seen).toEqual(["close", "end"]);

    written.open();
    await logUntil(live, "failed");
    await sleep(50);

    expect(processes[0]?.closes).toHaveLength(1);
  });

  it("is not sent for a run whose session did not open", async () => {
    const { seen, script, started } = ordered({ newSession: () => Promise.reject(new Error("the folder is not trusted")) });
    const { runner, processes } = await world({ adapter: closing(), script, started });
    const live = await runner.start(CODEX_START);

    await logUntil(live, "failed");
    await endedByRunner(processes[0]);

    expect(seen).toEqual(["end"]);
  });
});

describe("the end of an agent that does not ask for the close of its session", () => {
  it("sends no session/close", async () => {
    const { seen, script, started } = ordered();
    const { runner } = await world({ script, started });
    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    await runner.stop(live);

    expect(seen).toEqual(["end"]);
  });
});
