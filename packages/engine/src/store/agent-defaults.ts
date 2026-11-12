// The values that each agent takes for its config options at the start of a
// new chat, by agent and option id. Only the daemon writes the file; a hand
// edit applies to the next read.

import { isRecord, stringRecord } from "../format/values.js";
import { makeDirectory, replaceFile } from "./atomic.js";
import { readJsonObject } from "./json-object.js";
import { agentDefaultsPath, expandRoot } from "./paths.js";
import type { StoreDiagnostic } from "./types.js";

/** Option id → value, by agent. */
export type AgentDefaults = Record<string, Record<string, string>>;

/** A file that the read uses as empty gives one diagnostic. */
export type AgentDefaultsRead = { defaults: AgentDefaults; diagnostics: StoreDiagnostic[] };

export type AgentDefaultsStore = {
  readonly path: string;
  /** A missing file is empty. A value that is not a string is left out. */
  read(): Promise<AgentDefaultsRead>;
  /**
   * Sets one value of one agent and keeps every other key of the file. A file
   * that `read` uses as empty is replaced. The writes run one at a time.
   */
  save(agent: string, configId: string, value: string): Promise<void>;
};

export function openAgentDefaults(root?: string): AgentDefaultsStore {
  const expanded = expandRoot(root);
  const path = agentDefaultsPath(expanded);
  let writes: Promise<unknown> = Promise.resolve();

  async function write(agent: string, configId: string, value: string): Promise<void> {
    const { stored } = await readJsonObject(path);
    const own = isRecord(stored[agent]) ? stored[agent] : {};
    const next = { ...stored, [agent]: { ...own, [configId]: value } };
    await makeDirectory(expanded);
    await replaceFile(path, `${JSON.stringify(next, null, 2)}\n`);
  }

  return {
    path,
    async read() {
      const { stored, fault } = await readJsonObject(path);
      const defaults = Object.fromEntries(
        Object.entries(stored).map(([agent, values]) => [agent, stringRecord(values) ?? {}]),
      );
      const diagnostics: StoreDiagnostic[] = fault === undefined ? [] : [{ code: "config-unreadable", message: fault, path }];
      return { defaults, diagnostics };
    },
    save(agent, configId, value) {
      const run = writes.then(() => write(agent, configId, value));
      writes = run.catch(() => undefined);
      return run;
    },
  };
}
