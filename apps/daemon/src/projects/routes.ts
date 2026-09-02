// The two routes over the project host: the tree it lists, and one project of it.

import { routes } from "@tasma/protocol";
import type { Project, ProjectSummary, Success } from "@tasma/protocol";
import type { RouteEntry } from "../http/router.js";
import type { ProjectHost } from "./host.js";

/**
 * The project routes, against the entries the contract declares. Whoever owns
 * the process passes the result to `createDaemonServer` along with the host it
 * built them over.
 */
export function projectRoutes(host: ProjectHost): RouteEntry[] {
  return [
    {
      route: routes.listProjects,
      // The listing sends no diagnostics. Findings of the configuration files it
      // read concern one project each, and each one is carried by that project's
      // own resource, where it names one file rather than arriving in a list of
      // many.
      handler: async (): Promise<Success<ProjectSummary[]>> => ({ data: await host.list(), diagnostics: [] }),
    },
    {
      route: routes.readProject,
      handler: async (request): Promise<Success<Project>> => {
        // The template is `/projects/{project}`, so the parameter carries the
        // name of the route rather than the name of what it holds. The router
        // fills every placeholder of the template it matched.
        const tag = request.params.project!;
        const { index, live } = await host.open(tag);
        const { config, diagnostics } = await index.config();
        // The engine resolves the name and the path as configuration; the wire
        // carries them as fields of the project itself.
        const { name, path, ...resolved } = config;
        return { data: { tag, name, path, config: resolved, live }, diagnostics };
      },
    },
  ];
}
