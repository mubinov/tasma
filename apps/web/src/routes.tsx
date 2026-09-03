import { createRootRoute, createRoute, createRouter, type RouterHistory } from "@tanstack/react-router";
import { AppShell } from "./components/app-shell";
import { ErrorScreen, RouteFailure } from "./components/error-boundary";
import { PlaceholderScreen } from "./components/placeholder-screen";
import { NAVIGATION_BY_PATH, type NavigationPath } from "./navigation";

const rootRoute = createRootRoute({ component: AppShell, errorComponent: ErrorScreen });

function screenForPath(path: NavigationPath) {
  const { label, summary } = NAVIGATION_BY_PATH[path];

  return () => <PlaceholderScreen title={label} summary={summary} />;
}

// Explicit calls, never a map over the navigation arrays: a path produced inside
// a .map() collapses to `string` and takes <Link to="…"> type safety with it.
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: screenForPath("/"),
});

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  component: screenForPath("/tasks"),
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: screenForPath("/projects"),
});

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows",
  component: screenForPath("/workflows"),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: screenForPath("/settings"),
});

export const routeTree = rootRoute.addChildren([
  dashboardRoute,
  tasksRoute,
  projectsRoute,
  workflowsRoute,
  settingsRoute,
]);

export function createAppRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    defaultErrorComponent: RouteFailure,
    defaultNotFoundComponent: () => (
      <PlaceholderScreen
        title="Not found"
        summary="This address names no screen. Every one of them is reached from the sidebar."
      />
    ),
  });
}
