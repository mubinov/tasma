import { QueryClient } from "@tanstack/react-query";
import { createClient, ProtocolError, TransportError, type Transport } from "@tasma/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient, createDaemonClient, shouldRetry } from "../../src/api/client";
import { DAEMON_PATH_PREFIX } from "../../src/api/paths";
import {
  daemonKeys,
  healthQuery,
  projectQuery,
  projectsQuery,
  taskQuery,
  tasksQuery,
  workflowQuery,
} from "../../src/api/queries";
import { refusalReply, stubTransport, successReply } from "../helpers";

const HEALTH = { name: "tasma-daemon", version: "0.0.0" };

const PROJECTS = [{ tag: "SAGA", name: "saga", path: "/repos/saga" }];

const PROJECT = { tag: "SAGA", name: "saga" };

/** Answers every call with one envelope, and records the paths asked for. */
function stubDaemon(data: unknown = HEALTH) {
  const paths: string[] = [];

  vi.stubGlobal("fetch", (input: string) => {
    paths.push(input);
    return Promise.resolve(Response.json({ ok: true, data, diagnostics: [] }));
  });

  return paths;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * The whole chain in one test: the query options, the daemon client, the fetch
 * transport, the proxy prefix and the envelope read. Anything that breaks
 * between a loader and the daemon breaks here.
 */
it("resolves a query through the transport, the client and the envelope read", async () => {
  const paths = stubDaemon();

  const success = await createAppQueryClient().query({
    ...healthQuery(createDaemonClient()),
    staleTime: "static",
  });

  expect(paths).toEqual([`${DAEMON_PATH_PREFIX}/health`]);
  expect(success).toEqual({ data: HEALTH, diagnostics: [] });
});

// What is cached is the whole envelope, not the data inside it.
it("caches the whole success envelope, diagnostics included", async () => {
  stubDaemon();

  const queryClient = createAppQueryClient();
  await queryClient.query({
    ...healthQuery(createDaemonClient()),
    staleTime: "static",
  });

  expect(queryClient.getQueryData(daemonKeys.health())).toEqual({ data: HEALTH, diagnostics: [] });
});

/*
 * The property one prefix invalidation depends on, asked of every key there is.
 * The builders are read off `daemonKeys` rather than listed, so a key added
 * there is covered by existing; a key ignores the arguments it does not take.
 */
it("descends every key from the one prefix that invalidates the daemon's answers", () => {
  const builders: ((tag: string, id: string) => readonly string[])[] = Object.values(daemonKeys).filter(
    (value) => typeof value === "function",
  );

  expect(builders.length).toBeGreaterThan(0);
  for (const build of builders) {
    const key = build("SAGA", "SAGA-1");
    expect(key.slice(0, daemonKeys.all.length), key.join("/")).toEqual([...daemonKeys.all]);
  }
});

it("resolves the projects list through the same chain and caches the whole envelope", async () => {
  const paths = stubDaemon(PROJECTS);
  const queryClient = createAppQueryClient();

  const success = await queryClient.query({
    ...projectsQuery(createDaemonClient()),
    staleTime: "static",
  });

  expect(paths).toEqual([`${DAEMON_PATH_PREFIX}/projects`]);
  expect(success).toEqual({ data: PROJECTS, diagnostics: [] });
  expect(queryClient.getQueryData(daemonKeys.projects())).toEqual({ data: PROJECTS, diagnostics: [] });
});

it("asks for one project by the tag it is given", async () => {
  const paths = stubDaemon(PROJECT);

  const success = await createAppQueryClient().query({
    ...projectQuery(createDaemonClient(), "SAGA"),
    staleTime: "static",
  });

  expect(paths).toEqual([`${DAEMON_PATH_PREFIX}/projects/SAGA`]);
  expect(success).toEqual({ data: PROJECT, diagnostics: [] });
});

// The nesting a write depends on: invalidating the list drops every project
// under it, and one project's key drops that project alone.
it("nests one project's key inside the list's", () => {
  const projects = daemonKeys.projects();

  expect(daemonKeys.project("SAGA").slice(0, projects.length)).toEqual([...projects]);
});

it("nests a project's tasks inside the project, and one workflow inside the workflows", () => {
  const project = daemonKeys.project("SAGA");
  const workflows = daemonKeys.workflows();

  expect(daemonKeys.tasks("SAGA").slice(0, project.length)).toEqual([...project]);
  expect(daemonKeys.workflow("dev").slice(0, workflows.length)).toEqual([...workflows]);
});

// An invalidation of a project's tasks after a write reaches an open task page.
it("nests one task inside the tasks of its project", () => {
  const tasks = daemonKeys.tasks("SAGA");

  expect(daemonKeys.task("SAGA", "SAGA-1")).toEqual([...tasks, "SAGA-1"]);
});

it("asks for one task with its comments in one request", async () => {
  const task = { frontmatter: { id: "SAGA-1" }, body: "", comments: [] };
  const paths = stubDaemon(task);

  const success = await createAppQueryClient().query({
    ...taskQuery(createDaemonClient(), "SAGA", "SAGA-1"),
    staleTime: "static",
  });

  expect(paths).toEqual([`${DAEMON_PATH_PREFIX}/projects/SAGA/tasks/SAGA-1`]);
  expect(success).toEqual({ data: task, diagnostics: [] });
});

it("asks for the tasks of one project, with no filter", async () => {
  const listing = { entries: [], excluded: [] };
  const paths = stubDaemon(listing);

  const success = await createAppQueryClient().query({
    ...tasksQuery(createDaemonClient(), "SAGA"),
    staleTime: "static",
  });

  expect(paths).toEqual([`${DAEMON_PATH_PREFIX}/projects/SAGA/tasks`]);
  expect(success).toEqual({ data: listing, diagnostics: [] });
});

describe("workflowQuery", () => {
  const WORKFLOW = { name: "dev", steps: [], instructions: [] };

  function readWorkflow(transport: Transport, name: string) {
    return createAppQueryClient().query({ ...workflowQuery(createClient(transport), name), staleTime: "static" });
  }

  it("answers the workflow's envelope", async () => {
    const { transport, paths } = stubTransport({ "/workflows/dev": successReply(WORKFLOW) });

    await expect(readWorkflow(transport, "dev")).resolves.toEqual({ data: WORKFLOW, diagnostics: [] });
    expect(paths).toEqual(["/workflows/dev"]);
  });

  it("answers null for a refusal", async () => {
    const { transport } = stubTransport({
      "/workflows/gone": refusalReply(404, { kind: "store", code: "workflow-unknown", message: "no workflow is named gone" }),
    });

    await expect(readWorkflow(transport, "gone")).resolves.toBeNull();
  });

  it.each([{ name: "" }, { name: ".." }, { name: "a/b" }])(
    "answers null with no request for the name \"$name\"",
    async ({ name }) => {
      const { transport, paths } = stubTransport();

      await expect(readWorkflow(transport, name)).resolves.toBeNull();
      expect(paths).toEqual([]);
    },
  );

  it("throws a transport fault", async () => {
    const fault = new Error("connection refused");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await expect(
      queryClient.query({ ...workflowQuery(createClient(() => Promise.reject(fault)), "dev"), staleTime: "static" }),
    ).rejects.toBeInstanceOf(TransportError);
  });
});

// A transport fault and nothing else, once and no more.
it.each([
  { case: "a transport fault", error: new TransportError("GET /health reached no daemon"), count: 0, retried: true },
  { case: "the same fault twice", error: new TransportError("GET /health reached no daemon"), count: 1, retried: false },
  {
    case: "a refusal the daemon spelled out",
    error: new ProtocolError({ kind: "store", code: "task-not-found", message: "no such task" }, 404),
    count: 0,
    retried: false,
  },
  { case: "a fault in our own code", error: new Error("no value for the path parameter"), count: 0, retried: false },
])("retries $case: $retried", ({ error, count, retried }) => {
  expect(shouldRetry(count, error)).toBe(retried);
});

it("hands the query client the retry rule and a stale time that survives an alt-tab", () => {
  const queries = createAppQueryClient().getDefaultOptions().queries;

  expect(queries?.retry).toBe(shouldRetry);
  expect(queries?.staleTime).toBe(30_000);
});

// Factories, not instances: a module-scope client would carry one test's cache
// and one screen's stale answers into the next.
it("builds a fresh cache every time it is called", () => {
  expect(createAppQueryClient()).not.toBe(createAppQueryClient());
  expect(createDaemonClient()).not.toBe(createDaemonClient());
});
