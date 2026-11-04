// The routes over the setup state: the checks in the mode that the query asks
// for, and the install of the skill.

import { routes } from "@tasma/protocol";
import type { SetupStatus, SkillInstall, Success } from "@tasma/protocol";
import { DaemonError } from "../http/failure.js";
import type { RouteEntry } from "../http/router.js";
import { assertNoQuery, readSetupQuery } from "../tasks/filter.js";
import type { SetupChecks } from "./checks.js";
import type { SkillInstaller } from "./skill-install.js";

/** The `run` of the body. An empty body counts as `{}`. */
function runOf(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DaemonError("malformed-request", "the request body must be a JSON object");
  }
  if (Object.keys(body).some((key) => key !== "run")) {
    throw new DaemonError("malformed-request", 'the request body takes only the key "run"');
  }
  const { run } = body as { run?: unknown };
  if (run !== undefined && typeof run !== "string") throw new DaemonError("malformed-request", '"run" takes a string');
  return run;
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
        return { data: await installer.install(runOf(request.body)), diagnostics: [] };
      },
    },
  ];
}
