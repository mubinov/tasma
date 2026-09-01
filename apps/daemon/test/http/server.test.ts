import { once } from "node:events";
import { ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskStoreError } from "@tasma/engine";
import { routes } from "@tasma/protocol";
import type { Route, Success } from "@tasma/protocol";
import manifest from "../../package.json" with { type: "json" };
import type { Handler, RouteEntry } from "../../src/http/router.js";
import { startTestServer } from "../helpers.js";

function entry(route: Route, handler: Handler): RouteEntry {
  return { route, handler };
}

const ok: Handler = () => Promise.resolve({ data: "served", diagnostics: [] });

/** A socket connected to the daemon under test. */
async function open(url: string): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(url).port) });
  await once(socket, "connect");
  return socket;
}

/**
 * A raw request, so a test can send a head no fetch would let it send. The head
 * carries its own host line, which is one of the things a test sends by hand.
 */
async function raw(url: string, head: string[], body = ""): Promise<string> {
  const socket = await open(url);
  socket.write([...head, "connection: close", "", body].join("\r\n"));

  const stream: AsyncIterable<Buffer> = socket;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** A body of `count` mebibytes, sent as chunks and declaring no length. */
async function* megabytes(count: number): AsyncGenerator<Uint8Array> {
  for (let index = 0; index < count; index++) yield new Uint8Array(1024 * 1024).fill(0x20);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the daemon server", () => {
  it("answers the liveness route with the name and the version of this daemon", async () => {
    const server = await startTestServer([]);

    const response = await fetch(`${server.url}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { name: "tasma-daemon", version: manifest.version },
      diagnostics: [],
    });
  });

  it("serves its own liveness route rather than one it was handed", async () => {
    const server = await startTestServer([entry(routes.health, ok)]);

    await expect((await fetch(`${server.url}/health`)).json()).resolves.toMatchObject({
      data: { name: "tasma-daemon" },
    });
  });

  it("hands a handler the params, the query and the body of its request", async () => {
    const seen: unknown[] = [];
    const record: Handler = (request) => {
      seen.push({ params: request.params, query: [...request.query], body: request.body });
      return Promise.resolve({ data: null, diagnostics: [{ code: "temp-file-left" as const, message: "left" }] });
    };
    const server = await startTestServer([entry(routes.updateTask, record)]);

    const response = await fetch(`${server.url}/projects/TASM/tasks/TASM-3?dry=yes`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "Done" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: null,
      diagnostics: [{ code: "temp-file-left", message: "left" }],
    });
    expect(seen).toEqual([
      { params: { project: "TASM", id: "TASM-3" }, query: [["dry", "yes"]], body: { status: "Done" } },
    ]);
  });

  it("reports a refusal from the engine in the shape and the status the contract gives it", async () => {
    const refuse: Handler = () => Promise.reject(new TaskStoreError("task-not-found", "no such task", "/tmp/a.md"));
    const server = await startTestServer([entry(routes.readTask, refuse)]);

    const response = await fetch(`${server.url}/projects/TASM/tasks/TASM-3`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { kind: "store", code: "task-not-found", message: "/tmp/a.md: no such task", path: "/tmp/a.md" },
    });
  });

  it("contains a throw as a 500 and keeps serving", async () => {
    const broken: Handler = () => {
      throw new Error("the disk went away");
    };
    const server = await startTestServer([entry(routes.readTask, broken)]);

    const response = await fetch(`${server.url}/projects/TASM/tasks/TASM-3`);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { kind: "daemon", code: "internal", message: "the disk went away" },
    });
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });

  it("answers 500 where the data of a success is not something JSON carries", async () => {
    const unserializable: Handler = () => Promise.resolve({ data: 1n, diagnostics: [] });
    const server = await startTestServer([entry(routes.readTask, unserializable)]);

    const response = await fetch(`${server.url}/projects/TASM/tasks/TASM-3`);

    // The reply is serialized before the head goes out, so this is still reportable.
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("refuses a write that declares another content type", async () => {
    const server = await startTestServer([entry(routes.createTask, ok)]);

    const response = await fetch(`${server.url}/projects/TASM/tasks`, { method: "POST", body: "{}" });

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unsupported-media-type" } });
  });

  it("refuses a declared body over the cap", async () => {
    const server = await startTestServer([entry(routes.createTask, ok)]);

    const answer = await raw(server.url, [
      "POST /projects/TASM/tasks HTTP/1.1",
      "host: 127.0.0.1",
      "content-type: application/json",
      `content-length: ${9 * 1024 * 1024}`,
    ]);

    expect(answer).toContain("HTTP/1.1 413");
    expect(answer).toContain('"code":"request-too-large"');
  });

  it("answers a chunked body over the cap with the refusal rather than a dead socket", async () => {
    const server = await startTestServer([entry(routes.createTask, ok)]);

    const response = await fetch(`${server.url}/projects/TASM/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: megabytes(9),
      duplex: "half",
    });

    expect(response.status).toBe(413);
    // The parser is stalled part way through a body the daemon stopped reading,
    // so a connection left open could never carry another request.
    expect(response.headers.get("connection")).toBe("close");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "request-too-large" } });
  });

  it("refuses a path no route serves", async () => {
    const server = await startTestServer([]);

    const response = await fetch(`${server.url}/projects/TASM/notes`);

    expect(response.status).toBe(404);
    // The request carried no body, so nothing was left half read: the caller
    // keeps the connection it opened rather than paying for a new one.
    expect(response.headers.get("connection")).toBe("keep-alive");
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "daemon", code: "route-not-found" } });
  });

  it("names the methods a path does serve when the one asked for is not among them", async () => {
    const server = await startTestServer([entry(routes.listTasks, ok), entry(routes.createTask, ok)]);

    const response = await fetch(`${server.url}/projects/TASM/tasks`, { method: "DELETE" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "method-not-allowed" } });
  });

  it("names a method once where the caller registered a route the daemon serves itself", async () => {
    const server = await startTestServer([entry(routes.health, ok)]);

    const response = await fetch(`${server.url}/health`, { method: "DELETE" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("closes the socket rather than the process where a reply cannot be written at all", async () => {
    const server = await startTestServer([]);
    const broken = vi.spyOn(ServerResponse.prototype, "writeHead").mockImplementation(() => {
      throw new Error("the head was refused");
    });

    await expect(fetch(`${server.url}/health`)).rejects.toThrow();

    broken.mockRestore();
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });

  it("survives a client that disconnects while its body is being read", async () => {
    const server = await startTestServer([entry(routes.createTask, ok)]);

    const socket = await open(server.url);
    const head = [
      "POST /projects/TASM/tasks HTTP/1.1",
      "host: 127.0.0.1",
      "content-type: application/json",
      // Ninety-nine bytes short of what it declares, so the daemon is still
      // reading the body when the socket goes.
      "content-length: 100",
      "",
      "{",
    ].join("\r\n");
    await new Promise<void>((resolve) => void socket.write(head, () => resolve()));
    socket.destroy();
    await once(socket, "close");

    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });

  it("stops listening when it is closed", async () => {
    const server = await startTestServer([]);
    const { url } = server;

    await server.close();

    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });
});

describe("the host a request names", () => {
  it("serves a request that names the loopback address", async () => {
    const server = await startTestServer([]);

    const answer = await raw(server.url, ["GET /health HTTP/1.1", "host: localhost"]);

    expect(answer).toContain("HTTP/1.1 200");
  });

  it.each([
    ["a name that is not the daemon's own", "host: tasma.example"],
    ["a host no URL can be read from", "host: ["],
  ])("refuses a request naming %s", async (_description, host) => {
    const server = await startTestServer([]);

    const answer = await raw(server.url, ["GET /health HTTP/1.1", host]);

    expect(answer).toContain("HTTP/1.1 400");
    expect(answer).toContain('"code":"malformed-request"');
  });

  it("refuses a request that names no host at all", async () => {
    const server = await startTestServer([]);

    const answer = await raw(server.url, ["GET /health HTTP/1.0"]);

    expect(answer).toContain("HTTP/1.1 400");
    expect(answer).toContain('"code":"malformed-request"');
  });
});

describe("a success", () => {
  it("answers 200 whichever method asked for it", async () => {
    const server = await startTestServer([entry(routes.createTask, ok), entry(routes.deleteTask, ok)]);

    const created = await fetch(`${server.url}/projects/TASM/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Write it" }),
    });
    const deleted = await fetch(`${server.url}/projects/TASM/tasks/TASM-3`, { method: "DELETE" });

    expect([created.status, deleted.status]).toEqual([200, 200]);
    const envelope: { ok: true } & Success<string> = { ok: true, data: "served", diagnostics: [] };
    await expect(created.json()).resolves.toEqual(envelope);
  });
});
