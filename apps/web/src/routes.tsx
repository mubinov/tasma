import { createRootRoute, createRoute, createRouter, type RouterHistory } from "@tanstack/react-router";
import { AppShell } from "./components/app-shell";
import { ErrorScreen, RouteFailure } from "./components/error-boundary";
import { PlaceholderScreen } from "./components/placeholder-screen";
import { SettingsScreen } from "./components/settings-screen";
import { NAVIGATION_BY_PATH, type NavigationPath } from "./navigation";

const rootRoute = createRootRoute({ component: AppShell, errorComponent: ErrorScreen });

// What a screen says before it exists is the screen's, not the sidebar's, so
// the copy is declared beside the routes that render it.
export const PLACEHOLDER_SUMMARIES = {
  "/": "What needs a human and what the agents are working on will be summarised here.",
  "/tasks": "Every task in the workspace will be listed here, whoever is working on it.",
  "/projects": "The repositories tasma tracks will be listed here.",
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

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: placeholderFor("/projects"),
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
