import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentSetup, ChatAgent, SetupStatus, SkillInstall } from "@tasma/protocol";
import type { AgentAdapter, AgentEnv, AgentLaunch, LaunchResult } from "../../src/agents/adapter.js";
import type { ShellEnv } from "../../src/agents/shell-env.js";
import { createProjectHost } from "../../src/projects/host.js";
import { createSetupChecks } from "../../src/setup/checks.js";
import type { SetupChecks } from "../../src/setup/checks.js";
import { setupRoutes } from "../../src/setup/routes.js";
import type { SkillInstaller } from "../../src/setup/skill-install.js";
import {
  failure,
  get,
  plant,
  projectConfig,
  projectsRoot,
  send,
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

const NOT_RUN: Omit<AgentSetup, "agent" | "skill"> = { installed: "not-run", loggedIn: "not-run" };

/**
 * By default, an adapter whose binary is only on `AGENT_PATH`, that is logged
 * in, and whose skill path holds a file: this test file.
 */
function fakeAdapter(options: {
  agent?: ChatAgent;
  launch?: (env: AgentEnv) => LaunchResult;
  loggedIn?: (env: AgentEnv, signal: AbortSignal) => Promise<boolean | undefined>;
  skillFiles?: (env: AgentEnv) => string[];
  skillListed?: (env: AgentEnv, signal: AbortSignal) => Promise<boolean | undefined>;
} = {}) {
  const launch = vi.fn(options.launch ?? ((env: AgentEnv) => (env.PATH === AGENT_PATH ? LAUNCH : { missing: "No agent binary" })));
  const loggedIn = vi.fn(options.loggedIn ?? (async () => true));
  const skillFiles = vi.fn(options.skillFiles ?? (() => [fileURLToPath(import.meta.url)]));
  const skillListed = vi.fn(options.skillListed ?? (async () => false));
  const adapter: AgentAdapter = {
    agent: options.agent ?? "claude",
    launch,
    loggedIn,
    skillFiles,
    skillListed,
    skillsAgent: "fake-agent",
    notLoggedIn: "Log in to the agent first",
    sessionGone: "The agent lost the chat",
    filterUpdate: (update) => update,
  };
  return { adapter, launch, loggedIn, skillFiles, skillListed };
}

/** A shell read that gives `result`, and counts its calls. */
function shellGiving(result: ShellEnv) {
  return vi.fn<(signal: AbortSignal) => Promise<ShellEnv>>(async () => result);
}

/** An installer that answers `installed`, and records the run of each call. */
function fakeInstaller() {
  const install = vi.fn<(run?: string) => Promise<SkillInstall>>(async () => ({ result: "installed" }));
  const installer: SkillInstaller = { install, stop: vi.fn() };
  return { installer, install };
}

async function serving(
  root: string,
  options: {
    adapters?: AgentAdapter[];
    env?: AgentEnv;
    shellEnv?: (signal: AbortSignal) => Promise<ShellEnv>;
    installer?: SkillInstaller;
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
  const installer = options.installer ?? fakeInstaller().installer;
  return { server: await startTestServer(setupRoutes(checks, installer)), checks };
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
  it("gives fail for the project and the workflow of an empty tree, and checks only the skill of the agent", async () => {
    const { adapter, launch, loggedIn } = fakeAdapter();
    const shellEnv = shellGiving({ env: { PATH: AGENT_PATH } });
    const { server } = await serving(await projectsRoot(), { adapters: [adapter], shellEnv });

    expect(await statusOf(server, "/setup")).toEqual({
      project: "fail",
      workflow: "fail",
      cli: "not-run",
      agents: [{ agent: "claude", ...NOT_RUN, skill: "pass" }],
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

  it("accepts skipSkill=true and gives skill not-run", async () => {
    const { server } = await serving(await readyRoot());

    expect((await statusOf(server, "/setup?skipSkill=true")).agents).toEqual([{ agent: "claude", ...NOT_RUN, skill: "not-run" }]);
  });

  it.each(["false", ""])("accepts skipSkill=%s and runs the skill check", async (value) => {
    const { server } = await serving(await readyRoot());

    expect((await statusOf(server, `/setup?skipSkill=${value}`)).agents).toEqual([{ agent: "claude", ...NOT_RUN, skill: "pass" }]);
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
        { agent: "claude", installed: "pass", loggedIn: "pass", skill: "pass" },
      ]);
      expect(loggedIn).toHaveBeenCalledWith(env, expect.any(AbortSignal));
    });

    it("gives pass for a binary only on the PATH of the login shell, and checks the login in that environment", async () => {
      const { adapter, launch, loggedIn } = fakeAdapter();
      const shell = { PATH: AGENT_PATH, HOME: "/home/alice", SHELL: "/bin/zsh" };
      const shellEnv = shellGiving({ env: shell });
      const { server } = await serving(await readyRoot(), { adapters: [adapter], shellEnv });

      expect((await statusOf(server, "/setup?mode=full")).agents).toEqual([
        { agent: "claude", installed: "pass", loggedIn: "pass", skill: "pass" },
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
        { agent: "claude", installed: "fail", loggedIn: "not-run", skill: "pass" },
      ]);
      expect(loggedIn).not.toHaveBeenCalled();
    });

    it("gives unknown when the binary is missing in the daemon environment and the shell read fails", async () => {
      const { adapter, loggedIn } = fakeAdapter();
      const shellEnv = shellGiving({ failed: "the shell printed no environment" });
      const { server } = await serving(await readyRoot(), { adapters: [adapter], shellEnv });

      expect((await statusOf(server, "/setup?mode=full")).agents).toEqual([
        { agent: "claude", installed: "unknown", loggedIn: "not-run", skill: "pass" },
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
        { agent: "claude", installed: "unknown", loggedIn: "not-run", skill: "pass" },
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
        { agent: "codex", installed: "pass", loggedIn: "pass", skill: "pass" },
        { agent: "claude", installed: "pass", loggedIn: "fail", skill: "pass" },
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
        agents: [{ agent: "claude", installed: "unknown", loggedIn: "not-run", skill: "pass" }],
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

describe("the skill check of GET /setup", () => {
  const SHELL_ENV: AgentEnv = { PATH: "/usr/local/bin", HOME: "/home/alice", CLAUDE_CONFIG_DIR: "/srv/agent" };

  /** A path in a new folder, with nothing at it. */
  async function freePath(): Promise<string> {
    return join(await target(), "SKILL.md");
  }

  async function plantedSkill(): Promise<string> {
    const path = await freePath();
    await writeFile(path, "");
    return path;
  }

  /** A link to itself: its `stat` gives `ELOOP`. */
  async function loopingLink(): Promise<string> {
    const path = await freePath();
    await symlink(path, path);
    return path;
  }

  /** An adapter whose one path differs in the environment of the login shell. */
  function placedAdapter(
    paths: { daemon: string; shell: string },
    skillListed?: (env: AgentEnv, signal: AbortSignal) => Promise<boolean | undefined>,
  ) {
    return fakeAdapter({ skillFiles: (env) => [env === SHELL_ENV ? paths.shell : paths.daemon], skillListed });
  }

  async function skillOf(
    adapter: AgentAdapter,
    options: { path?: string; shellEnv?: (signal: AbortSignal) => Promise<ShellEnv> } = {},
  ): Promise<AgentSetup["skill"] | undefined> {
    const shellEnv = options.shellEnv ?? shellGiving({ env: SHELL_ENV });
    const { server } = await serving(await readyRoot(), { adapters: [adapter], shellEnv });
    return (await statusOf(server, options.path ?? "/setup")).agents[0]?.skill;
  }

  it("gives pass in start mode for a file at a path of the daemon environment, with no shell read and no skillListed", async () => {
    const skill = await plantedSkill();
    const { adapter, skillFiles, skillListed } = fakeAdapter({ skillFiles: () => [skill] });
    const shellEnv = shellGiving({ env: SHELL_ENV });

    expect(await skillOf(adapter, { shellEnv })).toBe("pass");

    expect(skillFiles.mock.calls).toEqual([[DAEMON_ENV]]);
    expect(shellEnv).not.toHaveBeenCalled();
    expect(skillListed).not.toHaveBeenCalled();
  });

  it("gives pass in full mode for a file at a path of the daemon environment, and asks only for the paths of that environment", async () => {
    const skill = await plantedSkill();
    const { adapter, skillFiles, skillListed } = fakeAdapter({ skillFiles: () => [skill] });
    const shellEnv = shellGiving({ env: SHELL_ENV });

    expect(await skillOf(adapter, { path: "/setup?mode=full", shellEnv })).toBe("pass");

    expect(skillFiles.mock.calls).toEqual([[DAEMON_ENV]]);
    expect(skillListed).not.toHaveBeenCalled();
    expect(shellEnv).toHaveBeenCalledTimes(1);
  });

  it("gives pass for a link to a file", async () => {
    const link = await freePath();
    await symlink(await plantedSkill(), link);
    const { adapter, skillListed } = fakeAdapter({ skillFiles: () => [link] });

    expect(await skillOf(adapter)).toBe("pass");
    expect(skillListed).not.toHaveBeenCalled();
  });

  it("gives pass for a file at a later path of the same environment", async () => {
    const paths = [await loopingLink(), await freePath(), await plantedSkill()];
    const { adapter, skillListed } = fakeAdapter({ skillFiles: () => paths });
    const shellEnv = shellGiving({ env: SHELL_ENV });

    expect(await skillOf(adapter, { shellEnv })).toBe("pass");

    expect(shellEnv).not.toHaveBeenCalled();
    expect(skillListed).not.toHaveBeenCalled();
  });

  it("gives not-run with skipSkill=true, and runs no part of the check", async () => {
    const { adapter, skillFiles, skillListed } = fakeAdapter();
    const shellEnv = shellGiving({ env: SHELL_ENV });

    expect(await skillOf(adapter, { path: "/setup?skipSkill=true", shellEnv })).toBe("not-run");

    expect(skillFiles).not.toHaveBeenCalled();
    expect(shellEnv).not.toHaveBeenCalled();
    expect(skillListed).not.toHaveBeenCalled();
  });

  it("runs on an empty tree too", async () => {
    const missing = await freePath();
    const { adapter } = fakeAdapter({ skillFiles: () => [missing] });
    const shellEnv = shellGiving({ env: SHELL_ENV });
    const { server } = await serving(await projectsRoot(), { adapters: [adapter], shellEnv });

    expect(await statusOf(server, "/setup")).toEqual({
      project: "fail",
      workflow: "fail",
      cli: "not-run",
      agents: [{ agent: "claude", ...NOT_RUN, skill: "fail" }],
    });
  });

  it("gives pass for a file only at a path of the login shell, with no skillListed", async () => {
    const { adapter, skillListed } = placedAdapter({ daemon: await freePath(), shell: await plantedSkill() });

    expect(await skillOf(adapter)).toBe("pass");
    expect(skillListed).not.toHaveBeenCalled();
  });

  it.each([
    [true, "pass"],
    [false, "fail"],
    [undefined, "unknown"],
  ] as const)("gives %s from skillListed as %s, and asks in the environment of the login shell", async (answer, check) => {
    const paths = { daemon: await freePath(), shell: await freePath() };
    const { adapter, skillListed } = placedAdapter(paths, async () => answer);

    expect(await skillOf(adapter)).toBe(check);
    expect(skillListed).toHaveBeenCalledWith(SHELL_ENV, expect.any(AbortSignal));
  });

  it.each([
    ["a link with no target", async () => {
      const link = await freePath();
      await symlink(await freePath(), link);
      return link;
    }],
    ["a directory named SKILL.md", async () => {
      const path = await freePath();
      await mkdir(path);
      return path;
    }],
    ["a file where a folder of the path must be", async () => join(await plantedSkill(), "SKILL.md")],
  ])("gives fail for %s", async (_name, pathOf: () => Promise<string>) => {
    const path = await pathOf();
    const { adapter } = fakeAdapter({ skillFiles: () => [path] });

    expect(await skillOf(adapter)).toBe("fail");
  });

  describe.each(["daemon", "shell"] as const)("with another stat error at the path of the %s environment", (place) => {
    async function pathsWithLoop(): Promise<{ daemon: string; shell: string }> {
      return { daemon: await freePath(), shell: await freePath(), [place]: await loopingLink() };
    }

    it("gives unknown when skillListed gives false", async () => {
      const { adapter } = placedAdapter(await pathsWithLoop());

      expect(await skillOf(adapter)).toBe("unknown");
    });

    it("gives pass when skillListed gives true", async () => {
      const { adapter } = placedAdapter(await pathsWithLoop(), async () => true);

      expect(await skillOf(adapter)).toBe("pass");
    });
  });

  it("gives pass for a file at a path of the login shell after another stat error at the path of the daemon", async () => {
    const { adapter, skillListed } = placedAdapter({ daemon: await loopingLink(), shell: await plantedSkill() });

    expect(await skillOf(adapter)).toBe("pass");
    expect(skillListed).not.toHaveBeenCalled();
  });

  it.each<[string, () => Promise<ShellEnv>]>([
    ["fails", async () => ({ failed: "the shell printed no environment" })],
    ["rejects", async () => {
      throw new Error("spawn E2BIG");
    }],
  ])("gives unknown when the shell read %s, does not call skillListed, and the request succeeds", async (_name, shellEnv) => {
    const missing = await freePath();
    const { adapter, skillListed } = fakeAdapter({ skillFiles: () => [missing] });

    expect(await skillOf(adapter, { shellEnv })).toBe("unknown");
    expect(skillListed).not.toHaveBeenCalled();
  });

  it("gives unknown when skillFiles throws, and the request succeeds", async () => {
    const { adapter } = fakeAdapter({
      skillFiles: () => {
        throw new Error("no home directory");
      },
    });

    expect(await skillOf(adapter)).toBe("unknown");
  });

  it("gives unknown when skillListed rejects, and the request succeeds", async () => {
    const paths = { daemon: await freePath(), shell: await freePath() };
    const { adapter } = placedAdapter(paths, async () => {
      throw new Error("spawn EAGAIN");
    });

    expect(await skillOf(adapter)).toBe("unknown");
  });

  it("runs when installed is fail", async () => {
    const skill = await plantedSkill();
    const { adapter } = fakeAdapter({ skillFiles: () => [skill] });
    const shellEnv = shellGiving({ env: SHELL_ENV });
    const { server } = await serving(await readyRoot(), { adapters: [adapter], shellEnv });

    expect((await statusOf(server, "/setup?mode=full")).agents).toEqual([
      { agent: "claude", installed: "fail", loggedIn: "not-run", skill: "pass" },
    ]);
  });

  it("runs at the same time as the login check", async () => {
    const missing = await freePath();
    let release: ((answer: boolean) => void) | undefined;
    const { adapter, skillListed } = fakeAdapter({
      loggedIn: () => new Promise((resolve) => (release = resolve)),
      skillFiles: () => [missing],
    });
    const env = { ...DAEMON_ENV, PATH: AGENT_PATH };
    const shellEnv = shellGiving({ env: SHELL_ENV });
    const { server } = await serving(await readyRoot(), { adapters: [adapter], env, shellEnv });

    const reply = statusOf(server, "/setup?mode=full");
    await vi.waitFor(() => expect(skillListed).toHaveBeenCalledTimes(1));
    release?.(true);

    expect((await reply).agents[0]).toMatchObject({ loggedIn: "pass", skill: "fail" });
  });

  it("reads the shell once for one full request with a skill miss and a missing binary, also when the read ends before the stat", async () => {
    const missing = await freePath();
    const { adapter } = fakeAdapter({ skillFiles: () => [missing] });
    const shellEnv = shellGiving({ env: SHELL_ENV });

    expect(await skillOf(adapter, { path: "/setup?mode=full", shellEnv })).toBe("fail");

    expect(shellEnv).toHaveBeenCalledTimes(1);
  });

  it("reads the shell again for the next request, so that nothing is kept", async () => {
    const missing = await freePath();
    const { adapter } = fakeAdapter({ skillFiles: () => [missing] });
    const shellEnv = shellGiving({ env: SHELL_ENV });
    const { server } = await serving(await readyRoot(), { adapters: [adapter], shellEnv });

    await statusOf(server, "/setup");
    await statusOf(server, "/setup");

    expect(shellEnv).toHaveBeenCalledTimes(2);
  });

  it("ends with stop() during the shell read, and gives unknown", async () => {
    const missing = await freePath();
    const { adapter, skillListed } = fakeAdapter({ skillFiles: () => [missing] });
    const shellEnv = vi.fn((signal: AbortSignal) => new Promise<ShellEnv>((resolve) => {
      signal.addEventListener("abort", () => resolve({ failed: "the daemon is stopping" }), { once: true });
    }));
    const { server, checks } = await serving(await readyRoot(), { adapters: [adapter], shellEnv });

    const reply = statusOf(server, "/setup");
    await vi.waitFor(() => expect(shellEnv).toHaveBeenCalledTimes(1));
    checks.stop();

    expect((await reply).agents[0]?.skill).toBe("unknown");
    expect(skillListed).not.toHaveBeenCalled();
  });

  it("gives the signal of stop() to skillListed", async () => {
    const missing = await freePath();
    const { adapter, skillListed } = fakeAdapter({
      skillFiles: () => [missing],
      skillListed: (_env, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
    });
    const shellEnv = shellGiving({ env: SHELL_ENV });
    const { server, checks } = await serving(await readyRoot(), { adapters: [adapter], shellEnv });

    const reply = statusOf(server, "/setup");
    await vi.waitFor(() => expect(skillListed).toHaveBeenCalledTimes(1));
    checks.stop();

    expect((await reply).agents[0]?.skill).toBe("unknown");
  });

  it("gives each adapter its own result, in the order of the adapters", async () => {
    const missing = await freePath();
    const codex = fakeAdapter({ agent: "codex", skillFiles: () => [missing] });
    const claude = fakeAdapter();
    const shellEnv = shellGiving({ env: SHELL_ENV });
    const { server } = await serving(await readyRoot(), { adapters: [codex.adapter, claude.adapter], shellEnv });

    expect((await statusOf(server, "/setup")).agents).toEqual([
      { agent: "codex", ...NOT_RUN, skill: "fail" },
      { agent: "claude", ...NOT_RUN, skill: "pass" },
    ]);
  });
});

describe("POST /setup/skill-install", () => {
  const RUN = "2f6d1c0e-8a4b-4c3d-9e7f-1a2b3c4d5e6f";

  const INSTALL_ROUTE = "/setup/skill-install";

  async function installing(answer: SkillInstall = { result: "installed" }) {
    const { installer, install } = fakeInstaller();
    install.mockResolvedValue(answer);
    const { server } = await serving(await projectsRoot(), { installer });
    return { server, install };
  }

  it.each([
    ["{}", {}, undefined],
    ["an empty body", undefined, undefined],
    ["a run", { run: RUN }, RUN],
  ])("takes %s, and gives the run to the installer", async (_name, body, run) => {
    const { server, install } = await installing();

    const response = await send(server, "POST", INSTALL_ROUTE, body);

    expect(response.status).toBe(200);
    expect(await success<SkillInstall>(response)).toEqual({ data: { result: "installed" }, diagnostics: [] });
    expect(install.mock.calls).toEqual([[run]]);
  });

  it.each<SkillInstall>([
    { result: "running", run: RUN },
    { result: "npx-missing" },
    { result: "failed", output: "Cloning failed" },
  ])("answers $result with status 200", async (answer) => {
    const { server } = await installing(answer);

    const response = await send(server, "POST", INSTALL_ROUTE, {});

    expect(response.status).toBe(200);
    expect((await success<SkillInstall>(response)).data).toEqual(answer);
  });

  it.each([
    ["a body that is not an object", ["run"]],
    ["a body of null", null],
    ["an unknown key", { run: RUN, force: true }],
    ["a run that is not a string", { run: 1 }],
    ["a run of null", { run: null }],
  ])("refuses %s with malformed-request, and starts no install", async (_name, body) => {
    const { server, install } = await installing();

    const response = await send(server, "POST", INSTALL_ROUTE, body);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
    expect(install).not.toHaveBeenCalled();
  });

  it("refuses a query with malformed-request, and starts no install", async () => {
    const { server, install } = await installing();

    const response = await send(server, "POST", `${INSTALL_ROUTE}?run=${RUN}`, {});

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
    expect(install).not.toHaveBeenCalled();
  });

  it("requires the token, and starts no install without it", async () => {
    const { server, install } = await installing();

    const response = await fetch(`${server.url}${INSTALL_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(install).not.toHaveBeenCalled();
  });
});
