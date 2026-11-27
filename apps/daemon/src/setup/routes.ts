// The routes over the setup state: the checks in the mode that the query asks
// for, and the install of the skill.

import { AGENT_OPTION_RULES, routes } from "@tasma/protocol";
import type { ChatAgent, SetupStatus, SkillInstall, SkillInstallRequest, Success } from "@tasma/protocol";
import { DaemonError } from "../http/failure.js";
import type { RouteEntry } from "../http/router.js";
import { assertNoQuery, readSetupQuery } from "../tasks/filter.js";
import type { SetupChecks } from "./checks.js";
import type { SkillInstaller } from "./skill-install.js";

function malformed(message: string): DaemonError {
  return new DaemonError("malformed-request", message);
}

function agentsOf(value: unknown): ChatAgent[] {
  if (!Array.isArray(value) || value.length === 0) throw malformed('"agents" takes an array that is not empty');
  for (const [index, agent] of value.entries()) {
    if (typeof agent !== "string" || !Object.hasOwn(AGENT_OPTION_RULES, agent)) {
      throw malformed(`"agents" names no known agent at ${String(index)}`);
    }
    if (value.indexOf(agent) !== index) throw malformed(`"agents" names ${agent} more than once`);
  }
  return value as ChatAgent[];
}

function installRequestOf(body: unknown): SkillInstallRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw malformed("the request body must be a JSON object");
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || (keys[0] !== "agents" && keys[0] !== "run")) {
    throw malformed('the request body takes exactly one of the keys "agents" and "run"');
  }
  const { agents, run } = body as { agents?: unknown; run?: unknown };
  if (keys[0] === "agents") return { agents: agentsOf(agents) };
  if (typeof run !== "string") throw malformed('"run" takes a string');
  return { run };
}

export function setupRoutes(checks: SetupChecks, installer: SkillInstaller): RouteEntry[] {
  return [
    {
      route: routes.readSetup,
      handler: async (request): Promise<Success<SetupStatus>> => {
        const { mode, skipSkill } = readSetupQuery(request.query);
        return { data: await checks.status({ full: mode === "full", skipSkill }), diagnostics: [] };
      },
    },
    {
      route: routes.installSkill,
      handler: async (request): Promise<Success<SkillInstall>> => {
        assertNoQuery(request.query);
        return { data: await installer.install(installRequestOf(request.body)), diagnostics: [] };
      },
    },
  ];
}
