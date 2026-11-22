// Claude through the ACP adapter `claude-agent-acp`, which runs the user's own
// `claude` install.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AcpObject } from "@tasma/protocol";
import type { AgentAdapter, AgentEnv } from "./adapter.js";
import { BACKGROUND_RULE, claudeBackground } from "./claude-background.js";
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

const ADAPTER_ENTRY = "@agentclientprotocol/claude-agent-acp/dist/index.js";

/** The largest `_meta.claudeCode.toolResponse` an update keeps, in bytes of JSON. */
const TOOL_RESPONSE_LIMIT = 8 * 1024;

/**
 * The full tool result of the Agent SDK can be the whole text of a file or of
 * a command output. The same data is already in `rawOutput`, `content` or
 * `_meta.terminal_output`, so a large one is dropped.
 */
function filterUpdate(update: AcpObject): AcpObject {
  const meta = update._meta;
  if (!isRecord(meta)) return update;
  const claudeCode = meta.claudeCode;
  if (!isRecord(claudeCode) || !("toolResponse" in claudeCode)) return update;
  if (Buffer.byteLength(JSON.stringify(claudeCode.toolResponse) ?? "") <= TOOL_RESPONSE_LIMIT) return update;
  const kept = { ...claudeCode };
  delete kept.toolResponse;
  return { ...update, _meta: { ...meta, claudeCode: kept } };
}

function loginOf(stdout: string): boolean | undefined {
  const status = jsonOf(stdout);
  return isRecord(status) && typeof status.loggedIn === "boolean" ? status.loggedIn : undefined;
}

function skillPluginOf(stdout: string): boolean | undefined {
  const plugins = jsonOf(stdout);
  if (!Array.isArray(plugins)) return undefined;
  return plugins.some((plugin: unknown) => isRecord(plugin) && plugin.id === SKILL_PLUGIN && plugin.enabled === true);
}

/**
 * Runs `claude auth status --json`. The variables of an API key or a token
 * count as a login there, as they do for a chat in the same environment. The
 * output of each exit code counts: a user who is not logged in gets JSON with
 * exit code 1.
 */
async function loggedIn(env: AgentEnv, signal: AbortSignal, timeoutMs: number): Promise<boolean | undefined> {
  const path = childPath(env.PATH);
  const claude = findBinary(path, "claude");
  if (claude === undefined) return undefined;
  const output = await commandOutput(claude, ["auth", "status", "--json"], childEnv(env, path), signal, timeoutMs);
  return output === undefined ? undefined : loginOf(output.stdout);
}

/** A relative `CLAUDE_CONFIG_DIR` resolves in the folder of each chat, which is not a fixed path. */
function skillFiles(env: AgentEnv): string[] {
  const config = env.CLAUDE_CONFIG_DIR;
  const folder = config !== undefined && isAbsolute(config) ? config : join(env.HOME ?? homedir(), ".claude");
  return [join(folder, "skills", "tasma", "SKILL.md")];
}

/** Checks the signal first, so that a cancelled check does not read as a machine with no `claude`. */
async function skillListed(env: AgentEnv, signal: AbortSignal, timeoutMs: number): Promise<boolean | undefined> {
  if (signal.aborted) return undefined;
  const path = childPath(env.PATH);
  const claude = findBinary(path, "claude");
  if (claude === undefined) return false;
  const output = await commandOutput(claude, ["plugin", "list", "--json"], childEnv(env, path), signal, timeoutMs);
  return output === undefined ? undefined : skillPluginOf(output.stdout);
}

function projectChatContext(tag: string): string {
  return `This chat runs in the Tasma app, a local task manager. The chat belongs to the Tasma project with the tag ${tag}, and your working directory is the folder of this project. The chat has no task and no workflow step.

Before you act on a request about tasks, comments, projects or workflows, load the tasma skill. If the skill is not available, use \`tasma --help\`.

Treat each message as a direct request, and do what the user asks. Do not start a task, set a step or run a workflow step unless the user asks for it.`;
}

/** The options are for the tests alone. */
export function createClaudeAdapter(
  options: { host?: AgentHost; commandTimeoutMs?: number; lsof?: string; lsofTimeoutMs?: number } = {},
): AgentAdapter {
  const { host = thisHost(), commandTimeoutMs = COMMAND_TIMEOUT_MS, lsof, lsofTimeoutMs } = options;
  return {
    agent: "claude",
    sessionMeta: { systemPrompt: { append: BACKGROUND_RULE } },
    projectSessionMeta: (tag) => ({ systemPrompt: { append: `${BACKGROUND_RULE}\n\n${projectChatContext(tag)}` } }),
    optionsSessionMeta: { claudeCode: { options: { persistSession: false, settingSources: ["user"] } } },
    backgroundCommands: (log) => claudeBackground({ log, lsof, timeoutMs: lsofTimeoutMs }),
    notLoggedIn: 'Claude is not logged in. Run "claude /login" in a terminal.',
    sessionGone: "Claude no longer has the conversation of this chat. Start a new chat for this step.",
    projectSessionGone: "Claude no longer has the conversation of this chat. Start a new chat.",
    launch(env) {
      const path = childPath(env.PATH);
      const claude = findBinary(path, "claude");
      if (claude === undefined) return { missing: "Claude Code is not installed" };
      return adapterLaunch(host, "claude", ADAPTER_ENTRY, { ...childEnv(env, path), CLAUDE_CODE_EXECUTABLE: claude });
    },
    loggedIn: (env, signal) => loggedIn(env, signal, commandTimeoutMs),
    skillFiles,
    skillListed: (env, signal) => skillListed(env, signal, commandTimeoutMs),
    skillsAgent: "claude-code",
    async serve() {
      // A literal, so that the build keeps it as an external import and
      // `bun build --compile` puts the adapter into the binary.
      await import("@agentclientprotocol/claude-agent-acp/dist/index.js");
    },
    filterUpdate,
  };
}

export const claudeAdapter = createClaudeAdapter();
