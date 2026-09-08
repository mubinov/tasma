import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { routes } from "@tasma/protocol";
import type { Project, ProjectSummary } from "@tasma/protocol";
import type { HandlerRequest } from "../../src/http/router.js";
import { createProjectHost } from "../../src/projects/host.js";
import type { ProjectHost } from "../../src/projects/host.js";
import { projectRoutes } from "../../src/projects/routes.js";
import {
  failure,
  loseTasks,
  plant,
  projectConfig,
  projectsRoot,
  send,
  startTestServer,
  success,
  target,
  taskFile,
  tasksDir,
  taskText,
  until,
} from "../helpers.js";
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
 * A daemon serving the project routes over a tree, both closed with the test.
 * The host comes back with it, so a test that has to drive one index reaches it
 * without a second host over the same tree.
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
    const path = await target();
    await plant(projectConfig(root, "TASM"), `name: Tasma\npath: ${path}\nstatuses: [New, Doing]\n`);
    const server = await serving(root);

    const response = await fetch(`${server.url}/projects/TASM`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        tag: "TASM",
        name: "Tasma",
        path,
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
    await expect(failure(response)).resolves.toMatchObject({
      kind: "store",
      code: "config-invalid",
      path: projectConfig(root, "TASM"),
    });
  });

  it("reports the folder the project stands for as gone, naming the path the reply carries", async () => {
    const root = await projectsRoot("TASM");
    const path = await target();
    await plant(projectConfig(root, "TASM"), `path: ${path}\n`);
    const server = await serving(root);
    await rm(path, { recursive: true });

    const response = await fetch(`${server.url}/projects/TASM`);

    expect(response.status).toBe(200);
    const { data, diagnostics } = await success<Project>(response);
    expect(data.path).toBe(path);
    expect(diagnostics).toEqual([
      { code: "path-missing", message: "the project path does not name a directory", path },
    ]);
  });

  it("reports nothing about a folder that is there", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), `path: ${await target()}\n`);
    const server = await serving(root);

    await expect(success<Project>(await fetch(`${server.url}/projects/TASM`))).resolves.toMatchObject({
      diagnostics: [],
    });
  });

  it.each([
    ["a tag no project of the tree carries", "NOPE"],
    ["a name that is no tag, which must not read as a fault of the request", "abc"],
  ])("answers 404 project-not-found for %s", async (_name, tag) => {
    const server = await serving(await projectsRoot("TASM"));

    const response = await fetch(`${server.url}/projects/${tag}`);

    expect(response.status).toBe(404);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "project-not-found" });
  });
});

describe("POST /projects", () => {
  it("answers with the project it registered, which the tree then holds", async () => {
    const root = await projectsRoot();
    const path = await target();
    const server = await serving(root);

    const response = await send(server, "POST", "/projects", { path });

    expect(response.status).toBe(200);
    const { data, diagnostics } = await success<Project>(response);
    expect(data).toEqual({ tag: "TASM", name: "tasma", path, config: BUILT_IN_CONFIG, live: true });
    expect(diagnostics).toEqual([]);
    await expect(readFile(projectConfig(root, "TASM"), "utf8")).resolves.toBe(`name: tasma\npath: ${path}\n`);
  });

  it("takes the tag the body states", async () => {
    const server = await serving(await projectsRoot());

    const response = await send(server, "POST", "/projects", { path: await target(), tag: "CLIB" });

    expect(response.status).toBe(200);
    await expect(success<Project>(response)).resolves.toMatchObject({ data: { tag: "CLIB" } });
  });

  it("refuses a path that stands for itself nowhere", async () => {
    const server = await serving(await projectsRoot());

    const response = await send(server, "POST", "/projects", { path: "tasma" });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "path-invalid" });
  });

  it("refuses a tag another project already stands under", async () => {
    const server = await serving(await projectsRoot("TASM"));

    const response = await send(server, "POST", "/projects", { path: await target(), tag: "TASM" });

    expect(response.status).toBe(409);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "project-exists" });
  });

  it("refuses a body that is no object, before anything is written", async () => {
    const server = await serving(await projectsRoot());

    const response = await send(server, "POST", "/projects", ["/srv/tasma"]);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
    await expect(success<ProjectSummary[]>(await fetch(`${server.url}/projects`))).resolves.toMatchObject({ data: [] });
  });

  it("refuses a body naming the tree the daemon serves", async () => {
    const server = await serving(await projectsRoot());

    const response = await send(server, "POST", "/projects", { path: await target(), root: "/srv/elsewhere" });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "field-not-writable" });
  });

  it("refuses a query, which this route declares no key of", async () => {
    const server = await serving(await projectsRoot());

    const response = await send(server, "POST", "/projects?tag=TASM", { path: await target() });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });
});

describe("PATCH /projects/{project}", () => {
  it("answers with the project as the write left it", async () => {
    const root = await projectsRoot("TASM");
    const path = await target();
    await plant(projectConfig(root, "TASM"), `name: Tasma\npath: ${path}\n`);
    const server = await serving(root);

    const response = await send(server, "PATCH", "/projects/TASM", { name: "Renamed" });

    expect(response.status).toBe(200);
    await expect(success<Project>(response)).resolves.toMatchObject({
      data: { tag: "TASM", name: "Renamed", path, live: true },
      diagnostics: [],
    });
  });

  it("clears the name for a key the body carries as null, and the file no longer holds it", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "name: Tasma\npath: /srv/tasma\n");
    const server = await serving(root);

    const response = await send(server, "PATCH", "/projects/TASM", { name: null });

    expect(response.status).toBe(200);
    expect((await success<Project>(response)).data.name).toBeUndefined();
    await expect(readFile(projectConfig(root, "TASM"), "utf8")).resolves.toBe("path: /srv/tasma\n");
  });

  it("leaves the file as it stands for a body naming no key", async () => {
    const root = await projectsRoot("TASM");
    const text = "name: Tasma\n# What it stands for.\npath: /srv/tasma\n";
    await plant(projectConfig(root, "TASM"), text);
    const server = await serving(root);

    const response = await send(server, "PATCH", "/projects/TASM", {});

    expect(response.status).toBe(200);
    await expect(readFile(projectConfig(root, "TASM"), "utf8")).resolves.toBe(text);
  });

  it("reports the folder the project stands for as gone", async () => {
    const root = await projectsRoot("TASM");
    const path = await target();
    await plant(projectConfig(root, "TASM"), `path: ${path}\n`);
    const server = await serving(root);
    await rm(path, { recursive: true });

    const response = await send(server, "PATCH", "/projects/TASM", {});

    expect(response.status).toBe(200);
    await expect(success<Project>(response)).resolves.toMatchObject({
      diagnostics: [{ code: "path-missing", path }],
    });
  });

  it("refuses the tag, which no write of a project sets", async () => {
    const server = await serving(await projectsRoot("TASM"));

    const response = await send(server, "PATCH", "/projects/TASM", { tag: "CLIB" });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "field-not-writable" });
  });

  it("answers 404 for a tag the tree does not list", async () => {
    const server = await serving(await projectsRoot("TASM"));

    const response = await send(server, "PATCH", "/projects/NOPE", { name: "Tasma" });

    expect(response.status).toBe(404);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "project-not-found" });
  });

  it("reads back inside its own turn, so a delete waiting behind it runs after the reply is built", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "name: Tasma\npath: /srv/tasma\n");
    const inner = createProjectHost({ root });
    onTestFinished(() => inner.close());

    const reached: string[] = [];
    let queued!: () => void;
    const behind = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const host: ProjectHost = {
      ...inner,
      async open(tag) {
        reached.push("read");
        return inner.open(tag);
      },
      async update(tag, change) {
        reached.push("write");
        await behind;
        return inner.update(tag, change);
      },
      async remove(tag) {
        reached.push("remove");
        return inner.remove(tag);
      },
    };
    // The write is held until the delete has entered its handler, which takes
    // the turn behind the patch before this resolution reaches the write. So
    // what the order below states is the queue's decision rather than which
    // request the socket delivered first.
    const entries = projectRoutes(host).map((entry) => {
      if (entry.route !== routes.deleteProject) return entry;
      return {
        ...entry,
        handler: (request: HandlerRequest) => {
          queued();
          return entry.handler(request);
        },
      };
    });
    const server = await startTestServer(entries);

    const patching = send(server, "PATCH", "/projects/TASM", { name: "Renamed" });
    await until(() => reached.includes("write"), "the patch took its turn");
    const removed = await send(server, "DELETE", "/projects/TASM");

    const patched = await patching;
    expect(patched.status).toBe(200);
    await expect(success<Project>(patched)).resolves.toMatchObject({ data: { name: "Renamed" } });
    expect(removed.status).toBe(200);
    expect(reached).toEqual(["write", "read", "remove"]);
  });
});

describe("DELETE /projects/{project}", () => {
  it("answers with what the project stated, and the tree holds it no more", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "name: Tasma\npath: /srv/tasma\n");
    const server = await serving(root);

    const response = await send(server, "DELETE", "/projects/TASM");

    expect(response.status).toBe(200);
    await expect(success<ProjectSummary>(response)).resolves.toEqual({
      data: { tag: "TASM", name: "Tasma", path: "/srv/tasma" },
      diagnostics: [],
    });
    expect((await fetch(`${server.url}/projects/TASM`)).status).toBe(404);
  });

  it("answers 404 for a project a delete already took", async () => {
    const server = await serving(await projectsRoot("TASM"));
    expect((await send(server, "DELETE", "/projects/TASM")).status).toBe(200);

    const response = await send(server, "DELETE", "/projects/TASM");

    expect(response.status).toBe(404);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "project-not-found" });
  });

  it("makes a patch that arrives behind it wait, so the patch is refused rather than faulted", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "name: Tasma\npath: /srv/tasma\n");
    const server = await serving(root);

    const [removed, patched] = await Promise.all([
      send(server, "DELETE", "/projects/TASM"),
      send(server, "PATCH", "/projects/TASM", { name: "Renamed" }),
    ]);

    expect(removed.status).toBe(200);
    expect(patched.status).toBe(404);
    await expect(failure(patched)).resolves.toMatchObject({ kind: "store", code: "project-not-found" });
  });
});

describe("POST /projects/{project}/rename", () => {
  it("answers with the project under its new tag, its configuration and its index state", async () => {
    const root = await projectsRoot("TASM");
    const path = await target();
    await plant(projectConfig(root, "TASM"), `name: Tasma\npath: ${path}\n`);
    await plant(taskFile(root, "TASM", "TASM-1"), taskText("TASM-1"));
    const server = await serving(root);

    const response = await send(server, "POST", "/projects/TASM/rename", { tag: "NEW" });

    expect(response.status).toBe(200);
    await expect(success<Project>(response)).resolves.toEqual({
      data: { tag: "NEW", name: "Tasma", path, config: BUILT_IN_CONFIG, live: true },
      diagnostics: [],
    });
  });

  it("serves the renamed project and no longer the old tag", async () => {
    const root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), taskText("TASM-1"));
    await plant(taskFile(root, "TASM", "TASM-2"), taskText("TASM-2"));
    const server = await serving(root);

    expect((await send(server, "POST", "/projects/TASM/rename", { tag: "NEW" })).status).toBe(200);

    expect((await fetch(`${server.url}/projects/TASM`)).status).toBe(404);
    expect((await fetch(`${server.url}/projects/NEW`)).status).toBe(200);
    const { index } = await server.host.open("NEW");
    expect(index.query().entries.map((entry) => entry.id)).toEqual(["NEW-1", "NEW-2"]);
  });

  it("carries the findings of the rename beside the ones of the read", async () => {
    const root = await projectsRoot("TASM");
    await plant(join(tasksDir(root, "TASM"), "notes.md"), "not a task file");
    const server = await serving(root);

    const response = await send(server, "POST", "/projects/TASM/rename", { tag: "NEW" });

    await expect(success<Project>(response)).resolves.toMatchObject({
      diagnostics: [{ code: "task-file-unexpected", path: join(tasksDir(root, "NEW"), "notes.md") }],
    });
  });

  it.each([
    ["a key no rename states", { tag: "NEW", name: "Tasma" }, "field-not-writable"],
    ["a body naming no tag", {}, "field-required"],
    ["a tag the create rule refuses", { tag: "new" }, "tag-invalid"],
  ])("answers 400 for %s", async (_name, body, code) => {
    const server = await serving(await projectsRoot("TASM"));

    const response = await send(server, "POST", "/projects/TASM/rename", body);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code });
  });

  it("answers 400 for a query key", async () => {
    const server = await serving(await projectsRoot("TASM"));

    const response = await send(server, "POST", "/projects/TASM/rename?tag=NEW", { tag: "NEW" });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });

  it("answers 404 for a tag the tree does not list", async () => {
    const server = await serving(await projectsRoot("TASM"));

    const response = await send(server, "POST", "/projects/NOPE/rename", { tag: "NEW" });

    expect(response.status).toBe(404);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "project-not-found" });
  });

  it("answers 409 for a tag another project already carries", async () => {
    const server = await serving(await projectsRoot("TASM", "CLIB"));

    const response = await send(server, "POST", "/projects/TASM/rename", { tag: "CLIB" });

    expect(response.status).toBe(409);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "project-exists" });
  });

  it("answers 409 for an entry of the tasks directory named after a task of the new project", async () => {
    const root = await projectsRoot("TASM");
    await plant(join(tasksDir(root, "TASM"), "NEW-1.md"), "stray");
    const server = await serving(root);

    const response = await send(server, "POST", "/projects/TASM/rename", { tag: "NEW" });

    expect(response.status).toBe(409);
    await expect(failure(response)).resolves.toMatchObject({
      kind: "store",
      code: "task-exists",
      path: join(tasksDir(root, "TASM"), "NEW-1.md"),
    });
  });

  it("answers 422 for a task file it cannot read, and the tree still holds the old tag alone", async () => {
    const root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), "---\nid: TASM-1\n");
    const server = await serving(root);

    const response = await send(server, "POST", "/projects/TASM/rename", { tag: "NEW" });

    expect(response.status).toBe(422);
    await expect(failure(response)).resolves.toMatchObject({ kind: "parse", filename: taskFile(root, "TASM", "TASM-1") });
    await expect(readdir(join(root, "projects"))).resolves.toEqual(["TASM"]);
  });

  it("makes a patch of the new tag wait until the rename is complete", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "name: Tasma\npath: /srv/tasma\n");
    const server = await serving(root);

    const [renamed, patched] = await Promise.all([
      send(server, "POST", "/projects/TASM/rename", { tag: "NEW" }),
      send(server, "PATCH", "/projects/NEW", { name: "Renamed" }),
    ]);

    expect(renamed.status).toBe(200);
    expect(patched.status).toBe(200);
    await expect(success<Project>(patched)).resolves.toMatchObject({ data: { tag: "NEW", name: "Renamed" } });
  });
});
