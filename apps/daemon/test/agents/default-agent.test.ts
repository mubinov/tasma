import { describe, expect, it } from "vitest";
import type { ChatAgent } from "@tasma/protocol";
import { effectiveAgent } from "../../src/agents/default-agent.js";

/** A resolver whose `stored` and `ready` answer as given and record each call. */
function resolver(stored: string | undefined, readyAgents: readonly ChatAgent[], offered: readonly ChatAgent[]) {
  const calls: string[] = [];
  const resolve = () => effectiveAgent({
    offered,
    stored: () => {
      calls.push("stored");
      return Promise.resolve(stored);
    },
    ready: (agent) => {
      calls.push(`ready ${agent}`);
      return Promise.resolve(readyAgents.includes(agent));
    },
  });
  return { calls, resolve };
}

const BOTH: readonly ChatAgent[] = ["claude", "codex"];

describe("effectiveAgent", () => {
  it("gives Claude when only Claude is offered, and reads no stored value and runs no check", async () => {
    const { calls, resolve } = resolver("codex", [], ["claude"]);

    await expect(resolve()).resolves.toBe("claude");
    expect(calls).toEqual([]);
  });

  it.each<ChatAgent>(["codex", "claude"])(
    "gives the stored %s when the daemon offers it, and runs no check",
    async (stored) => {
      const { calls, resolve } = resolver(stored, [], BOTH);

      await expect(resolve()).resolves.toBe(stored);
      expect(calls).toEqual(["stored"]);
    },
  );

  it("gives a ready Claude with no stored value, and runs no check of another agent", async () => {
    const { calls, resolve } = resolver(undefined, BOTH, BOTH);

    await expect(resolve()).resolves.toBe("claude");
    expect(calls).toEqual(["stored", "ready claude"]);
  });

  it("passes over a stored agent that the daemon does not offer", async () => {
    const { resolve } = resolver("gemini", ["codex"], BOTH);

    await expect(resolve()).resolves.toBe("codex");
  });

  it("gives the only ready agent when Claude is not ready", async () => {
    const { calls, resolve } = resolver(undefined, ["codex"], BOTH);

    await expect(resolve()).resolves.toBe("codex");
    expect(calls).toEqual(["stored", "ready claude", "ready codex"]);
  });

  it("gives Claude when no agent is ready", async () => {
    const { resolve } = resolver(undefined, [], BOTH);

    await expect(resolve()).resolves.toBe("claude");
  });

  it("rejects when the read of the stored value rejects", async () => {
    const fault = new Error("the file cannot be read");

    const result = effectiveAgent({
      offered: BOTH,
      stored: () => Promise.reject(fault),
      ready: () => Promise.resolve(true),
    });

    await expect(result).rejects.toBe(fault);
  });
});
