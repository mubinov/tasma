import { queryOptions } from "@tanstack/react-query";
import {
  buildPath,
  ProtocolError,
  routes,
  type Client,
  type Diagnostic,
  type Failure,
  type Success,
  type Workflow,
} from "@tasma/protocol";

import { APP_PATH_PREFIX } from "./paths";

export const POLL_INTERVAL = 5_000;

/**
 * Two properties a new key has to keep: every key descends from `all`, so one
 * prefix invalidation drops everything the daemon said, and keys nest the way
 * the routes nest, so a write to one project leaves every other project's cache
 * intact. The keys of the workflows screens are the exception: under
 * `workflows()`, a workflow named `list` would share the key of the list, and
 * a read would share the key under which the board's `workflowQuery` stores a
 * different answer shape.
 */
export const daemonKeys = {
  all: ["daemon"] as const,
  health: () => [...daemonKeys.all, "health"] as const,
  projects: () => [...daemonKeys.all, "projects"] as const,
  project: (tag: string) => [...daemonKeys.projects(), tag] as const,
  tasks: (tag: string) => [...daemonKeys.project(tag), "tasks"] as const,
  task: (tag: string, id: string) => [...daemonKeys.tasks(tag), id] as const,
  // "search" is no task id, which is always `<TAG>-<number>`.
  taskSearch: (tag: string, q: string) => [...daemonKeys.tasks(tag), "search", q] as const,
  workflows: () => [...daemonKeys.all, "workflows"] as const,
  workflow: (name: string) => [...daemonKeys.workflows(), name] as const,
  workflowList: () => [...daemonKeys.all, "workflow-list"] as const,
  workflowRead: (name: string) => [...daemonKeys.all, "workflow-read", name] as const,
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

export function taskSearchQuery(client: Client, tag: string, q: string) {
  return queryOptions({
    queryKey: daemonKeys.taskSearch(tag, q),
    queryFn: () => client.listTasks(tag, { q }),
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

export function workflowsQuery(client: Client) {
  return queryOptions({
    queryKey: daemonKeys.workflowList(),
    queryFn: () => client.listWorkflows(),
  });
}

export const UPDATE_STATES = ["none", "available", "installing", "ready", "failed"] as const;

export type UpdateState = (typeof UPDATE_STATES)[number];

/**
 * What the app says about an update of itself. In `none` the version and the
 * release page are empty; the progress counts only in `installing` and the
 * error only in `failed`.
 */
export type Update = {
  state: UpdateState;
  current: string;
  version: string;
  releaseUrl: string;
  progress: number;
  error: string;
};

/** The keys of what the app answers itself, apart from everything the daemon said. */
export const appKeys = {
  update: () => ["app", "update"] as const,
};

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The update an answer states, or `null` for an answer of another shape. Every
 * state but `none` names its version and its release page.
 */
export function readUpdate(value: unknown): Update | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const answer = value as Record<string, unknown>;
  const state = UPDATE_STATES.find((known) => known === answer.state);
  const named = state === "none" || (typeof answer.version === "string" && typeof answer.releaseUrl === "string");
  if (state === undefined || typeof answer.current !== "string" || !named) {
    return null;
  }

  return {
    state,
    current: answer.current,
    version: stringOrEmpty(answer.version),
    releaseUrl: stringOrEmpty(answer.releaseUrl),
    progress: typeof answer.progress === "number" ? answer.progress : 0,
    error: stringOrEmpty(answer.error),
  };
}

/**
 * Answers `null` where no app answers: in a browser during development the path
 * reaches the dev server, which serves its page.
 */
export function updateQuery() {
  return queryOptions({
    queryKey: appKeys.update(),
    queryFn: async (): Promise<Update | null> => {
      try {
        const response = await fetch(`${APP_PATH_PREFIX}/update`);

        return response.ok ? readUpdate(await response.json()) : null;
      } catch {
        return null;
      }
    },
  });
}

export type WorkflowRead
  = | { ok: true; workflow: Workflow; diagnostics: Diagnostic[] }
    | { ok: false; failure: Failure; status: number };

/** The engine accepts a blank `title`, which would render as nothing, so a blank title falls back to the name. */
export function workflowTitle(read: WorkflowRead | undefined, name: string): string {
  const title = read?.ok === true ? read.workflow.title : undefined;
  return title === undefined || title.trim() === "" ? name : title;
}

/**
 * A refusal is an answer, not an error: a file broken by hand is what the
 * workflows screens show, and the query keeps showing it across a refetch.
 */
export function workflowReadQuery(client: Client, name: string) {
  return queryOptions({
    queryKey: daemonKeys.workflowRead(name),
    queryFn: async (): Promise<WorkflowRead> => {
      try {
        const { data, diagnostics } = await client.readWorkflow(name);
        return { ok: true, workflow: data, diagnostics };
      } catch (error) {
        if (error instanceof ProtocolError) {
          return { ok: false, failure: error.failure, status: error.status };
        }
        throw error;
      }
    },
  });
}
