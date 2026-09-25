import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

const REVIEW_WORKFLOW = "steps:\n  - {name: check, file: steps/check.md, owner: agent}\n";

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
    const root = await projectsRoot("SAGA", "ACME");
    await plant(projectConfig(root, "SAGA"), "name: Saga\npath: /srv/saga\n");
    const server = await serving(root);

    const response = await fetch(`${server.url}/projects`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: [{ tag: "ACME" }, { tag: "SAGA", name: "Saga", path: "/srv/saga" }],
      diagnostics: [],
    });
  });

  it("lists a project whose configuration it cannot read, and says nothing about it", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "name: [Saga\n");
    const server = await serving(root);

    await expect((await fetch(`${server.url}/projects`)).json()).resolves.toEqual({
      ok: true,
      data: [{ tag: "SAGA" }],
      diagnostics: [],
    });
  });

  it("refuses a query key, so a resolution sent to this route does not read as the whole tree", async () => {
    const server = await serving(await projectsRoot("SAGA"));

    const response = await fetch(`${server.url}/projects?path=/x`);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });
});

describe("GET /projects/{project}", () => {
  it("answers with the project, its resolved configuration and its index state", async () => {
    const root = await projectsRoot("SAGA");
    const path = await target();
    await plant(projectConfig(root, "SAGA"), `name: Saga\npath: ${path}\nstatuses: [New, Doing]\n`);
    const server = await serving(root);

    const response = await fetch(`${server.url}/projects/SAGA`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        tag: "SAGA",
        name: "Saga",
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
    const root = await projectsRoot("SAGA");
    await plant(join(tasksDir(root, "SAGA"), "SAGA-1.md"), taskText("SAGA-1"));
    const server = await serving(root);
    const { index } = await server.host.open("SAGA");

    await loseTasks(root, "SAGA", index);

    const response = await fetch(`${server.url}/projects/SAGA`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { tag: "SAGA", live: false } });
  });

  it("carries the findings of the project's own configuration file", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "statues: [New]\n");
    const server = await serving(root);

    const response = await fetch(`${server.url}/projects/SAGA`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown; diagnostics: { code: string; path: string }[] };
    expect(body.data).toEqual({ tag: "SAGA", config: BUILT_IN_CONFIG, live: true });
    expect(body.diagnostics).toEqual([
      { code: "config-key-unknown", message: expect.stringContaining("statues") as unknown, path: projectConfig(root, "SAGA") },
    ]);
  });

  it("refuses a project whose configuration file cannot be read, which the listing passed over", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "name: [Saga\n");
    const server = await serving(root);

    const response = await fetch(`${server.url}/projects/SAGA`);

    expect(response.status).toBe(422);
    await expect(failure(response)).resolves.toMatchObject({
      kind: "store",
      code: "config-invalid",
      path: projectConfig(root, "SAGA"),
    });
  });

  it("reports the folder the project stands for as gone, naming the path the reply carries", async () => {
    const root = await projectsRoot("SAGA");
    const path = await target();
    await plant(projectConfig(root, "SAGA"), `path: ${path}\n`);
    const server = await serving(root);
    await rm(path, { recursive: true });

    const response = await fetch(`${server.url}/projects/SAGA`);

    expect(response.status).toBe(200);
    const { data, diagnostics } = await success<Project>(response);
    expect(data.path).toBe(path);
    expect(diagnostics).toEqual([
      { code: "path-missing", message: "the project path does not name a directory", path },
    ]);
  });

  it("reports nothing about a folder that is there", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), `path: ${await target()}\n`);
    const server = await serving(root);

    await expect(success<Project>(await fetch(`${server.url}/projects/SAGA`))).resolves.toMatchObject({
      diagnostics: [],
    });
  });

  it("refuses a query key, which this route declares none of", async () => {
    const server = await serving(await projectsRoot("SAGA"));

    const response = await fetch(`${server.url}/projects/SAGA?x=1`);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });

  it.each([
    ["a tag no project of the tree carries", "NOPE"],
    ["a name that is no tag, which must not read as a fault of the request", "abc"],
  ])("answers 404 project-not-found for %s", async (_name, tag) => {
    const server = await serving(await projectsRoot("SAGA"));

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
    expect(data).toEqual({ tag: "SAGA", name: "saga", path, config: BUILT_IN_CONFIG, live: true });
    expect(diagnostics).toEqual([]);
    await expect(readFile(projectConfig(root, "SAGA"), "utf8")).resolves.toBe(`name: saga\npath: ${path}\n`);
  });

  it("takes the tag the body states", async () => {
    const server = await serving(await projectsRoot());

    const response = await send(server, "POST", "/projects", { path: await target(), tag: "ACME" });

    expect(response.status).toBe(200);
    await expect(success<Project>(response)).resolves.toMatchObject({ data: { tag: "ACME" } });
  });

  it("refuses a path that stands for itself nowhere", async () => {
    const server = await serving(await projectsRoot());

    const response = await send(server, "POST", "/projects", { path: "saga" });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "path-invalid" });
  });

  it("refuses a tag another project already stands under", async () => {
    const server = await serving(await projectsRoot("SAGA"));

    const response = await send(server, "POST", "/projects", { path: await target(), tag: "SAGA" });

    expect(response.status).toBe(409);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "project-exists" });
  });

  it("refuses the path of a registered project, and the tree holds that project alone", async () => {
    const root = await projectsRoot();
    const path = await target();
    const server = await serving(root);
    expect((await send(server, "POST", "/projects", { path, tag: "ONE" })).status).toBe(200);

    const response = await send(server, "POST", "/projects", { path, tag: "TWO" });

    expect(response.status).toBe(409);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "path-taken", path });
    await expect(readdir(join(root, "projects"))).resolves.toEqual(["ONE"]);
  });

  it("registers one of two creates of one path sent together, and refuses the other", async () => {
    const root = await projectsRoot();
    const path = await target();
    const server = await serving(root);

    const responses = await Promise.all([
      send(server, "POST", "/projects", { path, tag: "ONE" }),
      send(server, "POST", "/projects", { path, tag: "TWO" }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await expect(readdir(join(root, "projects"))).resolves.toHaveLength(1);
  });

  it("lets one of a create and a patch of another project to one path sent together through, and refuses the other", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), `path: ${await target()}\n`);
    const path = await target();
    const server = await serving(root);

    const [created, patched] = await Promise.all([
      send(server, "POST", "/projects", { path, tag: "ONE" }),
      send(server, "PATCH", "/projects/SAGA", { path }),
    ]);

    expect([created.status, patched.status].sort()).toEqual([200, 409]);
  });

  it("refuses a body that is no object, before anything is written", async () => {
    const server = await serving(await projectsRoot());

    const response = await send(server, "POST", "/projects", ["/srv/saga"]);

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

    const response = await send(server, "POST", "/projects?tag=SAGA", { path: await target() });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });
});

describe("PATCH /projects/{project}", () => {
  it("answers with the project as the write left it", async () => {
    const root = await projectsRoot("SAGA");
    const path = await target();
    await plant(projectConfig(root, "SAGA"), `name: Saga\npath: ${path}\n`);
    const server = await serving(root);

    const response = await send(server, "PATCH", "/projects/SAGA", { name: "Renamed" });

    expect(response.status).toBe(200);
    await expect(success<Project>(response)).resolves.toMatchObject({
      data: { tag: "SAGA", name: "Renamed", path, live: true },
      diagnostics: [],
    });
  });

  it("clears the name for a key the body carries as null, and the file no longer holds it", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "name: Saga\npath: /srv/saga\n");
    const server = await serving(root);

    const response = await send(server, "PATCH", "/projects/SAGA", { name: null });

    expect(response.status).toBe(200);
    expect((await success<Project>(response)).data.name).toBeUndefined();
    await expect(readFile(projectConfig(root, "SAGA"), "utf8")).resolves.toBe("path: /srv/saga\n");
  });

  it("leaves the file as it stands for a body naming no key", async () => {
    const root = await projectsRoot("SAGA");
    const text = "name: Saga\n# What it stands for.\npath: /srv/saga\n";
    await plant(projectConfig(root, "SAGA"), text);
    const server = await serving(root);

    const response = await send(server, "PATCH", "/projects/SAGA", {});

    expect(response.status).toBe(200);
    await expect(readFile(projectConfig(root, "SAGA"), "utf8")).resolves.toBe(text);
  });

  it("reports the folder the project stands for as gone", async () => {
    const root = await projectsRoot("SAGA");
    const path = await target();
    await plant(projectConfig(root, "SAGA"), `path: ${path}\n`);
    const server = await serving(root);
    await rm(path, { recursive: true });

    const response = await send(server, "PATCH", "/projects/SAGA", {});

    expect(response.status).toBe(200);
    await expect(success<Project>(response)).resolves.toMatchObject({
      diagnostics: [{ code: "path-missing", path }],
    });
  });

  it("refuses the path of another project, and the file keeps its own", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const own = await target();
    const taken = await target();
    await plant(projectConfig(root, "SAGA"), `path: ${own}\n`);
    await plant(projectConfig(root, "ACME"), `path: ${taken}\n`);
    const server = await serving(root);

    const response = await send(server, "PATCH", "/projects/SAGA", { path: taken });

    expect(response.status).toBe(409);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "path-taken", path: taken });
    await expect(readFile(projectConfig(root, "SAGA"), "utf8")).resolves.toBe(`path: ${own}\n`);
  });

  it("refuses the tag, which no write of a project sets", async () => {
    const server = await serving(await projectsRoot("SAGA"));

    const response = await send(server, "PATCH", "/projects/SAGA", { tag: "ACME" });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "field-not-writable" });
  });

  it("sets the configuration keys, and the reply carries them resolved", async () => {
    const root = await projectsRoot("SAGA");
    await plant(join(root, "workflows", "review", "workflow.yml"), REVIEW_WORKFLOW);
    const rules = join(await target(), "rules.md");
    await writeFile(rules, "# Rules\n");
    const server = await serving(root);

    const response = await send(server, "PATCH", "/projects/SAGA", {
      statuses: ["New", "Shipped"],
      default_status: "New",
      final_statuses: ["Shipped"],
      priorities: ["urgent"],
      workflows: ["review"],
      instructions: [rules],
    });

    expect(response.status).toBe(200);
    expect((await success<Project>(response)).data.config).toEqual({
      statuses: ["New", "Shipped"],
      default_status: "New",
      final_statuses: ["Shipped"],
      priorities: ["urgent"],
      workflows: ["review"],
      instructions: [rules],
    });
  });

  it("clears a configuration key the body carries as null", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "priorities: [urgent]\n");
    const server = await serving(root);

    const response = await send(server, "PATCH", "/projects/SAGA", { priorities: null });

    expect(response.status).toBe(200);
    expect((await success<Project>(response)).data.config).toEqual(BUILT_IN_CONFIG);
  });

  it.each<[string, Record<string, unknown>, number, string]>([
    ["a default_status not among the statuses", { default_status: "Shipped" }, 400, "config-change-invalid"],
    ["a workflow with no directory", { workflows: ["missing"] }, 400, "workflow-unknown"],
    ["a workflow that cannot be loaded", { workflows: ["broken"] }, 422, "workflow-invalid"],
    ["an instruction that names nothing", { instructions: ["/srv/gone.md"] }, 400, "path-invalid"],
  ])("refuses %s, and the file stays as it stands", async (_reason, body, status, code) => {
    const root = await projectsRoot("SAGA");
    await plant(join(root, "workflows", "broken", "workflow.yml"), "steps: [\n");
    await plant(projectConfig(root, "SAGA"), "name: Saga\n");
    const server = await serving(root);

    const response = await send(server, "PATCH", "/projects/SAGA", body);

    expect(response.status).toBe(status);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code });
    await expect(readFile(projectConfig(root, "SAGA"), "utf8")).resolves.toBe("name: Saga\n");
  });

  it("answers 404 for a tag the tree does not list", async () => {
    const server = await serving(await projectsRoot("SAGA"));

    const response = await send(server, "PATCH", "/projects/NOPE", { name: "Saga" });

    expect(response.status).toBe(404);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "project-not-found" });
  });

  it("reads back inside its own turn, so a delete waiting behind it runs after the reply is built", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "name: Saga\npath: /srv/saga\n");
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

    const patching = send(server, "PATCH", "/projects/SAGA", { name: "Renamed" });
    await until(() => reached.includes("write"), "the patch took its turn");
    const removed = await send(server, "DELETE", "/projects/SAGA");

    const patched = await patching;
    expect(patched.status).toBe(200);
    await expect(success<Project>(patched)).resolves.toMatchObject({ data: { name: "Renamed" } });
    expect(removed.status).toBe(200);
    expect(reached).toEqual(["write", "read", "remove"]);
  });
});

describe("DELETE /projects/{project}", () => {
  it("answers with what the project stated, and the tree holds it no more", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "name: Saga\npath: /srv/saga\n");
    const server = await serving(root);

    const response = await send(server, "DELETE", "/projects/SAGA");

    expect(response.status).toBe(200);
    await expect(success<ProjectSummary>(response)).resolves.toEqual({
      data: { tag: "SAGA", name: "Saga", path: "/srv/saga" },
      diagnostics: [],
    });
    expect((await fetch(`${server.url}/projects/SAGA`)).status).toBe(404);
  });

  it("answers 404 for a project a delete already took", async () => {
    const server = await serving(await projectsRoot("SAGA"));
    expect((await send(server, "DELETE", "/projects/SAGA")).status).toBe(200);

    const response = await send(server, "DELETE", "/projects/SAGA");

    expect(response.status).toBe(404);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "project-not-found" });
  });

  it("makes a patch that arrives behind it wait, so the patch is refused rather than faulted", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "name: Saga\npath: /srv/saga\n");
    const server = await serving(root);

    const [removed, patched] = await Promise.all([
      send(server, "DELETE", "/projects/SAGA"),
      send(server, "PATCH", "/projects/SAGA", { name: "Renamed" }),
    ]);

    expect(removed.status).toBe(200);
    expect(patched.status).toBe(404);
    await expect(failure(patched)).resolves.toMatchObject({ kind: "store", code: "project-not-found" });
  });

  it("runs for a project named path while a create holds the path turn", async () => {
    const inner = createProjectHost({ root: await projectsRoot() });
    onTestFinished(() => inner.close());

    const reached: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host: ProjectHost = {
      ...inner,
      async create(input) {
        reached.push("create");
        await held;
        return inner.create(input);
      },
      async remove(tag) {
        reached.push("remove");
        return inner.remove(tag);
      },
    };
    const server = await startTestServer(projectRoutes(host));

    const creating = send(server, "POST", "/projects", { path: await target(), tag: "ONE" });
    await until(() => reached.includes("create"), "the create took the path turn");
    const removing = send(server, "DELETE", "/projects/path");
    await until(() => reached.includes("remove"), "the delete ran while the create held the path turn");
    release();

    expect((await removing).status).toBe(404);
    expect((await creating).status).toBe(200);
  });
});

describe("POST /projects/{project}/rename", () => {
  it("answers with the project under its new tag, its configuration and its index state", async () => {
    const root = await projectsRoot("SAGA");
    const path = await target();
    await plant(projectConfig(root, "SAGA"), `name: Saga\npath: ${path}\n`);
    await plant(taskFile(root, "SAGA", "SAGA-1"), taskText("SAGA-1"));
    const server = await serving(root);

    const response = await send(server, "POST", "/projects/SAGA/rename", { tag: "NEW" });

    expect(response.status).toBe(200);
    await expect(success<Project>(response)).resolves.toEqual({
      data: { tag: "NEW", name: "Saga", path, config: BUILT_IN_CONFIG, live: true },
      diagnostics: [],
    });
  });

  it("serves the renamed project and no longer the old tag", async () => {
    const root = await projectsRoot("SAGA");
    await plant(taskFile(root, "SAGA", "SAGA-1"), taskText("SAGA-1"));
    await plant(taskFile(root, "SAGA", "SAGA-2"), taskText("SAGA-2"));
    const server = await serving(root);

    expect((await send(server, "POST", "/projects/SAGA/rename", { tag: "NEW" })).status).toBe(200);

    expect((await fetch(`${server.url}/projects/SAGA`)).status).toBe(404);
    expect((await fetch(`${server.url}/projects/NEW`)).status).toBe(200);
    const { index } = await server.host.open("NEW");
    expect(index.query().entries.map((entry) => entry.id)).toEqual(["NEW-1", "NEW-2"]);
  });

  it("carries the findings of the rename beside the ones of the read", async () => {
    const root = await projectsRoot("SAGA");
    await plant(join(tasksDir(root, "SAGA"), "notes.md"), "not a task file");
    const server = await serving(root);

    const response = await send(server, "POST", "/projects/SAGA/rename", { tag: "NEW" });

    await expect(success<Project>(response)).resolves.toMatchObject({
      diagnostics: [{ code: "task-file-unexpected", path: join(tasksDir(root, "NEW"), "notes.md") }],
    });
  });

  it.each([
    ["a key no rename states", { tag: "NEW", name: "Saga" }, "field-not-writable"],
    ["a body naming no tag", {}, "field-required"],
    ["a tag the create rule refuses", { tag: "new" }, "tag-invalid"],
  ])("answers 400 for %s", async (_name, body, code) => {
    const server = await serving(await projectsRoot("SAGA"));

    const response = await send(server, "POST", "/projects/SAGA/rename", body);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code });
  });

  it("answers 400 for a query key", async () => {
    const server = await serving(await projectsRoot("SAGA"));

    const response = await send(server, "POST", "/projects/SAGA/rename?tag=NEW", { tag: "NEW" });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });

  it("answers 404 for a tag the tree does not list", async () => {
    const server = await serving(await projectsRoot("SAGA"));

    const response = await send(server, "POST", "/projects/NOPE/rename", { tag: "NEW" });

    expect(response.status).toBe(404);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "project-not-found" });
  });

  it("answers 409 for a tag another project already carries", async () => {
    const server = await serving(await projectsRoot("SAGA", "ACME"));

    const response = await send(server, "POST", "/projects/SAGA/rename", { tag: "ACME" });

    expect(response.status).toBe(409);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "project-exists" });
  });

  it("answers 409 for an entry of the tasks directory named after a task of the new project", async () => {
    const root = await projectsRoot("SAGA");
    await plant(join(tasksDir(root, "SAGA"), "NEW-1.md"), "stray");
    const server = await serving(root);

    const response = await send(server, "POST", "/projects/SAGA/rename", { tag: "NEW" });

    expect(response.status).toBe(409);
    await expect(failure(response)).resolves.toMatchObject({
      kind: "store",
      code: "task-exists",
      path: join(tasksDir(root, "SAGA"), "NEW-1.md"),
    });
  });

  it("answers 422 for a task file it cannot read, and the tree still holds the old tag alone", async () => {
    const root = await projectsRoot("SAGA");
    await plant(taskFile(root, "SAGA", "SAGA-1"), "---\nid: SAGA-1\n");
    const server = await serving(root);

    const response = await send(server, "POST", "/projects/SAGA/rename", { tag: "NEW" });

    expect(response.status).toBe(422);
    await expect(failure(response)).resolves.toMatchObject({ kind: "parse", filename: taskFile(root, "SAGA", "SAGA-1") });
    await expect(readdir(join(root, "projects"))).resolves.toEqual(["SAGA"]);
  });

  it("makes a patch of the new tag wait until the rename is complete", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "name: Saga\npath: /srv/saga\n");
    const server = await serving(root);

    const [renamed, patched] = await Promise.all([
      send(server, "POST", "/projects/SAGA/rename", { tag: "NEW" }),
      send(server, "PATCH", "/projects/NEW", { name: "Renamed" }),
    ]);

    expect(renamed.status).toBe(200);
    expect(patched.status).toBe(200);
    await expect(success<Project>(patched)).resolves.toMatchObject({ data: { tag: "NEW", name: "Renamed" } });
  });

  it("makes a create of the path of the project it renames wait until the rename is complete", async () => {
    const root = await projectsRoot("SAGA");
    const path = await target();
    await plant(projectConfig(root, "SAGA"), `path: ${path}\n`);
    const inner = createProjectHost({ root });
    onTestFinished(() => inner.close());

    const reached: string[] = [];
    let queued!: () => void;
    const behind = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const host: ProjectHost = {
      ...inner,
      async rename(tag, rename) {
        reached.push("rename");
        await behind;
        const findings = await inner.rename(tag, rename);
        reached.push("renamed");
        return findings;
      },
      async create(input) {
        reached.push("create");
        return inner.create(input);
      },
    };
    // The rename is held until the create has entered its handler, which takes
    // the path turn behind the rename, so the order below is the queue's
    // decision.
    const entries = projectRoutes(host).map((entry) => {
      if (entry.route !== routes.createProject) return entry;
      return {
        ...entry,
        handler: (request: HandlerRequest) => {
          queued();
          return entry.handler(request);
        },
      };
    });
    const server = await startTestServer(entries);

    const renaming = send(server, "POST", "/projects/SAGA/rename", { tag: "NEW" });
    await until(() => reached.includes("rename"), "the rename took its turn");
    const created = await send(server, "POST", "/projects", { path, tag: "ONE" });

    expect((await renaming).status).toBe(200);
    expect(created.status).toBe(409);
    await expect(failure(created)).resolves.toMatchObject({
      kind: "store",
      code: "path-taken",
      message: `${path}: project NEW holds this directory`,
    });
    expect(reached).toEqual(["rename", "renamed", "create"]);
  });
});

describe("GET /project", () => {
  it("answers with the summary of the project that holds the directory", async () => {
    const root = await projectsRoot("SAGA");
    const path = await target();
    await plant(projectConfig(root, "SAGA"), `name: Saga\npath: ${path}\n`);
    const inside = join(path, "src");
    await mkdir(inside);
    const server = await serving(root);

    const response = await fetch(`${server.url}/project?path=${encodeURIComponent(inside)}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { tag: "SAGA", name: "Saga", path },
      diagnostics: [],
    });
  });

  it("answers with a data key holding null where no project holds the directory", async () => {
    const server = await serving(await projectsRoot("SAGA"));

    const response = await fetch(`${server.url}/project?path=${encodeURIComponent(await target())}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.hasOwn(body, "data")).toBe(true);
    expect(body).toEqual({ ok: true, data: null, diagnostics: [] });
  });

  it("carries the finding of a project the comparison could not read", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const path = await target();
    await plant(projectConfig(root, "SAGA"), "name: [Saga\n");
    await plant(projectConfig(root, "ACME"), `path: ${path}\n`);
    const server = await serving(root);

    const response = await fetch(`${server.url}/project?path=${encodeURIComponent(path)}`);

    expect(response.status).toBe(200);
    const { data, diagnostics } = await success<ProjectSummary>(response);
    expect(data.tag).toBe("ACME");
    expect(diagnostics).toEqual([
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- every asymmetric matcher is typed `any`.
      { code: "config-unreadable", message: expect.any(String), path: projectConfig(root, "SAGA") },
    ]);
  });

  it("refuses a relative path, which would stand against the daemon's own directory", async () => {
    const server = await serving(await projectsRoot("SAGA"));

    const response = await fetch(`${server.url}/project?path=repo`);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "path-invalid" });
  });

  it.each([
    ["a key the route does not declare", "dir=%2Fsrv%2Frepo"],
    ["no path at all", ""],
    ["an empty path", "path="],
  ])("refuses a query stating %s", async (_name, search) => {
    const server = await serving(await projectsRoot("SAGA"));

    const response = await fetch(`${server.url}/project?${search}`);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });
});
