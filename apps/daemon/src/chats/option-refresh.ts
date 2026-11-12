// The refresh of the stored options of an agent: the agent opens a session
// with no message in an empty folder, and the options of that session replace
// the stored list. Only a read of an old list starts one.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentOptionsEntry } from "@tasma/engine";
import { DAEMON_NAME, printable } from "@tasma/protocol";
import type { AcpObject, ChatAgent } from "@tasma/protocol";
import { AgentClosed, connectAgent, errorReason } from "../agents/acp.js";
import type { AgentProcess } from "../agents/acp.js";
import type { AgentAdapter, AgentLaunch } from "../agents/adapter.js";
import { safeWorkParent } from "../agents/process.js";
import { causeOf } from "../http/failure.js";
import { CANCELLED } from "./registry.js";

const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const LIMIT_MS = 60_000;

const PAUSE_MS = 10 * 60_000;

/** `logged`: a failure whose line `keep` wrote. `stopped`: the stop of the daemon ended it, which is no failure. */
type Outcome = "kept" | "logged" | "stopped" | { failed: string };

export type OptionRefresh = {
  /** Starts a refresh when the list is old, unless one runs, a pause holds, or the daemon stops. Never throws. */
  ask(agent: ChatAgent, entry: AgentOptionsEntry | undefined): void;
  /** Resolves when no refresh runs: each agent has ended and each folder is removed. */
  settled(): Promise<void>;
};

/** A time in the future counts too, so a clock set back does not hold the list until that time. */
function isOld(entry: AgentOptionsEntry | undefined): boolean {
  if (entry === undefined || entry.options.length === 0) return true;
  const updated = Date.parse(entry.updated);
  return Number.isNaN(updated) || Math.abs(Date.now() - updated) >= MAX_AGE_MS;
}

function reasonOf(adapter: AgentAdapter, error: unknown): string {
  return error instanceof AgentClosed ? "the agent ended before it opened a session" : errorReason(adapter, error);
}

export function createOptionRefresh(options: {
  adapters: readonly AgentAdapter[];
  launch: (adapter: AgentAdapter) => Promise<AgentLaunch | { failed: string }>;
  spawn: (launch: AgentLaunch, folder: string) => AgentProcess;
  keep: (agent: ChatAgent, options: SessionConfigOption[]) => Promise<boolean>;
  /** An abort ends the agent of a refresh, and no refresh starts after it. */
  signal: AbortSignal;
  stderr: { write(text: string): unknown };
  /** The folder that holds the work folder of each refresh. */
  workParent: string;
  limitMs?: number;
}): OptionRefresh {
  const { adapters, launch, spawn, keep, signal, stderr, workParent } = options;
  const limitMs = options.limitMs ?? LIMIT_MS;
  const running = new Map<ChatAgent, Promise<void>>();
  /** The `performance.now()` of the last failure of each agent. */
  const failures = new Map<ChatAgent, number>();

  /** The session with no message, from the spawn to the write of its options. */
  async function open(adapter: AgentAdapter, start: AgentLaunch, folder: string, meta: AcpObject): Promise<Outcome> {
    const agentProcess = spawn(start, folder);
    const connection = connectAgent(agentProcess.stream, {
      update: () => undefined,
      permission(_params, answer) {
        answer({ outcome: CANCELLED.permission });
        return () => undefined;
      },
      question(_params, answer) {
        answer(CANCELLED.question);
        return () => undefined;
      },
    });
    void connection.closed.then(() => agentProcess.end());
    let late = false;
    const end = () => void agentProcess.end();
    const timer = setTimeout(() => {
      late = true;
      end();
    }, limitMs);
    signal.addEventListener("abort", end, { once: true });
    try {
      await connection.initialize();
      const { configOptions } = await connection.create(folder, meta);
      clearTimeout(timer);
      if (configOptions.length === 0) return { failed: "the agent opened a session with no options" };
      return (await keep(adapter.agent, configOptions)) ? "kept" : "logged";
    } catch (error) {
      return { failed: late ? `the agent did not open a session in ${limitMs / 1000} seconds` : reasonOf(adapter, error) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", end);
      await agentProcess.end();
    }
  }

  async function attempt(adapter: AgentAdapter, meta: AcpObject): Promise<Outcome> {
    const start = await launch(adapter);
    if ("failed" in start) return start;
    const parent = await safeWorkParent(workParent);
    if (parent === undefined) {
      return {
        failed: `${workParent} is not a safe folder: it cannot be made, or another account can write to it or to a folder above it`,
      };
    }
    if (signal.aborted) return "stopped";
    // One name for each agent: the CLI can keep an entry for each folder it ran in.
    const folder = join(parent, `tasma-options-${adapter.agent}`);
    try {
      await rm(folder, { recursive: true, force: true });
      // Not recursive: a name that another process takes in the meantime fails the refresh.
      await mkdir(folder, { mode: 0o700 });
      if (signal.aborted) return "stopped";
      return await open(adapter, start, folder, meta);
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function refresh(adapter: AgentAdapter, meta: AcpObject): Promise<void> {
    const { agent } = adapter;
    const outcome = await attempt(adapter, meta).catch((error: unknown) => ({ failed: causeOf(error) }));
    // A launch that the stop ends fails, for example at the read of the login shell.
    if (outcome === "stopped" || signal.aborted) return;
    if (outcome === "kept") {
      failures.delete(agent);
      return;
    }
    failures.set(agent, performance.now());
    if (outcome === "logged") return;
    stderr.write(`${DAEMON_NAME}: ${printable(`the options of ${agent} are not refreshed: ${outcome.failed}`)}\n`);
  }

  return {
    ask(agent, entry) {
      if (signal.aborted || running.has(agent)) return;
      const adapter = adapters.find((one) => one.agent === agent);
      const meta = adapter?.optionsSessionMeta;
      if (adapter === undefined || meta === undefined) return;
      const failed = failures.get(agent);
      if (failed !== undefined && performance.now() - failed < PAUSE_MS) return;
      if (!isOld(entry)) return;
      running.set(agent, refresh(adapter, meta).finally(() => running.delete(agent)));
    },

    async settled() {
      while (running.size > 0) await Promise.all(running.values());
    },
  };
}
