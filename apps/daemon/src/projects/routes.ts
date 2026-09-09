// The routes over the project host: the tree it lists, the create, the read, the
// write, the rename and the delete of one project of it, and the resolution,
// which is the one route that reads the tree backwards, from a directory to the
// project that holds it.

import { pathMissing } from "@tasma/engine";
import { routes } from "@tasma/protocol";
import type { Project, ProjectChange, ProjectInput, ProjectRename, ProjectSummary, Success } from "@tasma/protocol";
import type { RouteEntry } from "../http/router.js";
import { assertNoQuery, readProjectQuery } from "../tasks/filter.js";
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
 * The queue is built here and keyed by the tag alone, so a patch, a rename and a
 * delete of one project take turns: a patch behind a delete answers 404 rather
 * than a raw filesystem fault from a directory that went under its write. A
 * rename takes the turn of both tags it names, so a write of either of them
 * waits for the whole of it. A create takes no turn, because the engine's
 * exclusive create of the directory orders creates.
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
      handler: async (request): Promise<Success<ProjectSummary[]>> => {
        assertNoQuery(request.query);
        return { data: await host.list(), diagnostics: [] };
      },
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
        assertNoQuery(request.query);
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
    {
      route: routes.renameProject,
      handler: async (request): Promise<Success<Project>> => {
        assertNoQuery(request.query);
        const tag = request.params.project!;
        const body = toChange(request.body);
        // Read before the cast: the wire type states a string and nothing has
        // checked one yet, which is the engine's own work.
        const statedTag: unknown = body.tag;
        const rename = body as ProjectRename;
        // The turn of both tags, so a patch or a delete of either waits until
        // the rename is complete, the reconcile included: that is what makes the
        // reconcile's copy of `config.yml` safe against a patch of the new
        // project. A tag that is no string names no turn; the engine refuses it.
        const keys = typeof statedTag === "string" ? [tag, statedTag] : [tag];
        return writes.runAll(keys, async () => {
          const findings = await host.rename(tag, rename);
          // Read inside the turn, for the reason the patch reads inside its own.
          const answer = await readOne(host, rename.tag);
          return { data: answer.data, diagnostics: [...answer.diagnostics, ...findings] };
        });
      },
    },
    {
      route: routes.resolveProject,
      // The resolution does send its diagnostics, against the rule the listing
      // above states. A project the comparison could not read can change the
      // answer this route gives, which is not true of a row a listing leaves
      // incomplete, so the caller has to be told rather than the project's own
      // resource.
      handler: async (request): Promise<Success<ProjectSummary | null>> => {
        const { project, diagnostics } = await host.locate(readProjectQuery(request.query));
        // `JSON.stringify` drops a key holding `undefined` and the client admits
        // a success by testing that `data` is there, so the answer no project
        // holds has to carry the key.
        return { data: project ?? null, diagnostics };
      },
    },
  ];
}
