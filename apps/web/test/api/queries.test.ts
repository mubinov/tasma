import { ProtocolError, TransportError } from "@tasma/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createAppQueryClient, createDaemonClient, shouldRetry } from "../../src/api/client";
import { DAEMON_PATH_PREFIX } from "../../src/api/paths";
import { daemonKeys, healthQuery } from "../../src/api/queries";

const HEALTH = { name: "tasma-daemon", version: "0.0.0" };

/** Answers every call with one health envelope, and records the paths asked for. */
function stubDaemon() {
  const paths: string[] = [];

  vi.stubGlobal("fetch", (input: string) => {
    paths.push(input);
    return Promise.resolve(Response.json({ ok: true, data: HEALTH, diagnostics: [] }));
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

  const success = await createAppQueryClient().ensureQueryData(healthQuery(createDaemonClient()));

  expect(paths).toEqual([`${DAEMON_PATH_PREFIX}/health`]);
  expect(success).toEqual({ data: HEALTH, diagnostics: [] });
});

// What is cached is the whole envelope, not the data inside it.
it("caches the whole success envelope, diagnostics included", async () => {
  stubDaemon();

  const queryClient = createAppQueryClient();
  await queryClient.ensureQueryData(healthQuery(createDaemonClient()));

  expect(queryClient.getQueryData(daemonKeys.health())).toEqual({ data: HEALTH, diagnostics: [] });
});

// The property one prefix invalidation depends on.
it("descends every key from the one prefix that invalidates the daemon's answers", () => {
  expect(daemonKeys.health().slice(0, daemonKeys.all.length)).toEqual([...daemonKeys.all]);
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
