import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Workflow } from "@tasma/protocol";
import { workflowRoutes } from "../../src/workflows/routes.js";
import {
  failure,
  plant,
  plantSteps,
  plantWorkflow,
  projectsRoot,
  send,
  startTestServer,
  stepFile,
  stepsOnly,
  success,
  userConfig,
  workflowDir,
} from "../helpers.js";
import type { TestServer } from "../helpers.js";

/** A daemon serving the workflow routes over a tree, closed when the test ends. */
async function serving(root: string): Promise<TestServer> {
  return startTestServer(workflowRoutes({ root }));
}

describe("GET /workflows", () => {
  it("answers with the name of every workflow of the tree, ascending", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "review", stepsOnly("read"));
    await plantWorkflow(root, "dev", stepsOnly("research"));
    const server = await serving(root);

    const response = await fetch(`${server.url}/workflows`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: ["dev", "review"], diagnostics: [] });
  });

  it("answers with the empty list, and says nothing, for a tree holding no workflows directory", async () => {
    const server = await serving(await projectsRoot());

    await expect((await fetch(`${server.url}/workflows`)).json()).resolves.toEqual({
      ok: true,
      data: [],
      diagnostics: [],
    });
  });

  it("leaves out a directory holding no workflow file, and reports it", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));
    await mkdir(workflowDir(root, "empty"), { recursive: true });
    const server = await serving(root);

    const { data, diagnostics } = await success<string[]>(await fetch(`${server.url}/workflows`));

    expect(data).toEqual(["dev"]);
    expect(diagnostics).toEqual([
      {
        code: "workflow-missing",
        message: expect.stringContaining("workflow.yml") as string,
        path: workflowDir(root, "empty"),
      },
    ]);
  });

  it("answers with the empty list, and reports it, for a configured directory that is not there", async () => {
    const root = await projectsRoot();
    const path = join(root, "elsewhere", "flows");
    await plant(userConfig(root), `workflows_path: ${JSON.stringify(path)}\n`);
    const server = await serving(root);

    const { data, diagnostics } = await success<string[]>(await fetch(`${server.url}/workflows`));

    expect(data).toEqual([]);
    expect(diagnostics).toEqual([
      { code: "workflows-path-unusable", message: expect.stringContaining("no directory") as string, path },
    ]);
  });

  it("falls back to the built-in directory, and reports it, for a user configuration it cannot read", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));
    await plant(userConfig(root), "workflows_path: [\n");
    const server = await serving(root);

    const { data, diagnostics } = await success<string[]>(await fetch(`${server.url}/workflows`));

    expect(data).toEqual(["dev"]);
    expect(diagnostics).toEqual([
      { code: "config-unreadable", message: expect.stringContaining("was refused") as string, path: userConfig(root) },
    ]);
  });

  it("reports a key of the user configuration this engine does not know", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));
    await plant(userConfig(root), "workflow_path: /elsewhere\n");
    const server = await serving(root);

    const { data, diagnostics } = await success<string[]>(await fetch(`${server.url}/workflows`));

    expect(data).toEqual(["dev"]);
    expect(diagnostics).toEqual([
      {
        code: "config-key-unknown",
        message: expect.stringContaining('"workflow_path"') as string,
        path: userConfig(root),
      },
    ]);
  });

  it("refuses a query key, since the route declares none", async () => {
    const server = await serving(await projectsRoot());

    const response = await fetch(`${server.url}/workflows?name=dev`);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });
});

describe("GET /workflows/{workflow}", () => {
  it("answers with the definition, carrying transitions exactly as read", async () => {
    const root = await projectsRoot();
    await plantWorkflow(
      root,
      "dev",
      `title: Development\ninstructions: [shared.md]\ntransitions: {research: [implement]}\n${stepsOnly("research")}`,
    );
    const server = await serving(root);

    const response = await fetch(`${server.url}/workflows/dev`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        name: "dev",
        title: "Development",
        steps: [{ name: "research", file: stepFile(root, "dev", "research"), owner: "agent" }],
        instructions: [join(workflowDir(root, "dev"), "shared.md")],
        transitions: { research: ["implement"] },
      },
      diagnostics: [],
    });
  });

  it("carries the findings of the file it read", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "dev", `stpes: []\n${stepsOnly("research")}`);
    const server = await serving(root);

    const { diagnostics } = await success<Workflow>(await fetch(`${server.url}/workflows/dev`));

    expect(diagnostics).toMatchObject([{ code: "workflow-key-unknown" }]);
  });

  it.each([
    ["a name no directory stands under", "nope"],
    ["a name of a form no workflow carries", "Dev"],
  ])("refuses %s", async (_description, name) => {
    const server = await serving(await projectsRoot());

    const response = await fetch(`${server.url}/workflows/${name}`);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "workflow-unknown" });
  });

  it("refuses a workflow whose file does not load", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "dev", "steps: []\n");
    const server = await serving(root);

    const response = await fetch(`${server.url}/workflows/dev`);

    expect(response.status).toBe(422);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "workflow-invalid" });
  });

  it("answers a file edited between two requests with what it now holds", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));
    const server = await serving(root);

    await expect(success<Workflow>(await fetch(`${server.url}/workflows/dev`))).resolves.toMatchObject({
      data: { steps: [{ name: "research" }] },
    });
    await plantWorkflow(root, "dev", stepsOnly("implement"));

    await expect(success<Workflow>(await fetch(`${server.url}/workflows/dev`))).resolves.toMatchObject({
      data: { steps: [{ name: "implement" }] },
    });
  });
});

describe("GET /workflows/{workflow}/steps/{step}", () => {
  it("answers with the step and the document its file holds", async () => {
    const root = await projectsRoot();
    await plantSteps(root, "dev", "dev:research");
    const file = stepFile(root, "dev", "dev:research");
    const server = await serving(root);

    const response = await fetch(`${server.url}/workflows/dev/steps/dev%3Aresearch`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        step: { name: "dev:research", file, owner: "agent" },
        document: { path: file, text: "Do dev:research.\n" },
      },
      diagnostics: [],
    });
  });

  it("refuses a step the workflow does not declare", async () => {
    const root = await projectsRoot();
    await plantSteps(root, "dev", "research");
    const server = await serving(root);

    const response = await fetch(`${server.url}/workflows/dev/steps/implement`);

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "step-unknown" });
  });

  it("refuses a step whose file cannot be read", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));
    const server = await serving(root);

    const response = await fetch(`${server.url}/workflows/dev/steps/research`);

    expect(response.status).toBe(422);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "step-file-unreadable" });
  });

  it("serves the read alone, naming it in the refusal of any other method", async () => {
    const root = await projectsRoot();
    await plantSteps(root, "dev", "research");
    const server = await serving(root);

    const response = await send(server, "POST", "/workflows/dev/steps/research");

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "method-not-allowed" });
  });

  it("serves no route above the step of a workflow", async () => {
    const server = await serving(await projectsRoot());

    const response = await fetch(`${server.url}/workflows/dev/steps`);

    expect(response.status).toBe(404);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "route-not-found" });
  });
});
