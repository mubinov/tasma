// The route over the setup state: the checks in the mode that the query asks for.

import { routes } from "@tasma/protocol";
import type { SetupStatus, Success } from "@tasma/protocol";
import type { RouteEntry } from "../http/router.js";
import { readSetupQuery } from "../tasks/filter.js";
import type { SetupChecks } from "./checks.js";

export function setupRoutes(checks: SetupChecks): RouteEntry[] {
  return [
    {
      route: routes.readSetup,
      handler: async (request): Promise<Success<SetupStatus>> => {
        const { mode, skipSkill } = readSetupQuery(request.query);
        return { data: await checks.status({ full: mode === "full", skipSkill }), diagnostics: [] };
      },
    },
  ];
}
