// Claude through the ACP adapter `claude-agent-acp`, which runs the user's own
// `claude` install.

import { delimiter, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpObject } from "@tasma/protocol";
import { causeOf } from "../http/failure.js";
import { AGENT_MODE } from "./adapter.js";
import type { AgentAdapter, AgentEnv, LaunchResult } from "./adapter.js";
import { isExecutableFile } from "./process.js";

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

/** `compiled` is a binary that `bun build --compile` made, which holds the adapter in its own file system. */
export type ClaudeHost = { runtime: "node" | "bun" | "compiled"; resolve(specifier: string): string };

function runtimeOf(): ClaudeHost["runtime"] {
  // A compiled binary has argv ["bun", "/$bunfs/root/<name>", ...].
  if (process.argv[1]?.includes("$bunfs")) return "compiled";
  return process.versions.bun === undefined ? "node" : "bun";
}

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
  return dirs.map((dir) => join(dir, "claude")).find(isExecutableFile);
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
  runtime: runtimeOf(),
  resolve: (specifier) => import.meta.resolve(specifier),
}): AgentAdapter {
  return {
    agent: "claude",
    notLoggedIn: 'Claude is not logged in. Run "claude /login" in a terminal.',
    launch(env): LaunchResult {
      const path = agentPath(env.PATH);
      const claude = findClaude(path);
      if (claude === undefined) return { missing: "Claude Code is not installed" };
      const agentEnv = { ...withoutSession(env), PATH: path.join(delimiter), CLAUDE_CODE_EXECUTABLE: claude };
      // `process.execPath` is the compiled daemon itself.
      if (host.runtime === "compiled") return { command: process.execPath, args: [AGENT_MODE, "claude"], env: agentEnv };
      let entry: string;
      try {
        entry = fileURLToPath(host.resolve(ADAPTER_ENTRY));
      } catch (error) {
        return { failed: `The agent could not start: ${causeOf(error)}` };
      }
      // bun reads `bunfig.toml` and `.env` of its working directory, which is the folder of the chat.
      const flags = host.runtime === "bun" ? ["--no-env-file", "--config=/dev/null"] : [];
      return { command: process.execPath, args: [...flags, entry], env: agentEnv };
    },
    async serve() {
      // A literal, so that the build keeps it as an external import and
      // `bun build --compile` puts the adapter into the binary.
      await import("@agentclientprotocol/claude-agent-acp/dist/index.js");
    },
    filterUpdate,
  };
}

export const claudeAdapter = createClaudeAdapter();
