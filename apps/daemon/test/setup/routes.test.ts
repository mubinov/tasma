import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, join, relative } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentSetup, ChatAgent, SetupStatus } from "@tasma/protocol";
import type { AgentAdapter, AgentEnv, AgentLaunch, LaunchResult } from "../../src/agents/adapter.js";
import type { ShellEnv } from "../../src/agents/shell-env.js";
import { createProjectHost } from "../../src/projects/host.js";
import { createSetupChecks } from "../../src/setup/checks.js";
import type { SetupChecks } from "../../src/setup/checks.js";
import { setupRoutes } from "../../src/setup/routes.js";
import {
  failure,
  get,
  plant,
  projectConfig,
  projectsRoot,
  startTestServer,
  stillPending,
  success,
  target,
  userConfig,
} from "../helpers.js";
import type { TestServer } from "../helpers.js";

const AGENT_PATH = "/opt/agent/bin";

const DAEMON_ENV: AgentEnv = { PATH: "/usr/bin", HOME: "/home/alice" };

const LAUNCH: AgentLaunch = { command: "fake-agent", args: [], env: {} };

const NOT_RUN: Omit<AgentSetup, "agent"> = { installed: "not-run", loggedIn: "not-run", skill: "not-run" };

/** By default, an adapter whose binary is only on `AGENT_PATH` and that is logged in. */
function fakeAdapter(options: {
  agent?: ChatAgent;
  launch?: (env: AgentEnv) => LaunchResult;
  loggedIn?: (env: AgentEnv, signal: AbortSignal) => Promise<boolean | undefined>;
} = {}) {
  const launch = vi.fn(options.launch ?? ((env: AgentEnv) => (env.PATH === AGENT_PATH ? LAUNCH : { missing: "No agent binary" })));
  const loggedIn = vi.fn(options.loggedIn ?? (async () => true));
  const adapter: AgentAdapter = {
    agent: options.agent ?? "claude",
    launch,
    loggedIn,
    notLoggedIn: "Log in to the agent first",
    sessionGone: "The agent lost the chat",
    filterUpdate: (update) => update,
  };
  return { adapter, launch, loggedIn };
}

/** A shell read that gives `result`, and counts its calls. */
function shellGiving(result: ShellEnv) {
  return vi.fn<(signal: AbortSignal) => Promise<ShellEnv>>(async () => result);
}

async function serving(
  root: string,
  options: {
    adapters?: AgentAdapter[];
    env?: AgentEnv;
    shellEnv?: (signal: AbortSignal) => Promise<ShellEnv>;
  } = {},
): Promise<{ server: TestServer; checks: SetupChecks }> {
  const host = createProjectHost({ root });
  onTestFinished(() => host.close());
  const checks = createSetupChecks({
    root,
    host,
    adapters: options.adapters ?? [fakeAdapter().adapter],
    env: options.env ?? DAEMON_ENV,
    shellEnv: options.shellEnv ?? shellGiving({ env: { PATH: AGENT_PATH } }),
  });
  onTestFinished(() => checks.stop());
  return { server: await startTestServer(setupRoutes(checks)), checks };
}

async function statusOf(server: TestServer, path: string): Promise<SetupStatus> {
  const response = await get(server, path);
  expect(response.status).toBe(200);
  const { data, diagnostics } = await success<SetupStatus>(response);
  expect(diagnostics).toEqual([]);
  return data;
}

/** A tree with one project that lists a workflow. */
async function readyRoot(): Promise<string> {
  const root = await projectsRoot("ALPHA");
  await plant(projectConfig(root, "ALPHA"), "workflows: [dev]\n");
  return root;
}

/** A directory that holds an executable `tasma`. */
async function cliDir(): Promise<string> {
  const dir = await target();
  await writeFile(join(dir, "tasma"), "#!/bin/sh\n");
  await chmod(join(dir, "tasma"), 0o755);
  return dir;
}

describe("GET /setup in start mode", () => {
  it("gives fail for the project and the workflow of an empty tree, and runs no other check", async () => {
    const { adapter, launch, loggedIn } = fakeAdapter();
    const shellEnv = shellGiving({ env: { PATH: AGENT_PATH } });
    const { server } = await serving(await projectsRoot(), { adapters: [adapter], shellEnv });

    expect(await statusOf(server, "/setup")).toEqual({
      project: "fail",
      workflow: "fail",
      cli: "not-run",
      agents: [{ agent: "claude", ...NOT_RUN }],
    });
    expect(shellEnv).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(loggedIn).not.toHaveBeenCalled();
  });

  it("reads an empty mode as start mode", async () => {
    const shellEnv = shellGiving({ env: { PATH: AGENT_PATH } });
    const { server } = await serving(await readyRoot(), { shellEnv });

    expect(await statusOf(server, "/setup?mode=")).toMatchObject({ project: "pass", workflow: "pass", cli: "not-run" });
    expect(shellEnv).not.toHaveBeenCalled();
  });

  it("gives pass for a project that lists a workflow", async () => {
    const { server } = await serving(await readyRoot());

    expect(await statusOf(server, "/setup?mode=start")).toMatchObject({ project: "pass", workflow: "pass" });
  });

  it("gives fail for the workflow when no project lists one", async () => {
    const root = await projectsRoot("ALPHA", "BETA");
    await plant(projectConfig(root, "BETA"), "workflows: []\n");
    const { server } = await serving(root);

    expect(await statusOf(server, "/setup")).toMatchObject({ project: "pass", workflow: "fail" });
  });

  it("gives unknown for the project and the workflow when projects/ is a symbolic link", async () => {
    const root = await projectsRoot();
    const elsewhere = await projectsRoot("ALPHA");
    await plant(projectConfig(elsewhere, "ALPHA"), "workflows: [dev]\n");
    await symlink(join(elsewhere, "projects"), join(root, "projects"));
    const { server } = await serving(root);

    expect(await statusOf(server, "/setup")).toMatchObject({ project: "unknown", workflow: "unknown" });
  });

  it("gives unknown for the workflow when a project file cannot be read and no other project lists one", async () => {
    const root = await projectsRoot("ALPHA", "BETA");
    await plant(projectConfig(root, "ALPHA"), "workflows: [\n");
    const { server } = await serving(root);

    expect(await statusOf(server, "/setup")).toMatchObject({ project: "pass", workflow: "unknown" });
  });

  it("gives unknown for the workflow when the main configuration cannot be read", async () => {
    const root = await readyRoot();
    await plant(userConfig(root), "statuses: [\n");
    const { server } = await serving(root);

    expect(await statusOf(server, "/setup")).toMatchObject({ project: "pass", workflow: "unknown" });
  });

  it("gives pass for the workflow when a project lists one next to a project file that cannot be read", async () => {
    const root = await projectsRoot("ALPHA", "BETA");
    await plant(projectConfig(root, "ALPHA"), "workflows: [\n");
    await plant(projectConfig(root, "BETA"), "workflows: [dev]\n");
    const { server } = await serving(root);

    expect(await statusOf(server, "/setup")).toMatchObject({ project: "pass", workflow: "pass" });
  });

  it("stops at the first project that lists a workflow", async () => {
    const root = await projectsRoot("ALPHA", "BETA");
    await plant(projectConfig(root, "ALPHA"), "workflows: [dev]\n");
    await plant(projectConfig(root, "BETA"), "workflows: [\n");
    const { server } = await serving(root);

    expect(await statusOf(server, "/setup")).toMatchObject({ workflow: "pass" });
  });

  it.each(["true", "false", ""])("accepts skipSkill=%s and gives skill not-run", async (value) => {
    const { server } = await serving(await readyRoot());

    expect((await statusOf(server, `/setup?skipSkill=${value}`)).agents).toEqual([{ agent: "claude", ...NOT_RUN }]);
  });

  it("gives one entry for each adapter, in the order of the adapters", async () => {
    const adapters = [fakeAdapter({ agent: "codex" }).adapter, fakeAdapter().adapter];
    const { server } = await serving(await readyRoot(), { adapters });

    expect((await statusOf(server, "/setup")).agents.map((entry) => entry.agent)).toEqual(["codex", "claude"]);
  });
});

describe("the query of GET /setup", () => {
  it.each([
    ["an unknown key", "/setup?full=true"],
    ["a mode other than start or full", "/setup?mode=other"],
    ["a skipSkill other than true or false", "/setup?skipSkill=yes"],
  ])("refuses %s with malformed-request", async (_name, path) => {
    const { server } = await serving(await readyRoot());

    const response = await get(server, path);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });
});

describe("GET /setup in full mode", () => {
  it("runs the start-mode checks too", async () => {
    const { server } = await serving(await readyRoot());

    expect(await statusOf(server, "/setup?mode=full")).toMatchObject({ project: "pass", workflow: "pass" });
  });

  describe("cli", () => {
    it("gives pass for an executable tasma on the PATH of the login shell", async () => {
      const shellEnv = shellGiving({ env: { PATH: ["/usr/bin", await cliDir()].join(delimiter) } });
      const { server } = await serving(await readyRoot(), { shellEnv });

      expect((await statusOf(server, "/setup?mode=full")).cli).toBe("pass");
    });

    it.each([
      ["a PATH with no tasma", async () => ({ PATH: await target() })],
      ["no PATH", async () => ({})],
      ["a tasma that cannot run", async () => {
        const dir = await target();
        await writeFile(join(dir, "tasma"), "#!/bin/sh\n", { mode: 0o644 });
        return { PATH: dir };
      }],
      ["a directory named tasma", async () => {
        const dir = await target();
        await mkdir(join(dir, "tasma"));
        return { PATH: dir };
      }],
      ["a tasma in a relative directory alone", async () => ({ PATH: relative(process.cwd(), await cliDir()) })],
    ])("gives fail for %s", async (_name, envOf: () => Promise<AgentEnv>) => {
      const shellEnv = shellGiving({ env: await envOf() });
      const { server } = await serving(await readyRoot(), { shellEnv });

      expect((await statusOf(server, "/setup?mode=full")).cli).toBe("fail");
    });

    it("does not look for tasma on the PATH of the daemon", async () => {
      const shellEnv = shellGiving({ env: { PATH: await target() } });
      const { server } = await serving(await readyRoot(), { env: { PATH: await cliDir() }, shellEnv });

      expect((await statusOf(server, "/setup?mode=full")).cli).toBe("fail");
    });

    it("gives unknown when the shell read fails", async () => {
      const shellEnv = shellGiving({ failed: "the shell printed no environment" });
      const { server } = await serving(await readyRoot(), { shellEnv });

      expect((await statusOf(server, "/setup?mode=full")).cli).toBe("unknown");
    });

    it("gives unknown when the shell read rejects, and the request succeeds", async () => {
      const shellEnv = vi.fn(async (): Promise<ShellEnv> => {
        throw new Error("spawn E2BIG");
      });
      const { server } = await serving(await readyRoot(), { shellEnv });

      expect((await statusOf(server, "/setup?mode=full")).cli).toBe("unknown");
    });
  });

  describe("installed", () => {
    it("gives pass for a binary on the PATH of the daemon, and checks the login in that environment", async () => {
      const { adapter, loggedIn } = fakeAdapter();
      const env = { PATH: AGENT_PATH, HOME: "/home/alice" };
      const { server } = await serving(await readyRoot(), { adapters: [adapter], env });

      expect((await statusOf(server, "/setup?mode=full")).agents).toEqual([
        { agent: "claude", installed: "pass", loggedIn: "pass", skill: "not-run" },
      ]);
      expect(loggedIn).toHaveBeenCalledWith(env, expect.any(AbortSignal));
    });

    it("gives pass for a binary only on the PATH of the login shell, and checks the login in that environment", async () => {
      const { adapter, launch, loggedIn } = fakeAdapter();
      const shell = { PATH: AGENT_PATH, HOME: "/home/alice", SHELL: "/bin/zsh" };
      const shellEnv = shellGiving({ env: shell });
      const { server } = await serving(await readyRoot(), { adapters: [adapter], shellEnv });

      expect((await statusOf(server, "/setup?mode=full")).agents).toEqual([
        { agent: "claude", installed: "pass", loggedIn: "pass", skill: "not-run" },
      ]);
      expect(launch.mock.calls).toEqual([[DAEMON_ENV], [shell]]);
      expect(loggedIn).toHaveBeenCalledWith(shell, expect.any(AbortSignal));
    });

    it("gives pass for a launch that fails for a reason other than a missing binary", async () => {
      const { adapter } = fakeAdapter({ launch: () => ({ failed: "The agent could not start: Cannot find package" }) });
      const { server } = await serving(await readyRoot(), { adapters: [adapter] });

      expect((await statusOf(server, "/setup?mode=full")).agents[0]).toMatchObject({ installed: "pass", loggedIn: "pass" });
    });

    it("gives fail when the binary is missing in both environments, and does not check the login", async () => {
      const { adapter, loggedIn } = fakeAdapter();
      const shellEnv = shellGiving({ env: { PATH: "/usr/local/bin" } });
      const { server } = await serving(await readyRoot(), { adapters: [adapter], shellEnv });

      expect((await statusOf(server, "/setup?mode=full")).agents).toEqual([
        { agent: "claude", installed: "fail", loggedIn: "not-run", skill: "not-run" },
      ]);
      expect(loggedIn).not.toHaveBeenCalled();
    });

    it("gives unknown when the binary is missing in the daemon environment and the shell read fails", async () => {
      const { adapter, loggedIn } = fakeAdapter();
      const shellEnv = shellGiving({ failed: "the shell printed no environment" });
      const { server } = await serving(await readyRoot(), { adapters: [adapter], shellEnv });

      expect((await statusOf(server, "/setup?mode=full")).agents).toEqual([
        { agent: "claude", installed: "unknown", loggedIn: "not-run", skill: "not-run" },
      ]);
      expect(loggedIn).not.toHaveBeenCalled();
    });

    it("gives unknown when the launch throws, and does not check the login", async () => {
      const { adapter, loggedIn } = fakeAdapter({
        launch: () => {
          throw new Error("EACCES");
        },
      });
      const { server } = await serving(await readyRoot(), { adapters: [adapter] });

      expect((await statusOf(server, "/setup?mode=full")).agents).toEqual([
        { agent: "claude", installed: "unknown", loggedIn: "not-run", skill: "not-run" },
      ]);
      expect(loggedIn).not.toHaveBeenCalled();
    });
  });

  describe("loggedIn", () => {
    it.each([
      [true, "pass"],
      [false, "fail"],
      [undefined, "unknown"],
    ] as const)("gives %s from the adapter as %s", async (answer, check) => {
      const { adapter } = fakeAdapter({ loggedIn: async () => answer });
      const { server } = await serving(await readyRoot(), { adapters: [adapter] });

      expect((await statusOf(server, "/setup?mode=full")).agents[0]?.loggedIn).toBe(check);
    });

    it("gives unknown when the adapter rejects, and the request succeeds", async () => {
      const { adapter } = fakeAdapter({
        loggedIn: async () => {
          throw new Error("spawn EAGAIN");
        },
      });
      const { server } = await serving(await readyRoot(), { adapters: [adapter] });

      expect((await statusOf(server, "/setup?mode=full")).agents[0]?.loggedIn).toBe("unknown");
    });

    it("checks the agents at the same time, and keeps their order", async () => {
      const waiting: ((answer: boolean) => void)[] = [];
      const login = () => new Promise<boolean | undefined>((resolve) => waiting.push(resolve));
      const codex = fakeAdapter({ agent: "codex", loggedIn: login });
      const claude = fakeAdapter({ loggedIn: login });
      const { server } = await serving(await readyRoot(), { adapters: [codex.adapter, claude.adapter] });

      const reply = statusOf(server, "/setup?mode=full");
      await vi.waitFor(() => expect(waiting).toHaveLength(2));
      waiting[1]?.(false);
      waiting[0]?.(true);

      expect((await reply).agents).toEqual([
        { agent: "codex", installed: "pass", loggedIn: "pass", skill: "not-run" },
        { agent: "claude", installed: "pass", loggedIn: "fail", skill: "not-run" },
      ]);
    });
  });

  describe("the shell read", () => {
    it("is shared by requests at the same time", async () => {
      let release: ((result: ShellEnv) => void) | undefined;
      const shellEnv = vi.fn(() => new Promise<ShellEnv>((resolve) => (release = resolve)));
      const { server } = await serving(await readyRoot(), { shellEnv });

      const first = statusOf(server, "/setup?mode=full");
      const second = statusOf(server, "/setup?mode=full");
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(await stillPending(Promise.all([first, second]))).toBe(true);
      release?.({ env: { PATH: AGENT_PATH } });

      expect((await first).agents[0]?.installed).toBe("pass");
      expect((await second).agents[0]?.installed).toBe("pass");
      expect(shellEnv).toHaveBeenCalledTimes(1);
    });

    it("runs again for a request after the read ended", async () => {
      const shellEnv = shellGiving({ env: { PATH: AGENT_PATH } });
      const { server } = await serving(await readyRoot(), { shellEnv });

      await statusOf(server, "/setup?mode=full");
      await statusOf(server, "/setup?mode=full");

      expect(shellEnv).toHaveBeenCalledTimes(2);
    });

    it("ends with stop(), and the request gives unknown for cli", async () => {
      const shellEnv = vi.fn((signal: AbortSignal) => new Promise<ShellEnv>((resolve) => {
        signal.addEventListener("abort", () => resolve({ failed: "the daemon is stopping" }), { once: true });
      }));
      const { adapter, loggedIn } = fakeAdapter();
      const { server, checks } = await serving(await readyRoot(), { adapters: [adapter], shellEnv });

      const reply = statusOf(server, "/setup?mode=full");
      await vi.waitFor(() => expect(shellEnv).toHaveBeenCalledTimes(1));
      checks.stop();

      expect(await reply).toEqual({
        project: "pass",
        workflow: "pass",
        cli: "unknown",
        agents: [{ agent: "claude", installed: "unknown", loggedIn: "not-run", skill: "not-run" }],
      });
      expect(loggedIn).not.toHaveBeenCalled();
    });

    it("gives the signal of stop() to the login check", async () => {
      const { adapter, loggedIn } = fakeAdapter({
        loggedIn: (_env, signal) => new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
      });
      const { server, checks } = await serving(await readyRoot(), { adapters: [adapter], env: { PATH: AGENT_PATH } });

      const reply = statusOf(server, "/setup?mode=full");
      await vi.waitFor(() => expect(loggedIn).toHaveBeenCalledTimes(1));
      checks.stop();

      expect((await reply).agents[0]?.loggedIn).toBe("unknown");
    });
  });
});
