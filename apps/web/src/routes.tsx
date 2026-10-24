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
import { boardValue, isSeveral, readBoard, workflowNames } from "./lib/board";
import { chatFilterOf } from "./lib/use-chat-filter";
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

/**
 * `project` is the tag of the project filter, and `q` the search text. `task`
 * and `chat` name the open chat, both or neither.
 */
type DashboardSearch = { project?: string; q?: string; task?: string; chat?: string };

/** A tag of the engine. */
const PROJECT_TAG = /^[A-Z0-9]+$/;

/** A tag of the engine, a dash and a number. */
const TASK_ID = /^[A-Z0-9]+-\d+$/;

const CHAT_NUMBER = /^[1-9]\d*$/;

// As on the task page, a dropped value is set to undefined rather than left out.
function readDashboardSearch(search: Record<string, unknown>): DashboardSearch {
  const { project, q, task, chat } = search;
  const named = typeof task === "string" && TASK_ID.test(task) && typeof chat === "string" && CHAT_NUMBER.test(chat);

  return {
    project: typeof project === "string" && PROJECT_TAG.test(project) ? project : undefined,
    q: typeof q === "string" && q !== "" ? q : undefined,
    ...(named ? { task, chat } : { task: undefined, chat: undefined }),
  };
}

// Explicit calls, never a map over the navigation arrays: a path produced inside
// a .map() collapses to `string` and takes <Link to="…"> type safety with it.
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: readDashboardSearch,
  // A change of the filter or of the open chat keeps the screen and its last
  // result: the screen reads a new filter itself.
  shouldReload: ({ cause }) => cause !== "stay",
  loader: async ({ context: { queryClient, client }, location }) => {
    const { data: projects } = await queryClient.query({ ...projectsQuery(client), staleTime: "static" });

    await queryClient.infiniteQuery({
      ...chatListQuery(client, chatFilterOf(readDashboardSearch(location.search), projects)),
      staleTime: "static",
    });
  },
  component: DashboardScreen,
});

/**
 * `projects` is `all` or a comma list of tags, and `labels` a comma list, as the
 * address carries them. `q` is the search text.
 */
type TasksSearch = { projects?: string; labels?: string; q?: string };

/** Both reads of a project succeeded, or the daemon refused one of them. */
type TagRead = { tag: string; listing: TaskList } | { tag: string; refusal: unknown };

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
  /**
   * On a board of several projects a project the daemon refuses does not end
   * the load: `tags` are the projects that loaded, `refused` those the daemon
   * refused, and `missing` the tags its project list does not hold, each in
   * board order. The load fails when no project loads, on a refusal on a
   * board of one project, and on any error that is not a refusal.
   */
  loader: async ({ context: { queryClient, client }, deps: { board } }) => {
    const address = readBoard(board);
    const several = isSeveral(address);
    let { data: projects } = await queryClient.query({ ...projectsQuery(client), staleTime: "static" });
    const tags = address.all ? projects.map(({ tag }) => tag) : address.tags;

    async function readTag(tag: string): Promise<TagRead> {
      const [project, listing] = await Promise.allSettled([
        queryClient.query({ ...projectQuery(client, tag), staleTime: "static" }),
        queryClient.query({ ...tasksQuery(client, tag), staleTime: "static" }),
      ]);
      const errors = [project, listing].flatMap((read) => (read.status === "rejected" ? [read.reason as unknown] : []));
      const unanswered = errors.filter((error) => !(error instanceof ProtocolError));

      if (unanswered.length > 0) {
        throw unanswered[0];
      }
      return listing.status === "fulfilled" && errors.length === 0
        ? { tag, listing: listing.value.data }
        : { tag, refusal: errors[0] };
    }

    // One more read of the list, never a read of each tag it does not hold: an
    // address can name any number of tags.
    if (several && tags.some((tag) => !projects.some((listed) => listed.tag === tag))) {
      ({ data: projects } = await queryClient.query({ ...projectsQuery(client), staleTime: 0 }));
    }

    const missing = several ? tags.filter((tag) => !projects.some((listed) => listed.tag === tag)) : [];
    const reads = await Promise.all(tags.filter((tag) => !missing.includes(tag)).map(readTag));
    let loaded = reads.filter((read) => "listing" in read);

    if (tags.length > 0 && loaded.length === 0) {
      const first = reads.find((read) => read.tag === tags[0]) ?? await readTag(tags[0]!);

      if ("refusal" in first) {
        throw first.refusal;
      }
      loaded = [first];
    }

    await Promise.all(
      workflowNames(loaded.flatMap(({ listing }) => listing.entries))
        .map((name) => queryClient.query({ ...workflowQuery(client, name), staleTime: "static" })),
    );
    return {
      tags: loaded.map(({ tag }) => tag),
      refused: reads.filter((read) => "refusal" in read).map(({ tag }) => tag),
      missing: missing.filter((tag) => !loaded.some((read) => read.tag === tag)),
    };
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
