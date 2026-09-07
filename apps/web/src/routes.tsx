import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, notFound, type RouterHistory } from "@tanstack/react-router";
import { buildPath, routes as daemonRoutes, type Client } from "@tasma/protocol";
import { projectQuery, projectsQuery } from "./api/queries";
import { AppShell } from "./components/app-shell";
import { ErrorScreen, RouteFailure } from "./components/error-boundary";
import { PlaceholderScreen } from "./components/placeholder-screen";
import { ProjectScreen } from "./components/project-screen";
import { ProjectsScreen } from "./components/projects-screen";
import { SettingsScreen } from "./components/settings-screen";
import { NAVIGATION_BY_PATH, type NavigationPath } from "./navigation";

/** What every loader and every screen is handed: the cache, and the daemon. */
export type RouterContext = { queryClient: QueryClient; client: Client };

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  errorComponent: ErrorScreen,
});

// What a screen says before it exists is the screen's, not the sidebar's, so
// the copy is declared beside the routes that render it.
export const PLACEHOLDER_SUMMARIES = {
  "/": "What needs a human and what the agents are working on will be summarised here.",
  "/tasks": "Every task in the workspace will be listed here, whoever is working on it.",
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

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  component: placeholderFor("/tasks"),
});

// No component of its own, so the router renders the child that matched.
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
});

const projectsIndexRoute = createRoute({
  getParentRoute: () => projectsRoute,
  path: "/",
  loader: ({ context }) => context.queryClient.ensureQueryData(projectsQuery(context.client)),
  component: ProjectsScreen,
});

const projectRoute = createRoute({
  getParentRoute: () => projectsRoute,
  path: "/$project",
  // The client refuses a segment a URL resolver would remove or climb out of,
  // and it refuses by throwing, which the failure panel can only read as a fault
  // in our own code. Its own rule is asked here instead, so an address naming no
  // project reaches the not-found screen.
  beforeLoad: ({ params }) => {
    try {
      buildPath(daemonRoutes.readProject, params);
    } catch {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's signal is a plain object
      throw notFound();
    }
  },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(projectQuery(context.client, params.project)),
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
  projectsRoute.addChildren([projectsIndexRoute, projectRoute]),
  workflowsRoute,
  settingsRoute,
]);

export function createAppRouter(history: RouterHistory, context: RouterContext) {
  return createRouter({
    routeTree,
    history,
    context,
    defaultErrorComponent: RouteFailure,
    defaultNotFoundComponent: () => (
      <PlaceholderScreen
        title="Not found"
        summary="This address names nothing the application can show. The sidebar reaches every section."
      />
    ),
  });
}
