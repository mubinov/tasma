// The config options that each agent sent when it opened its last new session,
// by agent, in the shape of the agent. Only the daemon writes the file; a hand
// edit applies to the next read.

import { isRecord } from "../format/values.js";
import { makeDirectory, replaceFile } from "./atomic.js";
import { readJsonObject } from "./json-object.js";
import { agentOptionsPath, expandRoot } from "./paths.js";
import type { StoreDiagnostic } from "./types.js";

/** `updated` is the time of the write. */
export type AgentOptionsEntry = { options: Record<string, unknown>[]; updated: string };

/** A file that the read cannot use, and each entry of an agent that it cannot use, give one diagnostic. */
export type AgentOptionsRead = { lists: Record<string, AgentOptionsEntry>; diagnostics: StoreDiagnostic[] };

export type AgentOptionsStore = {
  readonly path: string;
  /** A missing file has no lists. */
  read(): Promise<AgentOptionsRead>;
  /**
   * Replaces the list of one agent and keeps every other key of the file. A
   * file that `read` cannot use is replaced. The writes run one at a time.
   */
  save(agent: string, options: readonly Record<string, unknown>[]): Promise<void>;
};

function entryOf(value: unknown): AgentOptionsEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { options, updated } = value;
  if (!Array.isArray(options) || !options.every(isRecord) || typeof updated !== "string") return undefined;
  return { options, updated };
}

export function openAgentOptions(root?: string): AgentOptionsStore {
  const expanded = expandRoot(root);
  const path = agentOptionsPath(expanded);
  let writes: Promise<unknown> = Promise.resolve();

  async function write(agent: string, options: readonly Record<string, unknown>[]): Promise<void> {
    const { stored } = await readJsonObject(path);
    const next = { ...stored, [agent]: { options, updated: new Date().toISOString() } };
    await makeDirectory(expanded);
    await replaceFile(path, `${JSON.stringify(next, null, 2)}\n`);
  }

  return {
    path,
    async read() {
      const { stored, fault } = await readJsonObject(path);
      if (fault !== undefined) return { lists: {}, diagnostics: [{ code: "config-unreadable", message: fault, path }] };
      const usable: [string, AgentOptionsEntry][] = [];
      const diagnostics: StoreDiagnostic[] = [];
      for (const [agent, value] of Object.entries(stored)) {
        const entry = entryOf(value);
        if (entry === undefined) {
          diagnostics.push({ code: "config-unreadable", message: `the options of ${agent} are not usable`, path });
        } else {
          usable.push([agent, entry]);
        }
      }
      return { lists: Object.fromEntries(usable), diagnostics };
    },
    save(agent, options) {
      const run = writes.then(() => write(agent, options));
      writes = run.catch(() => undefined);
      return run;
    },
  };
}
