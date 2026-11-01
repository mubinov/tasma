import type { ChildProcess } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AcpObject } from "@tasma/protocol";
import type { AgentLaunch } from "../../src/agents/adapter.js";
import { CLAUDE_SESSION_VARIABLES, claudeAdapter, createClaudeAdapter } from "../../src/agents/claude.js";
import { target, until, untilPid } from "../helpers.js";

/** Counts the evaluations of the adapter entry. The real entry would serve ACP over the stdio of the test worker. */
const entry = vi.hoisted(() => ({ evaluated: 0 }));

vi.mock("@agentclientprotocol/claude-agent-acp/dist/index.js", () => {
  entry.evaluated += 1;
  return {};
});

/** A child that the next spawn gives in place of a real one. */
const spawning = vi.hoisted(() => ({ next: undefined as ChildProcess | undefined }));

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn(...args: Parameters<typeof actual.spawn>) {
      const { next } = spawning;
      spawning.next = undefined;
      return next ?? actual.spawn(...args);
    },
  };
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
      const adapter = createClaudeAdapter({ host: { runtime, resolve } });
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
    const adapter = createClaudeAdapter({ host: { runtime: "bun", resolve: () => "file:///opt/app/adapter/dist/index.js" } });

    const launch = launched({ PATH: bin.dir }, adapter);

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["--no-env-file", "--config=/dev/null", "/opt/app/adapter/dist/index.js"]);
  });

  it("runs the agent mode of the compiled daemon with the environment of the daemon, and resolves nothing", async () => {
    const bin = await binWith(0o755);
    const session = Object.fromEntries(CLAUDE_SESSION_VARIABLES.map((name) => [name, "1"]));
    const resolve = vi.fn((specifier: string) => specifier);
    const adapter = createClaudeAdapter({ host: { runtime: "compiled", resolve } });

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
      host: {
        runtime: "node",
        resolve: () => {
          throw new Error("Cannot find package");
        },
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

describe("claudeAdapter.loggedIn", () => {
  /** A directory holding an executable `claude` that runs `script`. */
  async function claudeRunning(script: string): Promise<string> {
    const dir = await target();
    await writeFile(join(dir, "claude"), `#!/bin/sh\n${script}\n`);
    await chmod(join(dir, "claude"), 0o755);
    return dir;
  }

  function liveSignal(): AbortSignal {
    return new AbortController().signal;
  }

  it("gives true for loggedIn true with exit code 0", async () => {
    const dir = await claudeRunning("echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}'");

    await expect(claudeAdapter.loggedIn({ PATH: dir, HOME: dir }, liveSignal())).resolves.toBe(true);
  });

  it("gives false for loggedIn false with exit code 1", async () => {
    const dir = await claudeRunning("echo '{\"loggedIn\":false,\"authMethod\":\"none\"}'; exit 1");

    await expect(claudeAdapter.loggedIn({ PATH: dir, HOME: dir }, liveSignal())).resolves.toBe(false);
  });

  it.each([
    ["output that is not JSON", "echo 'Not logged in'"],
    ["JSON with no boolean loggedIn", "echo '{\"loggedIn\":\"yes\"}'"],
    ["JSON that is not an object", "echo null"],
    ["no output", "exit 2"],
    ["a process that a signal ends", "echo '{\"loggedIn\":true}'; kill -9 $$"],
  ])("gives undefined for %s", async (_name, script) => {
    const dir = await claudeRunning(script);

    await expect(claudeAdapter.loggedIn({ PATH: dir, HOME: dir }, liveSignal())).resolves.toBeUndefined();
  });

  it("gives undefined for a claude that the system cannot start", async () => {
    const dir = await target();
    // No `#!` line: the exec fails with ENOEXEC.
    await writeFile(join(dir, "claude"), "echo '{\"loggedIn\":true}'\n", { mode: 0o755 });

    await expect(claudeAdapter.loggedIn({ PATH: dir, HOME: dir }, liveSignal())).resolves.toBeUndefined();
  });

  it("gives undefined with no claude on PATH", async () => {
    await expect(claudeAdapter.loggedIn({ PATH: await target() }, liveSignal())).resolves.toBeUndefined();
    await expect(claudeAdapter.loggedIn({}, liveSignal())).resolves.toBeUndefined();
  });

  it("skips a claude in a directory inside node_modules", async () => {
    const packageBin = join(await target(), "node_modules", ".bin");
    await mkdir(packageBin, { recursive: true });
    await writeFile(join(packageBin, "claude"), "#!/bin/sh\necho '{\"loggedIn\":true}'\n", { mode: 0o755 });

    await expect(claudeAdapter.loggedIn({ PATH: packageBin }, liveSignal())).resolves.toBeUndefined();
  });

  it("runs auth status --json in HOME, with stdin closed and the environment of a chat", async () => {
    const out = await target();
    const home = await target();
    // `read` waits for the end of stdin.
    const dir = await claudeRunning(
      `read -r line; printf '%s\\n' "$@" > '${out}/args'; pwd > '${out}/cwd'; /usr/bin/env > '${out}/env'; echo '{"loggedIn":true}'`,
    );
    const packageBin = join(await target(), "node_modules", ".bin");
    const session = Object.fromEntries(CLAUDE_SESSION_VARIABLES.map((name) => [name, "1"]));
    const path = ["node_modules/.bin", packageBin, dir].join(delimiter);

    await expect(claudeAdapter.loggedIn({ ...session, PATH: path, HOME: home, ANTHROPIC_MODEL: "opus" }, liveSignal())).resolves.toBe(true);

    expect(await readFile(join(out, "args"), "utf8")).toBe("auth\nstatus\n--json\n");
    expect((await readFile(join(out, "cwd"), "utf8")).trim()).toBe(await realpath(home));
    const env = (await readFile(join(out, "env"), "utf8")).split("\n");
    expect(env).toContain("ANTHROPIC_MODEL=opus");
    expect(env).toContain(`PATH=${dir}`);
    for (const name of CLAUDE_SESSION_VARIABLES) expect(env.some((line) => line.startsWith(`${name}=`))).toBe(false);
  });

  it("runs in the home directory of this user when the environment has no HOME", async () => {
    const out = await target();
    const dir = await claudeRunning(`pwd > '${out}/cwd'; echo '{"loggedIn":true}'`);

    await expect(claudeAdapter.loggedIn({ PATH: dir }, liveSignal())).resolves.toBe(true);

    expect((await readFile(join(out, "cwd"), "utf8")).trim()).toBe(await realpath(homedir()));
  });

  /**
   * A `claude` that ignores SIGTERM, runs `print`, and then waits in a process
   * that it does not `exec`. It writes its own process id into `out/claude`,
   * and the id of the process that waits into `out/inner`.
   */
  function lingeringClaude(out: string, print: string): Promise<string> {
    // Absolute programs: PATH holds the temporary directory alone. A child keeps the ignored SIGTERM.
    return claudeRunning([
      "trap '' TERM",
      `echo $$ > '${out}/claude'`,
      print,
      `/bin/sh -c "echo \\$\\$ > '${out}/inner'; exec /bin/sleep 10"`,
    ].join("\n"));
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Waits until each process whose id is in a file of `out` is gone. */
  async function gone(out: string, ...names: string[]): Promise<void> {
    const pids = await Promise.all(names.map((name) => untilPid(join(out, name), `${name} wrote its process id`)));
    await until(() => !pids.some(alive), `processes ${pids.join(", ")} are gone`);
  }

  it("gives undefined for output over 64 KiB, and ends claude", async () => {
    const out = await target();
    const dir = await lingeringClaude(
      out,
      "printf '{\"loggedIn\":true,\"pad\":\"'; /usr/bin/head -c 70000 /dev/zero | /usr/bin/tr '\\0' x; printf '\"}'",
    );
    const adapter = createClaudeAdapter({ authTimeoutMs: 60_000 });

    await expect(adapter.loggedIn({ PATH: dir, HOME: dir }, liveSignal())).resolves.toBeUndefined();

    await gone(out, "claude");
  });

  it("gives undefined when claude runs longer than the time limit, and ends claude and the processes it started", async () => {
    const out = await target();
    const dir = await lingeringClaude(out, "echo '{\"loggedIn\":true}'");
    // Long enough for claude to start its child, as the first run of a new executable is slow on macOS.
    const adapter = createClaudeAdapter({ authTimeoutMs: 2000 });

    await expect(adapter.loggedIn({ PATH: dir, HOME: dir }, liveSignal())).resolves.toBeUndefined();

    await gone(out, "claude", "inner");
  });

  it("gives undefined when the signal is cancelled while claude runs, and ends claude and the processes it started", async () => {
    const out = await target();
    const dir = await lingeringClaude(out, "echo '{\"loggedIn\":true}'");
    const adapter = createClaudeAdapter({ authTimeoutMs: 60_000 });
    const controller = new AbortController();

    const answer = adapter.loggedIn({ PATH: dir, HOME: dir }, controller.signal);
    await untilPid(join(out, "inner"), "claude started its child");
    controller.abort();

    await expect(answer).resolves.toBeUndefined();
    await gone(out, "claude", "inner");
  });

  it("starts no claude for a signal cancelled before the call", async () => {
    const out = await target();
    const dir = await claudeRunning(`: > '${out}/started'; echo '{"loggedIn":true}'`);

    await expect(claudeAdapter.loggedIn({ PATH: dir, HOME: dir }, AbortSignal.abort())).resolves.toBeUndefined();

    expect(existsSync(join(out, "started"))).toBe(false);
  });

  it("leaves no listener on the signal after an answer, a start that fails and a time limit", async () => {
    const dir = await claudeRunning("echo '{\"loggedIn\":true}'");
    const slow = await claudeRunning("exec /bin/sleep 10");
    const short = createClaudeAdapter({ authTimeoutMs: 200 });
    const controller = new AbortController();

    await expect(claudeAdapter.loggedIn({ PATH: dir, HOME: dir }, controller.signal)).resolves.toBe(true);
    // A working directory that does not exist fails the start after the call.
    await expect(claudeAdapter.loggedIn({ PATH: dir, HOME: join(dir, "missing") }, controller.signal)).resolves.toBeUndefined();
    await expect(short.loggedIn({ PATH: slow, HOME: slow }, controller.signal)).resolves.toBeUndefined();

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("gives undefined for an error that a started claude emits", async () => {
    const dir = await claudeRunning("echo '{\"loggedIn\":true}'");
    const child = Object.assign(new EventEmitter(), {
      // Above the largest process id, so that a kill reaches no real process.
      pid: 99_999_999,
      stdout: new PassThrough(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    spawning.next = child;
    const controller = new AbortController();

    const answer = claudeAdapter.loggedIn({ PATH: dir, HOME: dir }, controller.signal);
    child.emit("error", new Error("kill EPERM"));

    await expect(answer).resolves.toBeUndefined();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
