// Claude through the ACP adapter `claude-agent-acp`, which runs the user's own
// `claude` install.

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpObject } from "@tasma/protocol";
import { causeOf } from "../http/failure.js";
import type { AgentAdapter, AgentEnv, AgentLaunch } from "./adapter.js";

const ADAPTER_ENTRY = "@agentclientprotocol/claude-agent-acp/dist/index.js";

/**
 * The variables a running Claude Code session (the CLI or the IDE extension)
 * sets for its children. The daemon often inherits them, because the first
 * `tasma` call that starts it often comes from an agent inside Claude Code.
 */
export const CLAUDE_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_CODE_ENABLE_TASKS",
  "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
  "CLAUDE_CODE_EMIT_STARTUP_TIMING",
  "MCP_CONNECTION_NONBLOCKING",
] as const;

/** The largest `_meta.claudeCode.toolResponse` an update keeps, in bytes of JSON. */
const TOOL_RESPONSE_LIMIT = 8 * 1024;

export type ClaudeHost = { bun: boolean; resolve(specifier: string): string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The `PATH` directories the agent gets. A relative directory resolves in the
 * folder of each chat. A directory inside `node_modules` holds the bins of one
 * repository: a package script puts them first on `PATH`, and the daemon it
 * starts keeps that `PATH`.
 */
function agentPath(path: string | undefined): string[] {
  return (path ?? "").split(delimiter).filter((dir) => isAbsolute(dir) && !dir.split(sep).includes("node_modules"));
}

/**
 * The first `claude` that this user can run, as found: a link is not resolved,
 * so a self-update of Claude Code reaches the next chat.
 */
function findClaude(dirs: string[]): string | undefined {
  for (const dir of dirs) {
    const candidate = join(dir, "claude");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function withoutSession(env: AgentEnv): AgentEnv {
  const kept = { ...env };
  for (const name of CLAUDE_SESSION_VARIABLES) delete kept[name];
  return kept;
}

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

/** `host` is a parameter for the tests alone. */
export function createClaudeAdapter(host: ClaudeHost = {
  bun: process.versions.bun !== undefined,
  resolve: (specifier) => import.meta.resolve(specifier),
}): AgentAdapter {
  return {
    agent: "claude",
    notLoggedIn: 'Claude is not logged in. Run "claude /login" in a terminal.',
    launch(env): AgentLaunch | { failed: string } {
      // Under bun, `process.execPath` is the compiled daemon itself.
      if (host.bun) return { failed: "This build of Tasma cannot run Claude yet" };
      const path = agentPath(env.PATH);
      const claude = findClaude(path);
      if (claude === undefined) return { failed: "Claude Code is not installed" };
      let entry: string;
      try {
        entry = fileURLToPath(host.resolve(ADAPTER_ENTRY));
      } catch (error) {
        return { failed: `The agent could not start: ${causeOf(error)}` };
      }
      return {
        command: process.execPath,
        args: [entry],
        env: { ...withoutSession(env), PATH: path.join(delimiter), CLAUDE_CODE_EXECUTABLE: claude },
      };
    },
    filterUpdate,
  };
}

export const claudeAdapter = createClaudeAdapter();
