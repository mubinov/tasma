import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { routes } from "@tasma/protocol";
import type { Project, UserConfig } from "@tasma/protocol";
import { configRoutes } from "../../src/config/routes.js";
import type { HandlerRequest } from "../../src/http/router.js";
import { createProjectHost } from "../../src/projects/host.js";
import type { ProjectHost } from "../../src/projects/host.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import {
  failure,
  plant,
  plantWorkflow,
  projectConfig,
  projectsRoot,
  send,
  startTestServer,
  stepsOnly,
  success,
  until,
  userConfig,
} from "../helpers.js";
import type { TestServer } from "../helpers.js";

/** A daemon serving the configuration routes over a tree, closed when the test ends. */
async function serving(root: string): Promise<TestServer> {
  return startTestServer(configRoutes({ root, writes: new WriteQueue() }));
}

describe("GET /config", () => {
  it("answers with every key, and whether the file sets it", async () => {
    const root = await projectsRoot();
    await plant(userConfig(root), "priorities: [urgent, later]\n");
    const server = await serving(root);

    const response = await fetch(`${server.url}/config`);

    expect(response.status).toBe(200);
    await expect(success<UserConfig>(response)).resolves.toEqual({
      data: {
        path: userConfig(root),
        statuses: { value: ["Backlog", "To Do", "In Progress", "Done"], set: false },
        default_status: { value: "Backlog", set: false },
        final_statuses: { value: ["Done"], set: false },
        priorities: { value: ["urgent", "later"], set: true },
        workflows_path: { value: join(root, "workflows"), set: false },
      },
      diagnostics: [],
    });
  });

  it("answers 422 for a file the reader refuses", async () => {
    const root = await projectsRoot();
    await plant(userConfig(root), "default_status: Review\n");
    const server = await serving(root);

    const response = await fetch(`${server.url}/config`);

    expect(response.status).toBe(422);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "config-invalid" });
  });
});

describe("PATCH /config", () => {
  it("writes the change and answers with the new values", async () => {
    const root = await projectsRoot();
    await plant(userConfig(root), "priorities: [urgent]\n");
    const server = await serving(root);

    const response = await send(server, "PATCH", "/config", { statuses: ["New", "Done"], priorities: null });

    expect(response.status).toBe(200);
    const { data } = await success<UserConfig>(response);
    expect(data.statuses).toEqual({ value: ["New", "Done"], set: true });
    expect(data.priorities).toEqual({ value: ["high", "medium", "low"], set: false });
    expect(await readFile(userConfig(root), "utf8")).toBe("statuses:\n  - New\n  - Done\n");
  });

  it.each([
    ["a key that is not one of the five", async () => ({ workflows: ["dev"] }), 400, "field-not-writable"],
    ["an empty list", async () => ({ statuses: [] }), 400, "config-change-invalid"],
    ["a relative workflows_path", async () => ({ workflows_path: "flows" }), 400, "path-invalid"],
    [
      "a workflows_path that holds no workflow a project lists",
      async (root: string) => {
        await plantWorkflow(root, "review", stepsOnly("check"));
        await plant(projectConfig(root, "SAGA"), "workflows: [review]\n");
        const empty = join(root, "empty");
        await mkdir(empty);
        return { workflows_path: empty };
      },
      400,
      "workflow-unknown",
    ],
    [
      "a workflows_path from which a workflow a project lists cannot be loaded",
      async (root: string) => {
        await plantWorkflow(root, "review", stepsOnly("check"));
        await plant(projectConfig(root, "SAGA"), "workflows: [review]\n");
        await plant(join(root, "flows", "review", "workflow.yml"), "steps: [\n");
        return { workflows_path: join(root, "flows") };
      },
      422,
      "workflow-invalid",
    ],
    [
      "a change the stored file refuses on a key it does not touch",
      async (root: string) => {
        await plant(userConfig(root), "statuses: [New]\ndefault_status: Review\n");
        return { priorities: ["urgent"] };
      },
      422,
      "config-invalid",
    ],
  ])("answers %s with its status", async (_case, body, status, code) => {
    const root = await projectsRoot("SAGA");
    const server = await serving(root);

    const response = await send(server, "PATCH", "/config", await body(root));

    expect(response.status).toBe(status);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code });
  });

  it("takes turns with a project patch of the statuses", async () => {
    const root = await projectsRoot("SAGA");
    await plant(userConfig(root), "statuses: [Backlog, Review, Done]\n");
    const inner = createProjectHost({ root });
    onTestFinished(() => inner.close());

    const reached: string[] = [];
    let queued!: () => void;
    const behind = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const host: ProjectHost = {
      ...inner,
      async update(tag, change) {
        reached.push("project");
        await behind;
        return inner.update(tag, change);
      },
    };
    const writes = new WriteQueue();
    // The project write is held until the configuration write has entered its
    // handler, so the order below is the queue's decision.
    const entries = configRoutes({ root, writes }).map((entry) => {
      if (entry.route !== routes.updateUserConfig) return entry;
      return {
        ...entry,
        handler: (request: HandlerRequest) => {
          queued();
          return entry.handler(request);
        },
      };
    });
    const server = await startTestServer([...projectRoutes(host, writes), ...entries]);

    const patching = send(server, "PATCH", "/projects/SAGA", { default_status: "Review" });
    await until(() => reached.includes("project"), "the project patch took its turn");
    const configured = await send(server, "PATCH", "/config", { statuses: ["Backlog", "Done"] });

    const patched = await patching;
    expect(patched.status).toBe(200);
    await expect(success<Project>(patched)).resolves.toMatchObject({ data: { config: { default_status: "Review" } } });
    // Run after the project write, the change breaks the project it now holds.
    expect(configured.status).toBe(400);
    await expect(failure(configured)).resolves.toMatchObject({ code: "config-change-invalid" });
  });
});
