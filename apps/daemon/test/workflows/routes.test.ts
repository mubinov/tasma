import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { routes, type Project, type Workflow, type WorkflowReceipt } from "@tasma/protocol";
import type { HandlerRequest } from "../../src/http/router.js";
import { createProjectHost, type ProjectHost } from "../../src/projects/host.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { CONFIG_KEY, WriteQueue } from "../../src/tasks/serialize.js";
import { workflowRoutes } from "../../src/workflows/routes.js";
import {
  failure,
  plant,
  plantSteps,
  plantWorkflow,
  projectConfig,
  projectsRoot,
  send,
  startTestServer,
  stepFile,
  stepsOnly,
  success,
  taskFile,
  taskText,
  until,
  userConfig,
  workflowDir,
  workflowFile,
} from "../helpers.js";
import type { TestServer } from "../helpers.js";

/** A daemon serving the workflow routes over a tree. */
async function serving(root: string, writes = new WriteQueue()): Promise<TestServer> {
  return startTestServer(workflowRoutes({ root, writes }));
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
        file: workflowFile(root, "dev"),
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

/** A step document outside the workflows tree, as a write states one. */
async function stepDocument(root: string, name: string): Promise<string> {
  const path = join(root, "docs", `${name}.md`);
  await plant(path, `Do ${name}.\n`);
  return path;
}

/** A task on one step of one workflow, in one status. */
function taskOn(id: string, workflow: string, step: string, status = "To Do"): string {
  return taskText(id).replace("status: To Do\n", `status: ${status}\nworkflow: ${workflow}\nstep: "${step}"\n`);
}

describe("POST /workflows", () => {
  it("creates a workflow and answers with it", async () => {
    const root = await projectsRoot();
    const file = await stepDocument(root, "one");
    const server = await serving(root);

    const response = await send(server, "POST", "/workflows", {
      name: "flow-a",
      title: "Flow A",
      steps: [{ name: "a:one", owner: "agent", file }],
    });

    expect(response.status).toBe(200);
    const { data } = await success<Workflow>(response);
    expect(data).toMatchObject({ name: "flow-a", title: "Flow A", steps: [{ name: "a:one", owner: "agent", file }] });
    expect(await readdir(workflowDir(root, "flow-a"))).toEqual(["workflow.yml"]);
  });

  it("refuses a name that exists with 409", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "flow-a", stepsOnly("one"));
    const server = await serving(root);

    const response = await send(server, "POST", "/workflows", {
      name: "flow-a",
      steps: [{ name: "one", owner: "agent", file: await stepDocument(root, "one") }],
    });

    expect(response.status).toBe(409);
    await expect(failure(response)).resolves.toMatchObject({ kind: "store", code: "workflow-exists" });
  });

  it.each<[string, unknown, number, string]>([
    ["a body with no name", { steps: [] }, 400, "workflow-unknown"],
    ["an owner outside the set", { name: "flow-a", owner: "robot" }, 400, "workflow-change-invalid"],
  ])("refuses %s", async (_case, body, status, code) => {
    const server = await serving(await projectsRoot());

    const response = await send(server, "POST", "/workflows", body);

    expect(response.status).toBe(status);
    await expect(failure(response)).resolves.toMatchObject({ code });
  });
});

describe("PATCH /workflows/{workflow}", () => {
  it("changes a workflow and answers with it", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "flow-a", "title: Flow A\nsteps: [{name: one, file: /one.md, owner: agent}]\n");
    const server = await serving(root);

    const response = await send(server, "PATCH", "/workflows/flow-a", { title: null });

    expect(response.status).toBe(200);
    const { data, diagnostics } = await success<Workflow>(response);
    expect(data.title).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });

  it("refuses a missing workflow with 400", async () => {
    const server = await serving(await projectsRoot());

    const response = await send(server, "PATCH", "/workflows/flow-a", { title: "Flow A" });

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ code: "workflow-unknown" });
  });

  it("names each open task on a removed step, in every project", async () => {
    const root = await projectsRoot("ALPHA", "BETA");
    const one = await stepDocument(root, "one");
    const two = await stepDocument(root, "two");
    await plantWorkflow(root, "flow-a", `steps: [{name: "a:one", file: ${one}, owner: agent}, {name: "a:two", file: ${two}, owner: human}]\n`);
    await plantWorkflow(root, "flow-b", stepsOnly("a:two"));
    await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskOn("ALPHA-1", "flow-a", "a:two"));
    await plant(taskFile(root, "ALPHA", "ALPHA-2"), taskOn("ALPHA-2", "flow-a", "a:two", "Done"));
    await plant(taskFile(root, "ALPHA", "ALPHA-3"), taskOn("ALPHA-3", "flow-a", "a:one"));
    await plant(taskFile(root, "ALPHA", "ALPHA-4"), taskText("ALPHA-4").replace("status: To Do\n", "status: To Do\nworkflow: flow-a\n"));
    await plant(taskFile(root, "BETA", "BETA-1"), taskOn("BETA-1", "flow-a", "a:two"));
    await plant(taskFile(root, "BETA", "BETA-2"), taskOn("BETA-2", "flow-b", "a:two"));
    const server = await serving(root);

    const response = await send(server, "PATCH", "/workflows/flow-a", {
      steps: [{ name: "a:one", owner: "agent", file: one }, { name: "a:three", owner: "human", file: two }],
    });

    expect(response.status).toBe(200);
    const { diagnostics } = await success<Workflow>(response);
    expect(diagnostics).toEqual([
      {
        code: "step-stale",
        message: 'ALPHA-1 carries the step "a:two", which the workflow "flow-a" does not declare',
        path: taskFile(root, "ALPHA", "ALPHA-1"),
      },
      {
        code: "step-stale",
        message: 'BETA-1 carries the step "a:two", which the workflow "flow-a" does not declare',
        path: taskFile(root, "BETA", "BETA-1"),
      },
    ]);
  });

  it("passes over a project that cannot be opened", async () => {
    const root = await projectsRoot("ALPHA");
    const one = await stepDocument(root, "one");
    await plantWorkflow(root, "flow-a", `steps: [{name: "a:one", file: ${one}, owner: agent}, {name: "a:two", file: ${one}, owner: agent}]\n`);
    await plant(projectConfig(root, "ALPHA"), "statuses: [\n");
    await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskOn("ALPHA-1", "flow-a", "a:two"));
    const server = await serving(root);

    const response = await send(server, "PATCH", "/workflows/flow-a", {
      steps: [{ name: "a:one", owner: "agent", file: one }],
    });

    expect(response.status).toBe(200);
    await expect(success<Workflow>(response)).resolves.toMatchObject({ diagnostics: [] });
  });

  it("answers with the written workflow when the tree cannot be read for the notes", async () => {
    const root = await projectsRoot();
    const one = await stepDocument(root, "one");
    await plantWorkflow(root, "flow-a", `steps: [{name: "a:one", file: ${one}, owner: agent}, {name: "a:two", file: ${one}, owner: agent}]\n`);
    await plant(join(root, "projects"), "not a directory\n");
    const server = await serving(root);

    const response = await send(server, "PATCH", "/workflows/flow-a", {
      steps: [{ name: "a:one", owner: "agent", file: one }],
    });

    expect(response.status).toBe(200);
    await expect(success<Workflow>(response)).resolves.toMatchObject({
      data: { steps: [{ name: "a:one" }] },
      diagnostics: [],
    });
  });
});

describe("DELETE /workflows/{workflow}", () => {
  it("removes a workflow and answers with its name", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "flow-a", stepsOnly("one"));
    const server = await serving(root);

    const response = await send(server, "DELETE", "/workflows/flow-a");

    expect(response.status).toBe(200);
    await expect(success<WorkflowReceipt>(response)).resolves.toEqual({ data: { name: "flow-a" }, diagnostics: [] });
    await expect(readdir(workflowDir(root, "flow-a"))).rejects.toThrow();
  });

  it("refuses a workflow a project lists with 409", async () => {
    const root = await projectsRoot("ALPHA");
    await plantWorkflow(root, "flow-a", stepsOnly("one"));
    await plant(projectConfig(root, "ALPHA"), "workflows: [flow-a]\n");
    const server = await serving(root);

    const response = await send(server, "DELETE", "/workflows/flow-a");

    expect(response.status).toBe(409);
    await expect(failure(response)).resolves.toMatchObject({ code: "workflow-in-use" });
  });

  it("refuses a directory that holds no workflow.yml and keeps what it holds", async () => {
    const root = await projectsRoot();
    await plant(join(workflowDir(root, "notes"), "draft.md"), "Keep me.\n");
    const server = await serving(root);

    const response = await send(server, "DELETE", "/workflows/notes");

    expect(response.status).toBe(422);
    await expect(failure(response)).resolves.toMatchObject({ code: "workflow-invalid" });
    expect(await readdir(workflowDir(root, "notes"))).toEqual(["draft.md"]);
  });

  it.each<[string, string, unknown]>([
    ["POST", "/workflows", { name: "flow-b", steps: [] }],
    ["PATCH", "/workflows/flow-a", { title: "Flow A" }],
    ["DELETE", "/workflows/flow-a", undefined],
  ])("runs %s %s after a write of the user's configuration", async (method, path, body) => {
    const root = await projectsRoot();
    await plantWorkflow(root, "flow-a", stepsOnly("one"));
    const writes = new WriteQueue();
    const server = await serving(root, writes);
    let release!: () => void;
    const configWrite = writes.run(CONFIG_KEY, () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    let answered = false;

    const answer = send(server, method, path, body).then((response) => {
      answered = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(answered).toBe(false);
    release();
    await configWrite;
    expect((await answer).status).not.toBe(500);
  });

  it("takes turns with a project patch that adds the workflow", async () => {
    const root = await projectsRoot("ALPHA");
    await plantWorkflow(root, "flow-a", stepsOnly("one"));
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
    // The project write is held until the delete has entered its handler, so
    // the order below is the queue's decision.
    const entries = workflowRoutes({ root, writes }).map((entry) => {
      if (entry.route !== routes.deleteWorkflow) return entry;
      return {
        ...entry,
        handler: (request: HandlerRequest) => {
          queued();
          return entry.handler(request);
        },
      };
    });
    const server = await startTestServer([...projectRoutes(host, writes), ...entries]);

    const patching = send(server, "PATCH", "/projects/ALPHA", { workflows: ["flow-a"] });
    await until(() => reached.includes("project"), "the project patch took its turn");
    const removal = send(server, "DELETE", "/workflows/flow-a");

    const patched = await patching;
    expect(patched.status).toBe(200);
    await expect(success<Project>(patched)).resolves.toMatchObject({ data: { config: { workflows: ["flow-a"] } } });
    // Run after the patch, the delete finds the project that lists the workflow.
    const removed = await removal;
    expect(removed.status).toBe(409);
    await expect(failure(removed)).resolves.toMatchObject({ code: "workflow-in-use" });
    expect(await readdir(workflowDir(root, "flow-a"))).toEqual(["workflow.yml"]);
  });
});
