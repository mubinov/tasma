import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";
import type { IndexedProject } from "@tasma/engine";
import type { Diagnostic } from "@tasma/protocol";
import { DaemonError } from "../src/http/failure.js";
import type { RouteEntry } from "../src/http/router.js";
import { createDaemonServer } from "../src/http/server.js";
import { createProjectHost } from "../src/projects/host.js";
import type { ProjectHost } from "../src/projects/host.js";

export type TestServer = { url: string; close(): Promise<void> };

/** The stamp every planted file carries, so a test asserts against a known value. */
export const TIMESTAMP = "2026-01-01T00:00:00+03:00";

/**
 * A daemon listening on a port the operating system issued, so parallel test
 * files never collide. It is closed when the test ends, whether or not the test
 * closes it itself.
 */
export async function startTestServer(entries: RouteEntry[]): Promise<TestServer> {
  const server = createDaemonServer(entries);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    // An idle keep-alive socket would hold the run open past the test, and
    // `close` returns the server rather than a promise, so the wait is the event.
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
  onTestFinished(close);

  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close };
}

/**
 * A daemon serving the routes one module declares over a tree, with the host
 * they were built over. Both are closed when the test ends.
 */
export async function serving(root: string, routesOf: (host: ProjectHost) => RouteEntry[]): Promise<TestServer> {
  const host = createProjectHost({ root });
  onTestFinished(() => host.close());
  return startTestServer(routesOf(host));
}

/** One request to a test server, with the media type every write route requires. */
export async function send(server: TestServer, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The two fields a success carries, without the flag every one of them repeats. */
export async function success<T>(response: Response): Promise<{ data: T; diagnostics: Diagnostic[] }> {
  const { data, diagnostics } = (await response.json()) as { data: T; diagnostics: Diagnostic[] };
  return { data, diagnostics };
}

/** The refusal a call raised, so a test asserts on the code rather than on the text. */
export function refused(run: () => unknown): DaemonError {
  try {
    run();
  } catch (error) {
    if (error instanceof DaemonError) return error;
    throw error;
  }
  throw new Error("the call was not refused");
}

/**
 * A temp `<root>` holding one project directory per tag, removed when the test
 * ends. The engine's own test helpers are test code of another vitest project
 * and are not exported, so the tree a daemon test needs is built here.
 */
export async function projectsRoot(...tags: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tasma-daemon-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const tag of tags) await mkdir(projectDir(root, tag), { recursive: true });
  return root;
}

export function projectDir(root: string, tag: string): string {
  return join(root, "projects", tag);
}

export function projectConfig(root: string, tag: string): string {
  return join(projectDir(root, tag), "config.yml");
}

export function userConfig(root: string): string {
  return join(root, "config.yml");
}

export function tasksDir(root: string, tag: string): string {
  return join(projectDir(root, tag), "tasks");
}

export function taskFile(root: string, tag: string, id: string): string {
  return join(tasksDir(root, tag), `${id}.md`);
}

/** Writes a file, creating the directories above it. */
export async function plant(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/** A task file as a hand edit or an earlier write leaves it. */
export function taskText(id: string): string {
  return `---
id: ${id}
title: Planted
status: To Do
created: "${TIMESTAMP}"
updated: "${TIMESTAMP}"
next_comment_id: 1
---

Body.
`;
}

/**
 * A task file carrying two comments: one written inline with an author, one
 * written as a block with every optional marker field. The first body holds
 * multi-byte characters, so a size measured in bytes differs from one measured
 * in characters.
 */
export function taskWithComments(id: string): string {
  return `---
id: ${id}
title: Planted
status: To Do
created: "${TIMESTAMP}"
updated: "${TIMESTAMP}"
next_comment_id: 3
---

Body.

<!-- task:comment {id: 1, title: "First", created: "${TIMESTAMP}", author: almaz} -->

Ünïcödé.

<!-- task:comment
id: 2
title: "Second"
created: "${TIMESTAMP}"
updated: "${TIMESTAMP}"
collapsed: true
custom: {round: 2}
-->

Second body.
`;
}

/**
 * Waits until the index of one project has dropped the tasks directory it was
 * holding, which is the loss a host reports as the flag going down.
 *
 * The report that clears the flag is the one that empties the index, so what the
 * index holds is what a test can watch the flag by. Reading it through the host
 * would run a repair instead.
 */
export async function loseTasks(root: string, tag: string, index: IndexedProject): Promise<void> {
  const tasks = tasksDir(root, tag);
  await until(() => index.query().entries.length === 0, "the index dropped what it held", async () => {
    await plant(join(tasks, `${tag}-1.md`), taskText(`${tag}-1`));
    await rm(tasks, { recursive: true, force: true });
  });
}

/**
 * Waits until the expectation holds, so a test never waits a fixed interval.
 *
 * `change` is the change the expectation waits on, and it is made again every so
 * often while the wait runs: a watch of the operating system can drop the first
 * changes that follow it, and under load it drops them for seconds. Repeating
 * the change keeps the test about the event that arrives rather than about the
 * moment the watch became live.
 */
export async function until(holds: () => boolean, what: string, change?: () => Promise<unknown>): Promise<void> {
  const timeout = 5000;
  const deadline = Date.now() + timeout;
  let again = 0;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeout} ms`);
    if (change !== undefined && Date.now() >= again) {
      again = Date.now() + 250;
      await change();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
