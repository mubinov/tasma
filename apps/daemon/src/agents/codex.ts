// Codex through the ACP adapter `codex-acp`, which runs the user's own `codex`
// install.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentAdapter, AgentEnv } from "./adapter.js";
import {
  adapterLaunch,
  childEnv,
  childPath,
  COMMAND_TIMEOUT_MS,
  commandOutput,
  findBinary,
  isRecord,
  jsonOf,
  SKILL_PLUGIN,
  thisHost,
} from "./process.js";
import type { AgentHost } from "./process.js";

const ADAPTER_ENTRY = "@agentclientprotocol/codex-acp/dist/index.js";

/**
 * The options of `codex-acp`. An ACP client sets them for the adapter, and the
 * commands of its agent inherit them. Some names are common, so only the
 * launch of Codex removes them.
 */
const CODEX_ACP_OPTIONS: readonly string[] = [
  "INITIAL_AGENT_MODE",
  "CODEX_CONFIG",
  "DEFAULT_AUTH_REQUEST",
  "MODEL_PROVIDER",
  "APP_SERVER_LOGS",
  "DISABLE_MCP_CONFIG_FILTERING",
];

/**
 * `codex-acp` reads more options with this prefix, and gives `codex app-server`
 * the header values of a gateway provider in `CODEX_ACP_PROVIDER_HEADER_<n>`.
 */
const CODEX_ACP_PREFIX = "CODEX_ACP_";

function withoutAdapterOptions(env: AgentEnv): AgentEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !CODEX_ACP_OPTIONS.includes(name) && !name.startsWith(CODEX_ACP_PREFIX)),
  );
}

function skillPluginOf(stdout: string): boolean | undefined {
  const list = jsonOf(stdout);
  if (!isRecord(list) || !Array.isArray(list.installed)) return undefined;
  return list.installed.some(
    (plugin: unknown) => isRecord(plugin) && plugin.pluginId === SKILL_PLUGIN && plugin.enabled === true,
  );
}

/** Runs `codex login status`, which gives its answer as the exit code alone. */
async function loggedIn(env: AgentEnv, signal: AbortSignal, timeoutMs: number): Promise<boolean | undefined> {
  const path = childPath(env.PATH);
  const codex = findBinary(path, "codex");
  if (codex === undefined) return undefined;
  const output = await commandOutput(codex, ["login", "status"], childEnv(env, path), signal, timeoutMs);
  switch (output?.code) {
    case 0: return true;
    case 1: return false;
    default: return undefined;
  }
}

/**
 * Codex reads user skills from `~/.agents/skills` and from the `skills` folder
 * of its home. A relative `CODEX_HOME` resolves in the folder of each chat,
 * which is not a fixed path.
 */
function skillFiles(env: AgentEnv): string[] {
  const home = env.HOME ?? homedir();
  const codexHome = env.CODEX_HOME !== undefined && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(home, ".codex");
  return [join(home, ".agents", "skills", "tasma", "SKILL.md"), join(codexHome, "skills", "tasma", "SKILL.md")];
}

/**
 * Checks the signal first, so that a cancelled check does not read as a
 * machine with no `codex`. The first run of `plugin list` can take more than
 * 30 s, and gives `undefined` at the time limit.
 */
async function skillListed(env: AgentEnv, signal: AbortSignal, timeoutMs: number): Promise<boolean | undefined> {
  if (signal.aborted) return undefined;
  const path = childPath(env.PATH);
  const codex = findBinary(path, "codex");
  if (codex === undefined) return false;
  const output = await commandOutput(codex, ["plugin", "list", "--json"], childEnv(env, path), signal, timeoutMs);
  if (output?.code !== 0) return undefined;
  return skillPluginOf(output.stdout);
}

/** The options are for the tests alone. */
export function createCodexAdapter(options: { host?: AgentHost; commandTimeoutMs?: number } = {}): AgentAdapter {
  const { host = thisHost(), commandTimeoutMs = COMMAND_TIMEOUT_MS } = options;
  return {
    agent: "codex",
    notLoggedIn: 'Codex is not logged in. Run "codex login" in a terminal.',
    sessionGone: "Codex no longer has the conversation of this chat. Start a new chat for this step.",
    projectSessionGone: "Codex no longer has the conversation of this chat. Start a new chat.",
    // A resume of a thread that Codex does not have fails with this text of Codex, not with -32002.
    sessionLost: (reason) => reason.includes("no rollout found for thread id"),
    launch(env) {
      const path = childPath(env.PATH);
      const codex = findBinary(path, "codex");
      if (codex === undefined) return { missing: "Codex is not installed" };
      // With no `CODEX_PATH`, the adapter runs its own `@openai/codex` with `process.execPath`.
      return adapterLaunch(host, "codex", ADAPTER_ENTRY, { ...withoutAdapterOptions(childEnv(env, path)), CODEX_PATH: codex });
    },
    loggedIn: (env, signal) => loggedIn(env, signal, commandTimeoutMs),
    skillFiles,
    skillListed: (env, signal) => skillListed(env, signal, commandTimeoutMs),
    skillsAgent: "codex",
    async serve() {
      // A literal, so that the build keeps it as an external import and
      // `bun build --compile` puts the adapter into the binary.
      await import("@agentclientprotocol/codex-acp/dist/index.js");
    },
    filterUpdate: (update) => update,
  };
}

export const codexAdapter = createCodexAdapter();
