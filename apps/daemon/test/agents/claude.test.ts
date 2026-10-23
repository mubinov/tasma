import { existsSync } from "node:fs";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AcpObject } from "@tasma/protocol";
import type { AgentLaunch } from "../../src/agents/adapter.js";
import { CLAUDE_SESSION_VARIABLES, claudeAdapter, createClaudeAdapter } from "../../src/agents/claude.js";
import { target } from "../helpers.js";

/** Counts the evaluations of the adapter entry. The real entry would serve ACP over the stdio of the test worker. */
const entry = vi.hoisted(() => ({ evaluated: 0 }));

vi.mock("@agentclientprotocol/claude-agent-acp/dist/index.js", () => {
  entry.evaluated += 1;
  return {};
});

/** A directory holding a file named `claude` with the given mode. */
async function binWith(mode: number): Promise<{ dir: string; claude: string }> {
  const dir = await target();
  const claude = join(dir, "claude");
  await writeFile(claude, "#!/bin/sh\n");
  await chmod(claude, mode);
  return { dir, claude };
}

function launched(env: Record<string, string | undefined>, adapter = claudeAdapter): AgentLaunch {
  const launch = adapter.launch(env);
  if (!("command" in launch)) throw new Error(`the launch failed: ${JSON.stringify(launch)}`);
  return launch;
}

describe("claudeAdapter.launch", () => {
  it("finds the first claude on PATH that this user can run", async () => {
    const first = await binWith(0o755);
    const second = await binWith(0o755);

    const launch = launched({ PATH: [first.dir, second.dir].join(delimiter) });

    expect(launch.env.CLAUDE_CODE_EXECUTABLE).toBe(first.claude);
  });

  it("skips a claude that cannot run, a directory named claude and a relative directory", async () => {
    const plain = await binWith(0o644);
    const holder = await target();
    await mkdir(join(holder, "claude"));
    const runnable = await binWith(0o755);

    const launch = launched({ PATH: [plain.dir, holder, "", "bin", runnable.dir].join(delimiter) });

    expect(launch.env.CLAUDE_CODE_EXECUTABLE).toBe(runnable.claude);
  });

  it("skips a claude in a directory inside node_modules", async () => {
    const project = await target();
    const packageBin = join(project, "node_modules", ".bin");
    await mkdir(packageBin, { recursive: true });
    await writeFile(join(packageBin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    const runnable = await binWith(0o755);

    const launch = launched({ PATH: [packageBin, runnable.dir].join(delimiter) });

    expect(launch.env.CLAUDE_CODE_EXECUTABLE).toBe(runnable.claude);
  });

  it("gives the agent a PATH with no relative directory and no directory inside node_modules", async () => {
    const bin = await binWith(0o755);
    const packageBin = join(await target(), "node_modules", ".bin");

    const launch = launched({ PATH: ["node_modules/.bin", packageBin, bin.dir, "", "/usr/bin"].join(delimiter) });

    expect(launch.env.PATH).toBe([bin.dir, "/usr/bin"].join(delimiter));
  });

  it("keeps a link to claude as found on PATH", async () => {
    const real = await binWith(0o755);
    const links = await target();
    await symlink(real.claude, join(links, "claude"));

    const launch = launched({ PATH: links });

    expect(launch.env.CLAUDE_CODE_EXECUTABLE).toBe(join(links, "claude"));
  });

  it("gives missing with no claude on PATH in each runtime, and resolves nothing", async () => {
    const empty = await target();
    const resolve = vi.fn((specifier: string) => specifier);

    for (const runtime of ["node", "bun", "compiled"] as const) {
      const adapter = createClaudeAdapter({ runtime, resolve });
      expect(adapter.launch({ PATH: empty })).toEqual({ missing: "Claude Code is not installed" });
      expect(adapter.launch({})).toEqual({ missing: "Claude Code is not installed" });
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("runs the adapter under this runtime with the environment of the daemon", async () => {
    const bin = await binWith(0o755);
    const session = Object.fromEntries(CLAUDE_SESSION_VARIABLES.map((name) => [name, "1"]));

    const launch = launched({ ...session, PATH: bin.dir, HOME: "/home/alice", ANTHROPIC_MODEL: "opus" });

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toHaveLength(1);
    expect(launch.args[0]).toMatch(/claude-agent-acp[/\\]dist[/\\]index\.js$/);
    expect(existsSync(launch.args[0] ?? "")).toBe(true);
    expect(launch.env).toEqual({
      PATH: bin.dir,
      HOME: "/home/alice",
      ANTHROPIC_MODEL: "opus",
      CLAUDE_CODE_EXECUTABLE: bin.claude,
    });
  });

  it("runs the adapter under bun with no bunfig.toml and no .env of the chat folder", async () => {
    const bin = await binWith(0o755);
    const adapter = createClaudeAdapter({ runtime: "bun", resolve: () => "file:///opt/app/adapter/dist/index.js" });

    const launch = launched({ PATH: bin.dir }, adapter);

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["--no-env-file", "--config=/dev/null", "/opt/app/adapter/dist/index.js"]);
  });

  it("runs the agent mode of the compiled daemon with the environment of the daemon, and resolves nothing", async () => {
    const bin = await binWith(0o755);
    const session = Object.fromEntries(CLAUDE_SESSION_VARIABLES.map((name) => [name, "1"]));
    const resolve = vi.fn((specifier: string) => specifier);
    const adapter = createClaudeAdapter({ runtime: "compiled", resolve });

    const launch = launched({ ...session, PATH: `node_modules/.bin${delimiter}${bin.dir}`, HOME: "/home/alice" }, adapter);

    expect(launch).toEqual({
      command: process.execPath,
      args: ["--agent", "claude"],
      env: { PATH: bin.dir, HOME: "/home/alice", CLAUDE_CODE_EXECUTABLE: bin.claude },
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("takes the runtime by default from argv and from the version of bun", async () => {
    const bin = await binWith(0o755);
    const { argv } = process;
    onTestFinished(() => {
      process.argv = argv;
      delete process.versions.bun;
    });
    const argsWith = (...run: string[]) => {
      process.argv = run;
      return launched({ PATH: bin.dir }, createClaudeAdapter()).args;
    };
    const entryPath = /claude-agent-acp[/\\]dist[/\\]index\.js$/;

    expect(argsWith("/usr/local/bin/node", "/opt/app/dist/tasma-daemon.js")).toEqual([expect.stringMatching(entryPath)]);
    expect(argsWith("/usr/local/bin/node")).toEqual([expect.stringMatching(entryPath)]);
    Object.defineProperty(process.versions, "bun", { value: "1.3.14", configurable: true });
    expect(argsWith("bun", "/$bunfs/root/tasma-daemon", "--agent", "claude")).toEqual(["--agent", "claude"]);
    expect(argsWith("/usr/local/bin/bun", "/opt/app/dist/tasma-daemon.js")).toEqual([
      "--no-env-file",
      "--config=/dev/null",
      expect.stringMatching(entryPath),
    ]);
  });

  it("fails when the adapter package cannot be resolved", async () => {
    const bin = await binWith(0o755);
    const adapter = createClaudeAdapter({
      runtime: "node",
      resolve: () => {
        throw new Error("Cannot find package");
      },
    });

    expect(adapter.launch({ PATH: bin.dir })).toEqual({ failed: "The agent could not start: Cannot find package" });
  });
});

describe("claudeAdapter.serve", () => {
  it("evaluates the entry of the adapter package, which serves ACP in this process", async () => {
    expect(entry.evaluated).toBe(0);

    await claudeAdapter.serve?.();

    expect(entry.evaluated).toBe(1);
  });
});

describe("claudeAdapter.filterUpdate", () => {
  /** A tool update whose `toolResponse` serializes to exactly `bytes` bytes of JSON. */
  function toolUpdate(bytes: number): AcpObject {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      _meta: { claudeCode: { toolName: "Read", toolResponse: "x".repeat(bytes - 2) }, other: { kept: true } },
    };
  }

  it("removes a toolResponse larger than 8 KB and keeps every other key", () => {
    const update = toolUpdate(8193);
    const before = structuredClone(update);

    expect(claudeAdapter.filterUpdate(update)).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      _meta: { claudeCode: { toolName: "Read" }, other: { kept: true } },
    });
    expect(update).toEqual(before);
  });

  it("keeps a toolResponse of 8 KB", () => {
    const update = toolUpdate(8192);

    expect(claudeAdapter.filterUpdate(update)).toEqual(update);
  });

  it("measures the size in bytes", () => {
    const update = {
      sessionUpdate: "tool_call_update",
      _meta: { claudeCode: { toolResponse: "é".repeat(4096) } },
    };

    expect(claudeAdapter.filterUpdate(update)).toEqual({ sessionUpdate: "tool_call_update", _meta: { claudeCode: {} } });
  });

  it("keeps an update with no toolResponse", () => {
    const updates: AcpObject[] = [
      { sessionUpdate: "agent_message_chunk" },
      { sessionUpdate: "agent_message_chunk", _meta: null },
      { sessionUpdate: "tool_call", _meta: { claudeCode: null } },
      { sessionUpdate: "tool_call", _meta: { claudeCode: { toolName: "Bash" } } },
      { sessionUpdate: "tool_call", _meta: { claudeCode: { toolResponse: undefined } } },
    ];

    for (const update of updates) expect(claudeAdapter.filterUpdate(update)).toBe(update);
  });
});
