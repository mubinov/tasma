import { queryOptions } from "@tanstack/react-query";
import { buildPath, ProtocolError, routes, type Client, type Success, type Workflow } from "@tasma/protocol";

export const POLL_INTERVAL = 5_000;

/**
 * Two properties a new key has to keep: every key descends from `all`, so one
 * prefix invalidation drops everything the daemon said, and keys nest the way
 * the routes nest, so a write to one project leaves every other project's cache
 * intact.
 */
export const daemonKeys = {
  all: ["daemon"] as const,
  health: () => [...daemonKeys.all, "health"] as const,
  projects: () => [...daemonKeys.all, "projects"] as const,
  project: (tag: string) => [...daemonKeys.projects(), tag] as const,
  tasks: (tag: string) => [...daemonKeys.project(tag), "tasks"] as const,
  task: (tag: string, id: string) => [...daemonKeys.tasks(tag), id] as const,
  workflows: () => [...daemonKeys.all, "workflows"] as const,
  workflow: (name: string) => [...daemonKeys.workflows(), name] as const,
};

/**
 * The query function returns the whole `Success<T>`: unwrapping to `.data` here
 * would drop the diagnostics, the only signal a hand edit changed a file.
 */
export function healthQuery(client: Client) {
  return queryOptions({
    queryKey: daemonKeys.health(),
    queryFn: () => client.readHealth(),
  });
}

export function projectsQuery(client: Client) {
  return queryOptions({
    queryKey: daemonKeys.projects(),
    queryFn: () => client.listProjects(),
  });
}

export function projectQuery(client: Client, tag: string) {
  return queryOptions({
    queryKey: daemonKeys.project(tag),
    queryFn: () => client.readProject(tag),
  });
}

export function tasksQuery(client: Client, tag: string) {
  return queryOptions({
    queryKey: daemonKeys.tasks(tag),
    queryFn: () => client.listTasks(tag),
  });
}

export function taskQuery(client: Client, tag: string, id: string) {
  return queryOptions({
    queryKey: daemonKeys.task(tag, id),
    queryFn: () => client.readTask(tag, id),
  });
}

/**
 * Answers `null`, with no request, for a name no URL segment can carry: a task
 * file names its workflow as free text, and the client throws a plain `Error`
 * for such a name. Answers `null` for a refusal too, since a workflow that does
 * not resolve says something about the task files that name it, not about the
 * board. Any other error is thrown.
 */
export function workflowQuery(client: Client, name: string) {
  return queryOptions({
    queryKey: daemonKeys.workflow(name),
    queryFn: async (): Promise<Success<Workflow> | null> => {
      try {
        buildPath(routes.readWorkflow, { workflow: name });
      } catch {
        return null;
      }

      try {
        return await client.readWorkflow(name);
      } catch (error) {
        if (error instanceof ProtocolError) {
          return null;
        }
        throw error;
      }
    },
  });
}
