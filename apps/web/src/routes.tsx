import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { buildPath, routes as daemonRoutes, type Client, type Route } from "@tasma/protocol";
import { projectQuery, projectsQuery, taskQuery, tasksQuery, workflowQuery } from "./api/queries";
import { AppShell } from "./components/app-shell";
import { ErrorScreen, RouteFailure } from "./components/error-boundary";
import { PlaceholderScreen } from "./components/placeholder-screen";
import { ProjectScreen } from "./components/project-screen";
import { ProjectsScreen } from "./components/projects-screen";
import { SettingsScreen } from "./components/settings-screen";
import { TaskScreen } from "./components/task-screen";
import { TasksFailure, TasksScreen } from "./components/tasks-screen";
import { splitList, workflowNames } from "./lib/board";
import { NAVIGATION_BY_PATH, type NavigationPath } from "./navigation";
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

// What a screen says before it exists is the screen's, not the sidebar's, so
// the copy is declared beside the routes that render it.
export const PLACEHOLDER_SUMMARIES = {
  "/": "What needs a human and what the agents are working on will be summarised here.",
  "/workflows": "The workflows a task can run, and the steps each one takes, will be shown here.",
} as const satisfies Partial<Record<NavigationPath, string>>;

type PlaceholderPath = keyof typeof PLACEHOLDER_SUMMARIES;

function placeholderFor(path: PlaceholderPath) {
  const { label } = NAVIGATION_BY_PATH[path];

  return () => <PlaceholderScreen title={label} summary={PLACEHOLDER_SUMMARIES[path]} />;
}

// Explicit calls, never a map over the navigation arrays: a path produced inside
// a .map() collapses to `string` and takes <Link to="…"> type safety with it.
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: placeholderFor("/"),
});

/** Comma lists, as the address carries them. */
type TasksSearch = { projects?: string; labels?: string };

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  validateSearch: (search: Record<string, unknown>): TasksSearch => {
    const { projects, labels } = search;

    return {
      ...(typeof projects === "string" && projects !== "" ? { projects } : {}),
      ...(typeof labels === "string" && labels !== "" ? { labels } : {}),
    };
  },
  beforeLoad: async ({ search, context }) => {
    const [tag, ...others] = splitList(search.projects);

    if (tag !== undefined && others.length > 0) {
      throw redirect({ to: "/tasks", search: { ...search, projects: tag }, replace: true });
    }
    if (tag !== undefined) {
      requirePath(daemonRoutes.readProject, { project: tag });
      return;
    }

    const { data: projects } = await context.queryClient.query({ ...projectsQuery(context.client), staleTime: "static" });
    const last = useUiStore.getState().lastTasksProject;
    const opened = projects.find((project) => project.tag === last) ?? projects[0];

    if (opened !== undefined) {
      throw redirect({ to: "/tasks", search: { ...search, projects: opened.tag }, replace: true });
    }
  },
  loaderDeps: ({ search }) => ({ tag: splitList(search.projects)[0] }),
  loader: async ({ context: { queryClient, client }, deps: { tag } }) => {
    await queryClient.query({ ...projectsQuery(client), staleTime: "static" });
    if (tag === undefined) {
      return;
    }

    const [, { data: listing }] = await Promise.all([
      queryClient.query({ ...projectQuery(client, tag), staleTime: "static" }),
      queryClient.query({ ...tasksQuery(client, tag), staleTime: "static" }),
    ]);

    await Promise.all(
      workflowNames(listing.entries).map((name) => queryClient.query({ ...workflowQuery(client, name), staleTime: "static" })),
    );
  },
  component: TasksScreen,
  errorComponent: TasksFailure,
});

// A sibling of the board, not its child: under `/tasks` it would take the
// board's search, its redirect to a project and its loader.
const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$project/$task",
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
  component: placeholderFor("/workflows"),
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
  workflowsRoute,
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

export function createAppRouter(history: RouterHistory, context: RouterContext) {
  return createRouter({
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
}
