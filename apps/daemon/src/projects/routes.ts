// The routes over the project host: the tree it lists, and the create, the read,
// the write and the delete of one project of it.

import { pathMissing } from "@tasma/engine";
import { routes } from "@tasma/protocol";
import type { Project, ProjectChange, ProjectInput, ProjectSummary, Success } from "@tasma/protocol";
import type { RouteEntry } from "../http/router.js";
import { assertNoQuery } from "../tasks/filter.js";
import { toChange } from "../tasks/input.js";
import { WriteQueue } from "../tasks/serialize.js";
import type { ProjectHost } from "./host.js";

/**
 * One project as every route that answers with one carries it: what the index
 * holds, plus the finding that the folder the project stands for is gone.
 *
 * The path it checks is the one the reply carries, the resolved one, so the
 * finding and the field agree.
 */
async function readOne(host: ProjectHost, tag: string): Promise<Success<Project>> {
  const { index, live } = await host.open(tag);
  const { config, diagnostics } = await index.config();
  // The engine resolves the name and the path as configuration; the wire carries
  // them as fields of the project itself.
  const { name, path, ...resolved } = config;
  const missing = path === undefined ? undefined : await pathMissing(path);
  return {
    data: { tag, name, path, config: resolved, live },
    diagnostics: missing === undefined ? diagnostics : [...diagnostics, missing],
  };
}

/**
 * The project routes, against the entries the contract declares. Whoever owns
 * the process passes the result to `createDaemonServer` along with the host it
 * built them over.
 *
 * The queue is built here and keyed by the tag alone, so a patch and a delete of
 * one project take turns: a patch behind a delete answers 404 rather than a raw
 * filesystem fault from a directory that went under its write. A create takes no
 * turn, because the engine's exclusive create of the directory orders creates.
 */
export function projectRoutes(host: ProjectHost): RouteEntry[] {
  const writes = new WriteQueue();

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
      route: routes.createProject,
      handler: async (request): Promise<Success<Project>> => {
        assertNoQuery(request.query);
        // The engine checks every key and every value of a project write at run
        // time, so the wire type is a promise it enforces rather than one the
        // daemon has to.
        const input = toChange(request.body) as ProjectInput;
        return readOne(host, await host.create(input));
      },
    },
    {
      route: routes.readProject,
      handler: async (request): Promise<Success<Project>> => {
        // The template is `/projects/{project}`, so the parameter carries the
        // name of the route rather than the name of what it holds. The router
        // fills every placeholder of the template it matched.
        return readOne(host, request.params.project!);
      },
    },
    {
      route: routes.updateProject,
      handler: async (request): Promise<Success<Project>> => {
        assertNoQuery(request.query);
        const tag = request.params.project!;
        const change = toChange(request.body) as ProjectChange;
        // The read is inside the turn, not after it: a delete waiting behind
        // this patch starts the moment the turn ends, and a read left outside
        // would answer 404 for a project this very request wrote.
        return writes.run(tag, async () => {
          await host.update(tag, change);
          return readOne(host, tag);
        });
      },
    },
    {
      route: routes.deleteProject,
      handler: async (request): Promise<Success<ProjectSummary>> => {
        assertNoQuery(request.query);
        const tag = request.params.project!;
        return { data: await writes.run(tag, () => host.remove(tag)), diagnostics: [] };
      },
    },
  ];
}
