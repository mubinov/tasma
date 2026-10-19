import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { EventsReply, FeedEvent } from "@tasma/protocol";
import { configRoutes } from "../../src/config/routes.js";
import { createFeed } from "../../src/events/feed.js";
import { eventRoutes } from "../../src/events/routes.js";
import { createProjectHost } from "../../src/projects/host.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { taskRoutes } from "../../src/tasks/routes.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import { workflowRoutes } from "../../src/workflows/routes.js";
import {
  failure,
  get,
  plant,
  projectsRoot,
  send,
  startTestServer,
  stillPending,
  success,
  target,
  taskFile,
  taskText,
  until,
} from "../helpers.js";
import type { TestServer } from "../helpers.js";

/** A hold no test outlasts, for a read that an event has to end. */
const LONG_HOLD_MS = 10_000;

/** A hold a test waits out, to see that no event follows. */
const SHORT_HOLD_MS = 300;

/** Every route of the daemon over a tree, with one feed that the host and the routes publish to. */
async function serving(root: string, holdMs = LONG_HOLD_MS): Promise<TestServer> {
  const feed = createFeed({ holdMs });
  const { publish } = feed;
  const host = createProjectHost({ root, publish });
  onTestFinished(async () => {
    feed.close();
    await host.close();
  });
  const writes = new WriteQueue();

  return startTestServer([
    ...projectRoutes(host, writes),
    ...taskRoutes(host),
    ...workflowRoutes({ root, writes, publish }),
    ...configRoutes({ root, writes, publish }),
    ...eventRoutes(feed),
  ]);
}

/** One read of the feed, which has to succeed. */
async function read(server: TestServer, after?: string): Promise<EventsReply> {
  const response = await get(server, after === undefined ? "/events" : `/events?after=${encodeURIComponent(after)}`);
  expect(response.status).toBe(200);
  return (await success<EventsReply>(response)).data;
}

/** The events of a reply that is no `reset`. */
function eventsOf(reply: EventsReply): FeedEvent[] {
  if ("reset" in reply) throw new Error("the feed answered reset");
  return reply.events;
}

function taskEvent(id: string, change: "created" | "changed" | "deleted"): FeedEvent {
  return { kind: "task", tag: "ALPHA", id, change };
}

/** Sends one write, which has to succeed. */
async function write(server: TestServer, method: string, path: string, body?: unknown): Promise<void> {
  const response = await send(server, method, path, body);
  expect(response.status, `${method} ${path}`).toBe(200);
}

describe("GET /events", () => {
  it("ends a held read at a task write through the daemon with one task event", async () => {
    const root = await projectsRoot("ALPHA");
    await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskText("ALPHA-1"));
    const server = await serving(root);
    const { cursor } = await read(server);
    const held = read(server, cursor);

    expect(await stillPending(held)).toBe(true);
    await write(server, "PATCH", "/projects/ALPHA/tasks/ALPHA-1", { title: "Renamed" });

    expect(eventsOf(await held)).toEqual([taskEvent("ALPHA-1", "changed")]);
  });

  it("ends a held read at a direct edit of the task file with one task event", async () => {
    const root = await projectsRoot("ALPHA");
    await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskText("ALPHA-1"));
    const server = await serving(root);
    // The first read opens the index, whose watch finds the edit.
    expect((await get(server, "/projects/ALPHA/tasks")).status).toBe(200);
    const { cursor } = await read(server);
    let answered = false;
    const held = read(server, cursor).finally(() => (answered = true));

    let edit = 0;
    await until(
      () => answered,
      "a direct edit ended the held read",
      () => plant(taskFile(root, "ALPHA", "ALPHA-1"), taskText("ALPHA-1").replace("Body.", `Body ${(edit += 1)}.`)),
    );

    expect(eventsOf(await held)).toEqual([taskEvent("ALPHA-1", "changed")]);
  });

  it("sends a task event for a create and for a delete", async () => {
    const root = await projectsRoot("ALPHA");
    await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskText("ALPHA-1"));
    const server = await serving(root);
    const { cursor } = await read(server);

    await write(server, "POST", "/projects/ALPHA/tasks", { title: "New" });
    const created = await read(server, cursor);
    await write(server, "DELETE", "/projects/ALPHA/tasks/ALPHA-2");
    const deleted = await read(server, created.cursor);

    expect(eventsOf(created)).toEqual([taskEvent("ALPHA-2", "created")]);
    expect(eventsOf(deleted)).toEqual([taskEvent("ALPHA-2", "deleted")]);
  });

  it("sends a project event for a create and for an update", async () => {
    const root = await projectsRoot();
    const server = await serving(root);
    const { cursor } = await read(server);

    await write(server, "POST", "/projects", { path: await target(), tag: "BETA" });
    await write(server, "PATCH", "/projects/BETA", { name: "Beta" });

    expect(eventsOf(await read(server, cursor))).toEqual([
      { kind: "project", tag: "BETA", change: "created" },
      { kind: "project", tag: "BETA", change: "changed" },
    ]);
  });

  it("sends a config event for a write of the configuration", async () => {
    const server = await serving(await projectsRoot());
    const { cursor } = await read(server);

    await write(server, "PATCH", "/config", { priorities: ["urgent", "later"] });

    expect(eventsOf(await read(server, cursor))).toEqual([{ kind: "config" }]);
  });

  it("sends a workflow event for a create, an update and a delete", async () => {
    const root = await projectsRoot();
    const file = join(root, "docs", "one.md");
    await plant(file, "Do one.\n");
    const server = await serving(root);
    const { cursor } = await read(server);

    await write(server, "POST", "/workflows", { name: "flow-a", steps: [{ name: "one", owner: "agent", file }] });
    await write(server, "PATCH", "/workflows/flow-a", { title: "Flow A" });
    await write(server, "DELETE", "/workflows/flow-a");

    expect(eventsOf(await read(server, cursor))).toEqual([
      { kind: "workflow", name: "flow-a", change: "created" },
      { kind: "workflow", name: "flow-a", change: "changed" },
      { kind: "workflow", name: "flow-a", change: "deleted" },
    ]);
  });

  it("sends no event for a refused write", async () => {
    const server = await serving(await projectsRoot(), SHORT_HOLD_MS);
    const { cursor } = await read(server);

    expect((await send(server, "PATCH", "/config", { default_status: "Nowhere" })).status).toBe(400);

    await expect(read(server, cursor)).resolves.toEqual({ cursor, events: [] });
  });

  it.each([
    ["a rename", "POST", "/projects/ALPHA/rename", { tag: "GAMMA" }, { change: "renamed", to: "GAMMA" }],
    ["a delete", "DELETE", "/projects/ALPHA", undefined, { change: "deleted" }],
  ])("ends %s of a project with its project event", async (_case, method, path, body, change) => {
    const root = await projectsRoot("ALPHA");
    await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskText("ALPHA-1"));
    await plant(taskFile(root, "ALPHA", "ALPHA-2"), taskText("ALPHA-2"));
    const server = await serving(root, SHORT_HOLD_MS);
    expect((await get(server, "/projects/ALPHA/tasks")).status).toBe(200);
    const { cursor } = await read(server);

    await write(server, method, path, body);
    const reply = await read(server, cursor);

    // The `task deleted` events of the old index can come first; how many depends on its watch.
    expect(eventsOf(reply).at(-1)).toEqual({ kind: "project", tag: "ALPHA", ...change });
    await expect(read(server, reply.cursor)).resolves.toEqual({ cursor: reply.cursor, events: [] });
  });

  it("answers reset for text that is no cursor", async () => {
    const server = await serving(await projectsRoot());
    const { cursor } = await read(server);

    await expect(read(server, "bogus-1")).resolves.toEqual({ reset: true, cursor });
  });

  it.each([
    ["a key the route does not declare", "/events?since=1"],
    ["the cursor stated twice", "/events?after=a-1&after=a-2"],
  ])("refuses %s with 400", async (_case, path) => {
    const server = await serving(await projectsRoot());

    const response = await get(server, path);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });

  it("refuses a read without the token with 401", async () => {
    const server = await serving(await projectsRoot());

    const response = await fetch(`${server.url}/events`);

    expect(response.status).toBe(401);
  });
});
