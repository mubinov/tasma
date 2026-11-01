// Claude through the ACP adapter `claude-agent-acp`, which runs the user's own
// `claude` install.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpObject } from "@tasma/protocol";
import { causeOf } from "../http/failure.js";
import { AGENT_MODE } from "./adapter.js";
import type { AgentAdapter, AgentEnv, LaunchResult } from "./adapter.js";
import { isExecutableFile, killGroup } from "./process.js";

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

const COMMAND_TIMEOUT_MS = 5000;

const COMMAND_OUTPUT_LIMIT = 64 * 1024;

const SKILL_PLUGIN = "tasma@tasma";

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

/** The environment of each process that runs Claude Code: the agent of a chat, the login check and the plugin list. */
function claudeEnv(env: AgentEnv, path: string[]): AgentEnv {
  const kept: AgentEnv = { ...env, PATH: path.join(delimiter) };
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

function jsonOf(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
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

/** The stdout of a `claude` command, or `undefined` when no answer can come from it. */
function claudeOutput(
  claude: string,
  args: string[],
  env: AgentEnv,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  let child: ChildProcess;
  try {
    child = spawn(claude, args, {
      cwd: env.HOME ?? homedir(),
      env,
      stdio: ["ignore", "pipe", "ignore"],
      // A group of its own, so that the kill also ends the processes that claude starts.
      detached: true,
    });
  } catch {
    // Node throws most errors of the system call, for example ENOEXEC.
    return Promise.resolve(undefined);
  }

  const { pid, stdout } = child;
  // The spawn failed, and `error` comes next. At EMFILE and ENFILE, there is no stdout either.
  if (pid === undefined || stdout === null) return new Promise((resolve) => child.once("error", () => resolve(undefined)));

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (output: string | undefined): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve(output);
    };
    const stop = (): void => {
      killGroup(child, pid);
      stdout.destroy();
      finish(undefined);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });

    stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > COMMAND_OUTPUT_LIMIT) stop();
      else chunks.push(chunk);
    });
    // A kill that fails emits `error`.
    child.on("error", () => finish(undefined));
    // A number is an exit code, and the caller reads the output of each exit code:
    // `auth status` gives JSON with exit code 1 for a user who is not logged in.
    child.on("close", (code) => finish(code === null ? undefined : Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * Runs `claude auth status --json`. The variables of an API key or a token
 * count as a login there, as they do for a chat in the same environment.
 */
async function loggedIn(env: AgentEnv, signal: AbortSignal, timeoutMs: number): Promise<boolean | undefined> {
  const path = agentPath(env.PATH);
  const claude = findClaude(path);
  if (claude === undefined) return undefined;
  const stdout = await claudeOutput(claude, ["auth", "status", "--json"], claudeEnv(env, path), signal, timeoutMs);
  return stdout === undefined ? undefined : loginOf(stdout);
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
  const path = agentPath(env.PATH);
  const claude = findClaude(path);
  if (claude === undefined) return false;
  const stdout = await claudeOutput(claude, ["plugin", "list", "--json"], claudeEnv(env, path), signal, timeoutMs);
  return stdout === undefined ? undefined : skillPluginOf(stdout);
}

/** The options are for the tests alone. */
export function createClaudeAdapter(options: { host?: ClaudeHost; commandTimeoutMs?: number } = {}): AgentAdapter {
  const {
    host = { runtime: runtimeOf(), resolve: (specifier) => import.meta.resolve(specifier) },
    commandTimeoutMs = COMMAND_TIMEOUT_MS,
  } = options;
  return {
    agent: "claude",
    notLoggedIn: 'Claude is not logged in. Run "claude /login" in a terminal.',
    sessionGone: "Claude no longer has the conversation of this chat. Start a new chat for this step.",
    launch(env): LaunchResult {
      const path = agentPath(env.PATH);
      const claude = findClaude(path);
      if (claude === undefined) return { missing: "Claude Code is not installed" };
      const agentEnv = { ...claudeEnv(env, path), CLAUDE_CODE_EXECUTABLE: claude };
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
    loggedIn: (env, signal) => loggedIn(env, signal, commandTimeoutMs),
    skillFiles,
    skillListed: (env, signal) => skillListed(env, signal, commandTimeoutMs),
    async serve() {
      // A literal, so that the build keeps it as an external import and
      // `bun build --compile` puts the adapter into the binary.
      await import("@agentclientprotocol/claude-agent-acp/dist/index.js");
    },
    filterUpdate,
  };
}

export const claudeAdapter = createClaudeAdapter();
