// Whether the setup of Tasma on this machine is complete. Start mode reads the
// tree and looks for the skill, and runs a process only when the skill is not
// in a fixed path; full mode also reads the login shell and asks each agent.

import { stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { openProject } from "@tasma/engine";
import type { AgentSetup, SetupCheck, SetupStatus } from "@tasma/protocol";
import type { AgentAdapter, AgentEnv } from "../agents/adapter.js";
import { isExecutableFile } from "../agents/process.js";
import { readShellEnv } from "../agents/shell-env.js";
import type { ShellEnv } from "../agents/shell-env.js";
import { causeOf } from "../http/failure.js";
import type { ProjectHost } from "../projects/host.js";

export type SetupOptions = { full: boolean; skipSkill: boolean };

export type SetupChecks = {
  /** Never rejects: a check that fails gives `fail` or `unknown`. */
  status(options: SetupOptions): Promise<SetupStatus>;
  /** Ends the shell reads and the agent checks that run, so a request does not hold the daemon stop. */
  stop(): void;
};

type Installed = { check: "pass"; env: AgentEnv } | { check: "fail" | "unknown" | "not-run" };

type SkillFile = "found" | "missing" | "unread";

/** The tags of the tree, or `undefined` when the tree cannot be read. */
async function readTags(host: ProjectHost): Promise<string[] | undefined> {
  try {
    return await host.tags();
  } catch {
    return undefined;
  }
}

function projectCheck(tags: string[] | undefined): SetupCheck {
  if (tags === undefined) return "unknown";
  return tags.length > 0 ? "pass" : "fail";
}

/** Reads one project at a time, and stops at the first that lists a workflow. */
async function workflowCheck(root: string | undefined, tags: string[] | undefined): Promise<SetupCheck> {
  if (tags === undefined) return "unknown";
  let unread = false;
  for (const tag of tags) {
    try {
      const { config } = await openProject({ project: tag, root }).config();
      if (config.workflows.length > 0) return "pass";
    } catch {
      unread = true;
    }
  }
  return unread ? "unknown" : "fail";
}

/** Does not confirm that the `tasma` found is the Tasma CLI. */
function cliCheck(shell: ShellEnv): SetupCheck {
  if ("failed" in shell) return "unknown";
  const dirs = (shell.env.PATH ?? "").split(delimiter).filter((dir) => isAbsolute(dir));
  return dirs.some((dir) => isExecutableFile(join(dir, "tasma"))) ? "pass" : "fail";
}

/**
 * The search of a chat start: the environment of the daemon, then the login
 * shell. A `failed` launch passes, because the binary is there.
 */
async function installedCheck(
  adapter: AgentAdapter,
  env: AgentEnv,
  shell: () => Promise<ShellEnv>,
): Promise<Installed> {
  try {
    if (!("missing" in adapter.launch(env))) return { check: "pass", env };
    const read = await shell();
    if ("failed" in read) return { check: "unknown" };
    if (!("missing" in adapter.launch(read.env))) return { check: "pass", env: read.env };
    return { check: "fail" };
  } catch {
    return { check: "unknown" };
  }
}

async function loggedInCheck(adapter: AgentAdapter, installed: Installed, signal: AbortSignal): Promise<SetupCheck> {
  if (installed.check !== "pass") return "not-run";
  try {
    const answer = await adapter.loggedIn(installed.env, signal);
    if (answer === undefined) return "unknown";
    return answer ? "pass" : "fail";
  } catch {
    return "unknown";
  }
}

export async function skillFileIn(paths: string[]): Promise<SkillFile> {
  let unread = false;
  for (const path of paths) {
    try {
      if ((await stat(path)).isFile()) return "found";
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code !== "ENOENT" && code !== "ENOTDIR") unread = true;
    }
  }
  return unread ? "unread" : "missing";
}

/** A path that could not be read makes a miss `unknown`, not `fail`. */
async function skillCheck(
  adapter: AgentAdapter,
  env: AgentEnv,
  shell: () => Promise<ShellEnv>,
  signal: AbortSignal,
): Promise<SetupCheck> {
  try {
    const inDaemon = await skillFileIn(adapter.skillFiles(env));
    if (inDaemon === "found") return "pass";
    const read = await shell();
    if ("failed" in read) return "unknown";
    const inShell = await skillFileIn(adapter.skillFiles(read.env));
    if (inShell === "found") return "pass";
    const listed = await adapter.skillListed(read.env, signal);
    if (listed === undefined) return "unknown";
    if (listed) return "pass";
    return inDaemon === "unread" || inShell === "unread" ? "unknown" : "fail";
  } catch {
    return "unknown";
  }
}

export function createSetupChecks(options: {
  root?: string;
  host: ProjectHost;
  adapters: readonly AgentAdapter[];
  /** The environment of the daemon, the one each chat launch starts from. */
  env: AgentEnv;
  shellEnv?: (signal: AbortSignal) => Promise<ShellEnv>;
}): SetupChecks {
  const { root, host, adapters, env } = options;
  const shellEnv = options.shellEnv ?? ((signal) => readShellEnv(env, { signal }));
  const stopping = new AbortController();
  /** The shell read that the requests of this moment share. Nothing is kept after it ends. */
  let reading: Promise<ShellEnv> | undefined;

  async function readShell(): Promise<ShellEnv> {
    try {
      return await shellEnv(stopping.signal);
    } catch (error) {
      return { failed: causeOf(error) };
    }
  }

  function shell(): Promise<ShellEnv> {
    reading ??= readShell().finally(() => (reading = undefined));
    return reading;
  }

  async function startChecks(): Promise<Pick<SetupStatus, "project" | "workflow">> {
    const tags = await readTags(host);
    return { project: projectCheck(tags), workflow: await workflowCheck(root, tags) };
  }

  async function installAndLoginChecks(
    adapter: AgentAdapter,
    full: boolean,
    requestShell: () => Promise<ShellEnv>,
  ): Promise<Pick<AgentSetup, "installed" | "loggedIn">> {
    const installed: Installed = full ? await installedCheck(adapter, env, requestShell) : { check: "not-run" };
    return { installed: installed.check, loggedIn: await loggedInCheck(adapter, installed, stopping.signal) };
  }

  async function agentCheck(
    adapter: AgentAdapter,
    asked: SetupOptions,
    requestShell: () => Promise<ShellEnv>,
  ): Promise<AgentSetup> {
    const [installAndLogin, skill] = await Promise.all([
      installAndLoginChecks(adapter, asked.full, requestShell),
      asked.skipSkill ? ("not-run" as const) : skillCheck(adapter, env, requestShell, stopping.signal),
    ]);
    return { agent: adapter.agent, ...installAndLogin, skill };
  }

  return {
    async status(asked) {
      // A slow `stat` can ask for the shell after the read of `cli` ended: one request reads it once.
      let requestRead: Promise<ShellEnv> | undefined;
      const requestShell = () => (requestRead ??= shell());
      const [start, cli, agents] = await Promise.all([
        startChecks(),
        asked.full ? requestShell().then(cliCheck) : ("not-run" as const),
        Promise.all(adapters.map((adapter) => agentCheck(adapter, asked, requestShell))),
      ]);
      return { ...start, cli, agents };
    },

    stop() {
      stopping.abort();
    },
  };
}
