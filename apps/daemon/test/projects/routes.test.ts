import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createProjectHost } from "../../src/projects/host.js";
import type { ProjectHost } from "../../src/projects/host.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { loseTasks, plant, projectConfig, projectsRoot, startTestServer, tasksDir, taskText } from "../helpers.js";
import type { TestServer } from "../helpers.js";

const BUILT_IN_CONFIG = {
  statuses: ["Backlog", "To Do", "In Progress", "Done"],
  default_status: "Backlog",
  final_statuses: ["Done"],
  priorities: ["high", "medium", "low"],
  workflows: [],
  instructions: [],
};

/**
 * A daemon serving the two project routes over a tree, both closed with the
 * test. The host comes back with it, so a test that has to drive one index
 * reaches it without a second host over the same tree.
 */
async function serving(root: string): Promise<TestServer & { host: ProjectHost }> {
  const host = createProjectHost({ root });
  onTestFinished(() => host.close());
  return { ...(await startTestServer(projectRoutes(host))), host };
}

describe("GET /projects", () => {
  it("answers with the summary of every project of the tree, and no diagnostics", async () => {
    const root = await projectsRoot("TASM", "CLIB");
    await plant(projectConfig(root, "TASM"), "name: Tasma\npath: /srv/tasma\n");
    const server = await serving(root);

    const response = await fetch(`${server.url}/projects`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: [{ tag: "CLIB" }, { tag: "TASM", name: "Tasma", path: "/srv/tasma" }],
      diagnostics: [],
    });
  });

  it("lists a project whose configuration it cannot read, and says nothing about it", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "name: [Tasma\n");
    const server = await serving(root);

    await expect((await fetch(`${server.url}/projects`)).json()).resolves.toEqual({
      ok: true,
      data: [{ tag: "TASM" }],
      diagnostics: [],
    });
  });
});

describe("GET /projects/{project}", () => {
  it("answers with the project, its resolved configuration and its index state", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "name: Tasma\npath: /srv/tasma\nstatuses: [New, Doing]\n");
    const server = await serving(root);

    const response = await fetch(`${server.url}/projects/TASM`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        tag: "TASM",
        name: "Tasma",
        path: "/srv/tasma",
        config: {
          ...BUILT_IN_CONFIG,
          statuses: ["New", "Doing"],
          default_status: "New",
          final_statuses: ["Doing"],
        },
        live: true,
      },
      diagnostics: [],
    });
  });

  it("reports an index that stopped following the disk as no longer live", { timeout: 20000, retry: 3 }, async () => {
    const root = await projectsRoot("TASM");
    await plant(join(tasksDir(root, "TASM"), "TASM-1.md"), taskText("TASM-1"));
    const server = await serving(root);
    const { index } = await server.host.open("TASM");

    await loseTasks(root, "TASM", index);

    const response = await fetch(`${server.url}/projects/TASM`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { tag: "TASM", live: false } });
  });

  it("carries the findings of the project's own configuration file", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "statues: [New]\n");
    const server = await serving(root);

    const response = await fetch(`${server.url}/projects/TASM`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown; diagnostics: { code: string; path: string }[] };
    expect(body.data).toEqual({ tag: "TASM", config: BUILT_IN_CONFIG, live: true });
    expect(body.diagnostics).toEqual([
      { code: "config-key-unknown", message: expect.stringContaining("statues") as unknown, path: projectConfig(root, "TASM") },
    ]);
  });

  it("refuses a project whose configuration file cannot be read, which the listing passed over", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "name: [Tasma\n");
    const server = await serving(root);

    const response = await fetch(`${server.url}/projects/TASM`);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", code: "config-invalid", path: projectConfig(root, "TASM") },
    });
  });

  it.each([
    ["a tag no project of the tree carries", "NOPE"],
    ["a name that is no tag, which must not read as a fault of the request", "abc"],
  ])("answers 404 project-not-found for %s", async (_name, tag) => {
    const server = await serving(await projectsRoot("TASM"));

    const response = await fetch(`${server.url}/projects/${tag}`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", code: "project-not-found" },
    });
  });
});
