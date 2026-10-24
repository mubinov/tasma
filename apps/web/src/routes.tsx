import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  redirect,
  type AnyRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import {
  buildPath,
  ProtocolError,
  routes as daemonRoutes,
  type Client,
  type Route,
  type TaskList,
} from "@tasma/protocol";
import {
  chatListQuery,
  projectQuery,
  projectsQuery,
  taskQuery,
  tasksQuery,
  workflowQuery,
  workflowReadQuery,
  workflowsQuery,
} from "./api/queries";
import { AppShell } from "./components/app-shell";
import { DashboardScreen } from "./components/dashboard-screen";
import { ErrorScreen, RouteFailure } from "./components/error-boundary";
import { PlaceholderScreen } from "./components/placeholder-screen";
import { ProjectScreen } from "./components/project-screen";
import { ProjectsScreen } from "./components/projects-screen";
import { SettingsScreen } from "./components/settings-screen";
import { TaskScreen } from "./components/task-screen";
import { TasksFailure, TasksScreen } from "./components/tasks-screen";
import { WorkflowScreen } from "./components/workflow-screen";
import { WorkflowsScreen } from "./components/workflows-screen";
import { boardValue, readBoard, workflowNames } from "./lib/board";
import { useUiStore } from "./store/ui";

/** What every loader and every screen is handed: the cache, and the daemon. */
export type RouterContext = { queryClient: QueryClient; client: Client };

/**
 * The client refuses a segment a URL resolver would remove or climb out of, and
 * it refuses by throwing, which the failure panel can only read as a fault in
 * our own code. Its own rule is asked before the load instead, so an address
 * naming nothing reaches the not-found screen.
 */
function requirePath(route: Route, params: Record<string, string>): void {
  try {
    buildPath(route, params);
  } catch {
    throw notFound();
  }
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  errorComponent: ErrorScreen,
});

/** `task` and `chat` name the open chat, both or neither. */
type DashboardSearch = { task?: string; chat?: string };

/** A tag of the engine, a dash and a number. */
const TASK_ID = /^[A-Z0-9]+-\d+$/;

const CHAT_NUMBER = /^[1-9]\d*$/;

// Explicit calls, never a map over the navigation arrays: a path produced inside
// a .map() collapses to `string` and takes <Link to="…"> type safety with it.
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // As on the task page, a dropped value is set to undefined rather than left out.
  validateSearch: (search: Record<string, unknown>): DashboardSearch => {
    const { task, chat } = search;
    const named = typeof task === "string" && TASK_ID.test(task) && typeof chat === "string" && CHAT_NUMBER.test(chat);

    return named ? { task, chat } : { task: undefined, chat: undefined };
  },
  loader: ({ context: { queryClient, client } }) => queryClient.infiniteQuery({
    ...chatListQuery(client),
    staleTime: "static",
  }),
  component: DashboardScreen,
});

/**
 * `projects` is `all` or a comma list of tags, and `labels` a comma list, as the
 * address carries them. `q` is the search text.
 */
type TasksSearch = { projects?: string; labels?: string; q?: string };

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  validateSearch: (search: Record<string, unknown>): TasksSearch => {
    const { projects, labels, q } = search;

    return {
      ...(typeof projects === "string" && projects !== "" ? { projects } : {}),
      ...(typeof labels === "string" && labels !== "" ? { labels } : {}),
      ...(typeof q === "string" && q !== "" ? { q } : {}),
    };
  },
  beforeLoad: async ({ search, context }) => {
    const { all, tags } = readBoard(search.projects);

    if (all) {
      return;
    }
    if (tags.length > 0) {
      for (const tag of tags) {
        requirePath(daemonRoutes.readProject, { project: tag });
      }
      return;
    }

    const { data: projects } = await context.queryClient.query({ ...projectsQuery(context.client), staleTime: "static" });
    const last = useUiStore.getState().lastTasksProject;
    const opened = projects.find((project) => project.tag === last) ?? projects[0];

    if (opened !== undefined) {
      throw redirect({ to: "/tasks", search: { ...search, projects: opened.tag }, replace: true });
    }
  },
  loaderDeps: ({ search }) => ({ board: boardValue(readBoard(search.projects)) }),
  loader: async ({ context: { queryClient, client }, deps: { board } }) => {
    const { data: projects } = await queryClient.query({ ...projectsQuery(client), staleTime: "static" });
    const { all, tags: named } = readBoard(board);
    const tags = all ? projects.map(({ tag }) => tag) : named;
    const listed = new Set(projects.map(({ tag }) => tag));

    async function readTag(tag: string): Promise<TaskList> {
      const [, { data: listing }] = await Promise.all([
        queryClient.query({ ...projectQuery(client, tag), staleTime: "static" }),
        queryClient.query({ ...tasksQuery(client, tag), staleTime: "static" }),
      ]);
      return listing;
    }

    // Tags the project list does not hold are read one at a time, so the first
    // refusal ends the load and a long list of unknown tags sends no burst.
    const listings: TaskList[] = [];
    for (const tag of tags.filter((tag) => !listed.has(tag))) {
      listings.push(await readTag(tag));
    }
    listings.push(...await Promise.all(tags.filter((tag) => listed.has(tag)).map(readTag)));

    await Promise.all(
      workflowNames(listings.flatMap(({ entries }) => entries))
        .map((name) => queryClient.query({ ...workflowQuery(client, name), staleTime: "static" })),
    );
    return { tags };
  },
  component: TasksScreen,
  errorComponent: TasksFailure,
});

/** `chat` is the number of the chat that the panel shows in place of the sidebar. */
type TaskSearch = { chat?: string };

// A sibling of the board, not its child: under `/tasks` it would take the
// board's search, its redirect to a project and its loader.
const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$project/$task",
  // The router lays the answer over the search of the address, so a dropped
  // value is set to undefined rather than left out.
  validateSearch: (search: Record<string, unknown>): TaskSearch => {
    const { chat } = search;

    return { chat: typeof chat === "string" && CHAT_NUMBER.test(chat) ? chat : undefined };
  },
  beforeLoad: ({ params }) => {
    requirePath(daemonRoutes.readTask, { project: params.project, id: params.task });
  },
  // Another task mounts a new screen, so no comment keeps the open state of the
  // comment with the same id in the task before, and that task's notice closes.
  remountDeps: ({ params }) => params,
  loader: async ({ context: { queryClient, client }, params: { project, task } }) => {
    const [, { data: read }] = await Promise.all([
      queryClient.query({ ...projectQuery(client, project), staleTime: "static" }),
      queryClient.query({ ...taskQuery(client, project, task), staleTime: "static" }),
      queryClient.query({ ...tasksQuery(client, project), staleTime: "static" }),
    ]);
    const { workflow } = read.frontmatter;

    if (workflow !== undefined) {
      await queryClient.query({ ...workflowQuery(client, workflow), staleTime: "static" });
    }
  },
  component: TaskScreen,
});

// No component of its own, so the router renders the child that matched.
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
});

const projectsIndexRoute = createRoute({
  getParentRoute: () => projectsRoute,
  path: "/",
  loader: ({ context }) => context.queryClient.query({
    ...projectsQuery(context.client),
    staleTime: "static",
  }),
  component: ProjectsScreen,
});

const projectRoute = createRoute({
  getParentRoute: () => projectsRoute,
  path: "/$project",
  beforeLoad: ({ params }) => {
    requirePath(daemonRoutes.readProject, params);
  },
  loader: ({ context, params }) => context.queryClient.query({
    ...projectQuery(context.client, params.project),
    staleTime: "static",
  }),
  component: ProjectScreen,
});

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows",
});

const workflowsIndexRoute = createRoute({
  getParentRoute: () => workflowsRoute,
  path: "/",
  loader: async ({ context: { queryClient, client } }) => {
    const { data: names } = await queryClient.query({ ...workflowsQuery(client), staleTime: "static" });

    await Promise.all(names.map((name) => queryClient.query({ ...workflowReadQuery(client, name), staleTime: "static" })));
  },
  component: WorkflowsScreen,
});

const workflowRoute = createRoute({
  getParentRoute: () => workflowsRoute,
  path: "/$workflow",
  beforeLoad: ({ params }) => {
    requirePath(daemonRoutes.readWorkflow, params);
  },
  loader: async ({ context: { queryClient, client }, params }) => {
    const options = workflowReadQuery(client, params.workflow);
    const read = await queryClient.query({ ...options, staleTime: "static" });

    // The page shows a file it could not parse; any other refusal means there is
    // no page. The answer is dropped, or the next visit reads it back from the
    // cache and never asks again.
    if (!read.ok && read.failure.code !== "workflow-invalid") {
      queryClient.removeQueries({ queryKey: options.queryKey, exact: true });
      throw new ProtocolError(read.failure, read.status);
    }
  },
  component: WorkflowScreen,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsScreen,
});

export const routeTree = rootRoute.addChildren([
  dashboardRoute,
  tasksRoute,
  taskRoute,
  projectsRoute.addChildren([projectsIndexRoute, projectRoute]),
  workflowsRoute.addChildren([workflowsIndexRoute, workflowRoute]),
  settingsRoute,
]);

/**
 * Every search value is the text of the address, and a repeated key keeps its
 * first value. The router's default codec reads values as JSON, which turns
 * `labels=2026` into a number and `labels=1.0` into `1`.
 */
function parseSearch(searchStr: string): Record<string, string> {
  const values = new Map<string, string>();

  for (const [key, value] of new URLSearchParams(searchStr)) {
    if (!values.has(key)) {
      values.set(key, value);
    }
  }

  return Object.fromEntries(values);
}

function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string") {
      params.set(key, value);
    }
  }

  // A comma is a legal query character, so a list reads as `labels=web,infra`.
  const text = params.toString().replaceAll("%2C", ",");

  return text === "" ? "" : `?${text}`;
}

/**
 * A load that stays on the same task keeps the page where it is, whatever
 * started it: a chat that opens, changes or closes, Back to an entry with the
 * same address (a close replaces the entry of its chat), a link or a retry.
 * A load of the board that stays on the same history entry keeps it too: the
 * board of all projects loads again when a project joins or leaves it.
 * The flag is the one that `resetScroll: false` sets, and the router reads it
 * in the `onRendered` that follows this event. A scroll put back after the
 * reset would not do: WebKit reveals a focused element after the render, and a
 * scroll cancels that reveal.
 */
function keepScroll(router: AnyRouter): void {
  router.subscribe("onResolved", ({ pathChanged, hrefChanged, fromLocation, toLocation }) => {
    const routeId = router.state.matches.at(-1)?.routeId;
    const sameEntry = !hrefChanged && fromLocation?.state.__TSR_key === toLocation.state.__TSR_key;

    if ((!pathChanged && routeId === taskRoute.id) || (sameEntry && routeId === tasksRoute.id)) {
      router._scroll.next = false;
    }
  });
}

export function createAppRouter(history: RouterHistory, context: RouterContext) {
  const router = createRouter({
    routeTree,
    history,
    context,
    parseSearch,
    stringifySearch,
    defaultErrorComponent: RouteFailure,
    defaultNotFoundComponent: () => (
      <PlaceholderScreen
        title="Not found"
        summary="This address names nothing the application can show. The sidebar reaches every section."
      />
    ),
  });

  keepScroll(router);
  return router;
}
