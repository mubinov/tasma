import { afterEach, expect, it, vi } from "vitest";
import { DAEMON_PATH_PREFIX } from "../../src/api/paths";
import { createFetchTransport, DAEMON_URL } from "../../src/api/transport";

type FetchCall = [input: string, init: RequestInit];

/** Replaces fetch with one that always answers `response`, and records the calls. */
function stubFetch(response: Response | Promise<never>) {
  const calls: FetchCall[] = [];

  vi.stubGlobal("fetch", (input: string, init: RequestInit) => {
    calls.push([input, init]);
    return response instanceof Response ? Promise.resolve(response) : response;
  });

  return calls;
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The address is injected by vite.config.ts and shown to a person when the
// daemon cannot be reached. Asserting the literal would fail on any machine
// exporting TASMA_DAEMON_URL, so this asserts the shape the panel prints.
it("carries the daemon's absolute address the Vite config injected", () => {
  expect(DAEMON_URL).toMatch(/^https?:\/\/\S+$/);
});

it("prepends the base path the proxy is mounted on", async () => {
  const calls = stubFetch(Response.json({ ok: true, data: null, diagnostics: [] }));

  await createFetchTransport(DAEMON_PATH_PREFIX)({ method: "GET", path: "/projects/tasma/tasks?status=To%20Do" });

  expect(calls[0]?.[0]).toBe(`${DAEMON_PATH_PREFIX}/projects/tasma/tasks?status=To%20Do`);
  expect(calls[0]?.[1].method).toBe("GET");
});

it("stringifies a body and declares its media type", async () => {
  const calls = stubFetch(Response.json({ ok: true, data: null, diagnostics: [] }));

  await createFetchTransport(DAEMON_PATH_PREFIX)({ method: "POST", path: "/projects/tasma/tasks", body: { title: "Ship it" } });

  expect(calls[0]?.[1].body).toBe('{"title":"Ship it"}');
  expect(headerOf(calls[0]![1], "content-type")).toBe("application/json");
});

it("sends neither a body nor a media type on a call that has none", async () => {
  const calls = stubFetch(Response.json({ ok: true, data: null, diagnostics: [] }));

  await createFetchTransport(DAEMON_PATH_PREFIX)({ method: "GET", path: "/health" });

  expect(calls[0]?.[1].body).toBeUndefined();
  expect(headerOf(calls[0]![1], "content-type")).toBeUndefined();
});

// Every status comes back for createClient to decide on, refusals included.
it.each([200, 422, 500])("returns the parsed envelope and the status of a %i answer", async (status) => {
  const envelope = { ok: false, error: { kind: "store", code: "config-invalid", message: "config.yml is not YAML" } };
  stubFetch(Response.json(envelope, { status }));

  const reply = await createFetchTransport(DAEMON_PATH_PREFIX)({ method: "GET", path: "/projects/tasma" });

  expect(reply).toEqual({ status, body: envelope });
});

// A proxy with nothing behind it answers HTML, and the status survives it.
it("reads a body that is not JSON as no body at all", async () => {
  stubFetch(new Response("<html>502 Bad Gateway</html>", { status: 502 }));

  const reply = await createFetchTransport(DAEMON_PATH_PREFIX)({ method: "GET", path: "/health" });

  expect(reply).toEqual({ status: 502, body: undefined });
});

// Only fetch itself rejecting means no daemon answered, and createClient turns
// this rejection into the TransportError the failure panel recognises.
it("propagates a fetch that never reached a server", async () => {
  const failure = new TypeError("Failed to fetch");
  stubFetch(Promise.reject(failure));

  await expect(createFetchTransport(DAEMON_PATH_PREFIX)({ method: "GET", path: "/health" })).rejects.toBe(failure);
});
