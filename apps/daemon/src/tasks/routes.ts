// Every route over the tasks of one project: the five over the task itself, and
// the four over its comments.
//
// Each handler reaches its project through `host.open`, which returns an
// `IndexedProject`, so a write made through it updates the index before the call
// returns and a listing that follows sees the change without waiting for the
// watcher. The `live` flag the open returns is ignored here: `GET
// /projects/{project}` is where liveness is reported.

import { resolveBlocked } from "@tasma/engine";
import { routes } from "@tasma/protocol";
import type { Diagnostic, Success, Task, TaskList, WriteResult } from "@tasma/protocol";
import type { RouteEntry } from "../http/router.js";
import type { ProjectHost } from "../projects/host.js";
import { commentRoutes } from "./comments.js";
import { assertNoQuery, readTaskFilter, readTaskOptions, selectEntries } from "./filter.js";
import { toChange } from "./input.js";
import { createKey, taskKey, WriteQueue } from "./serialize.js";

/**
 * The task routes, against the entries the contract declares. Whoever owns the
 * process passes the result to `createDaemonServer` along with the host it built
 * them over.
 *
 * The queue is built here and shared with the comment routes, because the writes
 * it orders are the writes of one task file and three of them are comment
 * writes.
 */
export function taskRoutes(host: ProjectHost): RouteEntry[] {
  const writes = new WriteQueue();

  return [
    {
      route: routes.listTasks,
      handler: async (request): Promise<Success<TaskList>> => {
        const filter = readTaskFilter(request.query);
        const { index } = await host.open(request.params.project!);
        const { entries, excluded } = index.query();
        const diagnostics: Diagnostic[] = [];
        let blocked: ReadonlySet<string> = new Set();

        // The configuration is read only for `blocked`: it is a file read per
        // request, and `final_statuses` answers no other filter.
        if (filter.blocked !== undefined) {
          const config = await index.config();
          diagnostics.push(...config.diagnostics);
          // Resolved over the complete listing, and every finding forwarded
          // whether or not the filter kept its task: a finding says a file on
          // disk names a blocker that does not exist, which is a report about
          // the project rather than about the result set.
          const resolved = resolveBlocked(entries, config.config.final_statuses);
          diagnostics.push(...resolved.unresolved);
          blocked = resolved.blocked;
        }

        return { data: { entries: selectEntries(entries, filter, blocked), excluded }, diagnostics };
      },
    },
    {
      route: routes.createTask,
      handler: async (request): Promise<Success<WriteResult>> => {
        assertNoQuery(request.query);
        const project = request.params.project!;
        const change = toChange(request.body);
        const { index } = await host.open(project);
        const write = () => index.createTask(change);
        const { diagnostics, ...data } = await writes.run(createKey(project), write);
        return { data, diagnostics };
      },
    },
    {
      route: routes.readTask,
      handler: async (request): Promise<Success<Task>> => {
        const options = readTaskOptions(request.query);
        const { index } = await host.open(request.params.project!);
        // Nothing strips the engine's source regions: they are held under a
        // symbol key, which `JSON.stringify` drops.
        const { task, diagnostics } = await index.readTask(request.params.id!);
        if (options.comments === false) {
          // The one field the option drops, removed from a copy of the task
          // rather than a shape rebuilt field by field: a field added to a task
          // then reaches this route as it reaches the whole read.
          const trimmed: Task = { ...task };
          delete trimmed.comments;
          return { data: trimmed, diagnostics };
        }
        return { data: task, diagnostics };
      },
    },
    {
      route: routes.updateTask,
      handler: async (request): Promise<Success<WriteResult>> => {
        assertNoQuery(request.query);
        const project = request.params.project!;
        const id = request.params.id!;
        const change = toChange(request.body);
        const { index } = await host.open(project);
        const { diagnostics, ...data } = await writes.run(taskKey(project, id), () => index.updateTask(id, change));
        return { data, diagnostics };
      },
    },
    {
      route: routes.deleteTask,
      handler: async (request): Promise<Success<WriteResult>> => {
        assertNoQuery(request.query);
        const project = request.params.project!;
        const id = request.params.id!;
        const { index } = await host.open(project);
        const { diagnostics, ...data } = await writes.run(taskKey(project, id), () => index.deleteTask(id));
        return { data, diagnostics };
      },
    },
    ...commentRoutes(host, writes),
  ];
}
