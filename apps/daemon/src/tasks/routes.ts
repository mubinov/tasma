// Every route over the tasks of one project: the six over the task itself, and
// the four over its comments.
//
// Each handler reaches its project through `host.open`, which returns an
// `IndexedProject`, so a write made through it updates the index before the call
// returns and a listing that follows sees the change without waiting for the
// watcher. The `live` flag the open returns is ignored here: the project
// resource is where liveness is reported.

import { resolveBlocked } from "@tasma/engine";
import { routes } from "@tasma/protocol";
import type { Success, Task, TaskList, TaskText, WriteResult } from "@tasma/protocol";
import type { ChatRegistry } from "../chats/registry.js";
import type { RouteEntry } from "../http/router.js";
import type { ProjectHost } from "../projects/host.js";
import { commentRoutes } from "./comments.js";
import { assertNoQuery, readTaskFilter, readTaskOptions, readTextSelection, selectEntries } from "./filter.js";
import { toChange } from "./input.js";
import { searchEntries, words } from "./search.js";
import { blockerKeys, createKey, parentKeys, taskKey, WriteQueue } from "./serialize.js";

/**
 * The task routes, against the entries the contract declares. Whoever owns the
 * process passes the result to `createDaemonServer` along with the host it built
 * them over.
 *
 * The queue is shared with the comment routes, because the writes it orders are
 * the writes of one task file and three of them are comment writes. The daemon
 * passes its one queue, which the chat writes of a task share; without one the
 * routes build their own. A delete of a task tells the chat registry inside its
 * turn.
 */
export function taskRoutes(host: ProjectHost, options?: { writes?: WriteQueue; chats?: ChatRegistry }): RouteEntry[] {
  const writes = options?.writes ?? new WriteQueue();
  const chats = options?.chats;

  return [
    {
      route: routes.listTasks,
      handler: async (request): Promise<Success<TaskList>> => {
        const filter = readTaskFilter(request.query);
        const { index } = await host.open(request.params.project!);
        const { entries, excluded } = index.query();
        const config = await index.config();
        // Resolved over the complete listing, and every finding forwarded
        // whether or not the filter kept its task: a finding says a file on
        // disk names a blocker that does not exist, which is a report about
        // the project rather than about the result set.
        const resolved = resolveBlocked(entries, config.config.final_statuses);
        const selected = selectEntries(resolved.entries, filter);
        const terms = words(filter.q);
        const listed = terms.length === 0 ? selected : await searchEntries(index, selected, terms);
        return {
          data: { entries: listed, excluded },
          diagnostics: [...config.diagnostics, ...resolved.unresolved],
        };
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
        const listed = () => index.query().entries;
        const keys = [
          createKey(project),
          ...blockerKeys(project, change, listed),
          ...parentKeys(project, change, listed),
        ];
        const { diagnostics, ...data } = await writes.runAll(keys, write);
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
      route: routes.readTaskText,
      handler: async (request): Promise<Success<TaskText>> => {
        const selection = readTextSelection(request.query);
        const { index } = await host.open(request.params.project!);
        const { diagnostics, ...data } = await index.readTaskText(request.params.id!, selection);
        return { data, diagnostics };
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
        const listed = () => index.query().entries;
        const keys = [
          taskKey(project, id),
          ...blockerKeys(project, change, listed),
          ...parentKeys(project, change, listed),
        ];
        const { diagnostics, ...data } = await writes.runAll(keys, () => index.updateTask(id, change));
        return { data, diagnostics };
      },
    },
    {
      route: routes.deleteTask,
      handler: async (request): Promise<Success<WriteResult>> => {
        assertNoQuery(request.query);
        const project = request.params.project!;
        const id = request.params.id!;
        let references = (await host.open(project)).index.referencesTo(id);
        // The delete rewrites every task that names the deleted one, so it takes
        // the turn of each of them too. It takes the turn of the project as
        // well: a rename publishes the new tag before it moves the chats.
        for (;;) {
          const covered = references;
          const keys = [project, ...[id, ...covered].map((ref) => taskKey(project, ref))];
          const outcome = await writes.runAll(keys, async () => {
            // Opened again: a rename or a delete of the project that this turn
            // waited for closed the first index, and a tag that is gone is a 404.
            const { index } = await host.open(project);
            // The turns are taken one by one, so a task can come to name the
            // deleted one while the delete waits, and its turn is not held.
            const now = index.referencesTo(id);
            if (now.some((ref) => !covered.includes(ref))) return { references: now };
            const deleted = await index.deleteTask(id);
            chats?.taskRemoved(project, id);
            return { deleted };
          });
          if (outcome.deleted !== undefined) {
            const { diagnostics, ...data } = outcome.deleted;
            return { data, diagnostics };
          }
          references = outcome.references;
        }
      },
    },
    ...commentRoutes(host, writes),
  ];
}
