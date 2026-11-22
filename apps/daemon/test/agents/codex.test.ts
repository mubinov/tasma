import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AcpObject } from "@tasma/protocol";
import type { AgentLaunch } from "../../src/agents/adapter.js";
import { codexAdapter, createCodexAdapter } from "../../src/agents/codex.js";
import { SESSION_ENV, target, untilGone } from "../helpers.js";

/** Counts the evaluations of the adapter entry. The real entry would serve ACP over the stdio of the test worker. */
const entry = vi.hoisted(() => ({ evaluated: 0 }));

vi.mock("@agentclientprotocol/codex-acp/dist/index.js", () => {
  entry.evaluated += 1;
  return {};
});

/** Options of `codex-acp` that an ACP client sets for the adapter, and the header value it gives `codex app-server`. */
const CODEX_ACP_OPTIONS = {
  INITIAL_AGENT_MODE: "agent-full-access",
  CODEX_CONFIG: "{}",
  DEFAULT_AUTH_REQUEST: "chatgpt",
  MODEL_PROVIDER: "gateway",
  APP_SERVER_LOGS: "/srv/logs",
  DISABLE_MCP_CONFIG_FILTERING: "true",
  CODEX_ACP_PROMPT_SUGGESTIONS: "false",
  CODEX_ACP_PROVIDER_HEADER_0: "secret",
};

/** A directory holding an executable `codex` that runs `script`. */
async function codexRunning(script: string): Promise<{ dir: string; codex: string }> {
  const dir = await target();
  const codex = join(dir, "codex");
  await writeFile(codex, `#!/bin/sh\n${script}\n`);
  await chmod(codex, 0o755);
  return { dir, codex };
}

function launched(env: Record<string, string | undefined>, adapter = codexAdapter): AgentLaunch {
  const launch = adapter.launch(env);
  if (!("command" in launch)) throw new Error(`the launch failed: ${JSON.stringify(launch)}`);
  return launch;
}

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

/** Each line of the environment that the stand-in `codex` wrote, and its arguments. */
async function seenBy(out: string): Promise<{ args: string; env: string[] }> {
  return {
    args: await readFile(join(out, "args"), "utf8"),
    env: (await readFile(join(out, "env"), "utf8")).split("\n"),
  };
}

function recording(out: string, then: string): string {
  return `printf '%s\\n' "$@" > '${out}/args'; /usr/bin/env > '${out}/env'; ${then}`;
}

describe("codexAdapter", () => {
  it("names the agent, the skills agent and the texts of its failures", () => {
    expect(codexAdapter.agent).toBe("codex");
    expect(codexAdapter.skillsAgent).toBe("codex");
    expect(codexAdapter.notLoggedIn).toBe('Codex is not logged in. Run "codex login" in a terminal.');
    expect(codexAdapter.sessionGone).toBe("Codex no longer has the conversation of this chat. Start a new chat for this step.");
    expect(codexAdapter.projectSessionGone).toBe("Codex no longer has the conversation of this chat. Start a new chat.");
  });

  it("has no session meta, no options refresh and no check of background commands", () => {
    expect(codexAdapter).not.toHaveProperty("sessionMeta");
    expect(codexAdapter).not.toHaveProperty("projectSessionMeta");
    expect(codexAdapter).not.toHaveProperty("optionsSessionMeta");
    expect(codexAdapter).not.toHaveProperty("backgroundCommands");
  });

  it("reads the error of Codex for a thread it does not have as a lost session", () => {
    expect(codexAdapter.sessionLost?.("no rollout found for thread id 0199a4f2-7c1e-7d40-9b6a-3f2e8c5d1a70")).toBe(true);
    expect(codexAdapter.sessionLost?.("Codex process has exited with code 1: unknown flag")).toBe(false);
  });

  it("keeps each update as the agent sends it", () => {
    const update: AcpObject = { sessionUpdate: "tool_call_update", _meta: { other: { kept: true } } };

    expect(codexAdapter.filterUpdate(update)).toBe(update);
  });
});

describe("codexAdapter.launch", () => {
  it("gives missing with no codex on PATH in each runtime, and resolves nothing", async () => {
    const empty = await target();
    const resolve = vi.fn((specifier: string) => specifier);

    for (const runtime of ["node", "bun", "compiled"] as const) {
      const adapter = createCodexAdapter({ host: { runtime, resolve } });
      expect(adapter.launch({ PATH: empty })).toEqual({ missing: "Codex is not installed" });
      expect(adapter.launch({})).toEqual({ missing: "Codex is not installed" });
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("skips a codex that cannot run and a codex in a directory inside node_modules", async () => {
    const plain = await target();
    await writeFile(join(plain, "codex"), "#!/bin/sh\n", { mode: 0o644 });
    const packageBin = join(await target(), "node_modules", ".bin");
    await mkdir(packageBin, { recursive: true });
    await writeFile(join(packageBin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    const runnable = await codexRunning("");

    const launch = launched({ PATH: [plain, packageBin, runnable.dir].join(delimiter) });

    expect(launch.env.CODEX_PATH).toBe(runnable.codex);
  });

  it("keeps a link to codex as found on PATH", async () => {
    const real = await codexRunning("");
    const links = await target();
    await symlink(real.codex, join(links, "codex"));

    expect(launched({ PATH: links }).env.CODEX_PATH).toBe(join(links, "codex"));
  });

  it("runs the adapter under this runtime with the environment of the daemon, no variable of a session and no option of the adapter", async () => {
    const bin = await codexRunning("");
    const packageBin = join(await target(), "node_modules", ".bin");

    const launch = launched({
      ...SESSION_ENV,
      ...CODEX_ACP_OPTIONS,
      PATH: ["node_modules/.bin", packageBin, bin.dir, "/usr/bin"].join(delimiter),
      HOME: "/home/alice",
      CODEX_HOME: "/srv/codex",
    });

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toHaveLength(1);
    expect(launch.args[0]).toMatch(/codex-acp[/\\]dist[/\\]index\.js$/);
    expect(existsSync(launch.args[0] ?? "")).toBe(true);
    expect(launch.env).toEqual({
      PATH: [bin.dir, "/usr/bin"].join(delimiter),
      HOME: "/home/alice",
      CODEX_HOME: "/srv/codex",
      CODEX_PATH: bin.codex,
    });
  });

  it("runs the adapter under bun with no bunfig.toml and no .env of the chat folder", async () => {
    const bin = await codexRunning("");
    const adapter = createCodexAdapter({ host: { runtime: "bun", resolve: () => "file:///opt/app/adapter/dist/index.js" } });

    const launch = launched({ PATH: bin.dir }, adapter);

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["--no-env-file", "--config=/dev/null", "/opt/app/adapter/dist/index.js"]);
  });

  it("runs the agent mode of the compiled daemon, and resolves nothing", async () => {
    const bin = await codexRunning("");
    const resolve = vi.fn((specifier: string) => specifier);
    const adapter = createCodexAdapter({ host: { runtime: "compiled", resolve } });

    const launch = launched({ ...SESSION_ENV, ...CODEX_ACP_OPTIONS, PATH: bin.dir, HOME: "/home/alice" }, adapter);

    expect(launch).toEqual({
      command: process.execPath,
      args: ["--agent", "codex"],
      env: { PATH: bin.dir, HOME: "/home/alice", CODEX_PATH: bin.codex },
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("fails when the adapter package cannot be resolved", async () => {
    const bin = await codexRunning("");
    const adapter = createCodexAdapter({
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

describe("codexAdapter.serve", () => {
  it("evaluates the entry of the adapter package, which serves ACP in this process", async () => {
    expect(entry.evaluated).toBe(0);

    await codexAdapter.serve?.();

    expect(entry.evaluated).toBe(1);
  });
});

describe("codexAdapter.loggedIn", () => {
  it("runs login status in HOME with the environment of a chat, and gives true for exit code 0", async () => {
    const out = await target();
    const home = await target();
    const { dir } = await codexRunning(recording(out, `pwd > '${out}/cwd'; echo 'Logged in using ChatGPT' >&2`));

    await expect(codexAdapter.loggedIn({ ...SESSION_ENV, PATH: dir, HOME: home, CODEX_HOME: "/srv/codex" }, liveSignal())).resolves.toBe(true);

    const seen = await seenBy(out);
    expect(seen.args).toBe("login\nstatus\n");
    expect((await readFile(join(out, "cwd"), "utf8")).trim()).toBe(await realpath(home));
    expect(seen.env).toContain("CODEX_HOME=/srv/codex");
    expect(seen.env).toContain(`PATH=${dir}`);
    for (const name of Object.keys(SESSION_ENV)) expect(seen.env.some((line) => line.startsWith(`${name}=`))).toBe(false);
  });

  it("gives false for exit code 1", async () => {
    const { dir } = await codexRunning("echo 'Not logged in' >&2; exit 1");

    await expect(codexAdapter.loggedIn({ PATH: dir, HOME: dir }, liveSignal())).resolves.toBe(false);
  });

  it.each([
    ["exit code 2", "exit 2"],
    ["a process that a signal ends", "kill -9 $$"],
  ])("gives undefined for %s", async (_name, script) => {
    const { dir } = await codexRunning(script);

    await expect(codexAdapter.loggedIn({ PATH: dir, HOME: dir }, liveSignal())).resolves.toBeUndefined();
  });

  it("gives undefined when codex runs longer than the time limit, and ends codex", async () => {
    const out = await target();
    const { dir } = await codexRunning(`echo $$ > '${out}/codex'; exec /bin/sleep 10`);
    // Long enough for codex to write its process id, as the first run of a new executable is slow on macOS.
    const adapter = createCodexAdapter({ commandTimeoutMs: 2000 });

    await expect(adapter.loggedIn({ PATH: dir, HOME: dir }, liveSignal())).resolves.toBeUndefined();

    await untilGone(out, "codex");
  });

  it("gives undefined with no codex on PATH", async () => {
    await expect(codexAdapter.loggedIn({ PATH: await target() }, liveSignal())).resolves.toBeUndefined();
    await expect(codexAdapter.loggedIn({}, liveSignal())).resolves.toBeUndefined();
  });
});

describe("codexAdapter.skillFiles", () => {
  it("gives the shared skills folder and the folder of the Codex home in HOME", () => {
    expect(codexAdapter.skillFiles({ HOME: "/home/alice" })).toEqual([
      "/home/alice/.agents/skills/tasma/SKILL.md",
      "/home/alice/.codex/skills/tasma/SKILL.md",
    ]);
  });

  it("gives the folder of an absolute CODEX_HOME", () => {
    expect(codexAdapter.skillFiles({ HOME: "/home/alice", CODEX_HOME: "/srv/codex" })).toEqual([
      "/home/alice/.agents/skills/tasma/SKILL.md",
      "/srv/codex/skills/tasma/SKILL.md",
    ]);
  });

  it.each(["", "codex/home"])("gives the folder of the Codex home in HOME with a CODEX_HOME of '%s'", (value) => {
    expect(codexAdapter.skillFiles({ HOME: "/home/alice", CODEX_HOME: value })).toEqual([
      "/home/alice/.agents/skills/tasma/SKILL.md",
      "/home/alice/.codex/skills/tasma/SKILL.md",
    ]);
  });

  it("gives the paths in the home directory of this user with no HOME", () => {
    expect(codexAdapter.skillFiles({})).toEqual([
      join(homedir(), ".agents", "skills", "tasma", "SKILL.md"),
      join(homedir(), ".codex", "skills", "tasma", "SKILL.md"),
    ]);
  });
});

describe("codexAdapter.skillListed", () => {
  const plugins = (...installed: unknown[]) => `echo '${JSON.stringify({ installed })}'`;

  it("runs plugin list --json with the environment of a chat, and gives true for an enabled tasma@tasma among other entries", async () => {
    const out = await target();
    const listed = plugins({ pluginId: "other@other", enabled: true }, { pluginId: "tasma@tasma", enabled: true });
    const { dir } = await codexRunning(recording(out, listed));

    await expect(codexAdapter.skillListed({ ...SESSION_ENV, PATH: dir, HOME: dir, CODEX_HOME: "/srv/codex" }, liveSignal())).resolves.toBe(true);

    const seen = await seenBy(out);
    expect(seen.args).toBe("plugin\nlist\n--json\n");
    expect(seen.env).toContain("CODEX_HOME=/srv/codex");
    for (const name of Object.keys(SESSION_ENV)) expect(seen.env.some((line) => line.startsWith(`${name}=`))).toBe(false);
  });

  it.each([
    ["a disabled tasma@tasma", plugins({ pluginId: "tasma@tasma", enabled: false })],
    ["no such entry", plugins({ pluginId: "other@other", enabled: true })],
    ["entries that are not objects", plugins(null, 1)],
    ["an empty list", plugins()],
  ])("gives false for %s", async (_name, script) => {
    const { dir } = await codexRunning(script);

    await expect(codexAdapter.skillListed({ PATH: dir, HOME: dir }, liveSignal())).resolves.toBe(false);
  });

  it.each([
    ["an exit code other than 0", `${plugins({ pluginId: "tasma@tasma", enabled: true })}; exit 1`],
    ["output that is not JSON", "echo 'No plugins installed'"],
    ["JSON with no installed array", "echo '{\"installed\":{}}'"],
    ["JSON that is not an object", "echo null"],
    ["a process that a signal ends", "kill -9 $$"],
  ])("gives undefined for %s", async (_name, script) => {
    const { dir } = await codexRunning(script);

    await expect(codexAdapter.skillListed({ PATH: dir, HOME: dir }, liveSignal())).resolves.toBeUndefined();
  });

  it("gives false with no codex on PATH", async () => {
    await expect(codexAdapter.skillListed({ PATH: await target() }, liveSignal())).resolves.toBe(false);
    await expect(codexAdapter.skillListed({}, liveSignal())).resolves.toBe(false);
  });

  it("gives undefined for a signal cancelled before the call, and starts no codex", async () => {
    const out = await target();
    const { dir } = await codexRunning(`: > '${out}/started'; ${plugins()}`);

    await expect(codexAdapter.skillListed({ PATH: dir, HOME: dir }, AbortSignal.abort())).resolves.toBeUndefined();
    await expect(codexAdapter.skillListed({ PATH: await target() }, AbortSignal.abort())).resolves.toBeUndefined();

    expect(existsSync(join(out, "started"))).toBe(false);
  });
});
