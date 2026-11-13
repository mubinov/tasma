import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { openWorkflows } from "@tasma/engine";
import type { Failure, FeedEvent, Workflow, WorkflowInstall, WorkflowReceipt } from "@tasma/protocol";
import { WriteQueue } from "../../src/tasks/serialize.js";
import { installBaseWorkflow } from "../../src/workflows/install.js";
import { workflowRoutes } from "../../src/workflows/routes.js";
import {
  failure,
  get,
  plant,
  projectsRoot,
  send,
  startTestServer,
  success,
  userConfig,
  workflowDir,
  workflowFile,
} from "../helpers.js";
import type { TestServer } from "../helpers.js";

const BASE_WORKFLOWS = join(import.meta.dirname, "..", "..", "base-workflows");

type Tree = {
  temp: string;
  root: string;
  server: TestServer;
  events: FeedEvent[];
  install: (name?: string) => Promise<Response>;
};

/** A daemon over `<temp>/.tasma`, so a test can see each entry the install makes beside the tree. */
async function tree(): Promise<Tree> {
  const temp = await projectsRoot();
  const root = join(temp, ".tasma");

  await mkdir(root);

  const events: FeedEvent[] = [];
  const server = await startTestServer(workflowRoutes({
    root,
    writes: new WriteQueue(),
    publish: (event) => {
      events.push(event);
    },
  }));

  return {
    temp,
    root,
    server,
    events,
    install: (name = "dev") => send(server, "POST", `/workflows/${name}/install`, {}),
  };
}

function setWorkflowsPath(root: string, path: string): Promise<void> {
  return plant(userConfig(root), `workflows_path: ${JSON.stringify(path)}\n`);
}

/** Every entry under a folder, by its path from there. */
async function listing(folder: string): Promise<string[]> {
  return (await readdir(folder, { recursive: true })).sort();
}

/** The files of the base workflow `dev`, by their path from its folder, without its workflow.yml. */
async function baseDocuments(): Promise<string[]> {
  const entries = await listing(join(BASE_WORKFLOWS, "dev"));
  const files = [];

  for (const entry of entries) {
    if (entry === "workflow.yml" || basename(entry).startsWith(".")) continue;
    if ((await stat(join(BASE_WORKFLOWS, "dev", entry))).isFile()) files.push(entry);
  }

  return files;
}

/** Runs one install, asserts a refusal with `path-taken` and an unchanged disk, and answers the refusal. */
async function refusesUnchanged(place: Tree, path: string): Promise<Failure> {
  const before = await listing(place.temp);
  const response = await place.install();

  expect(response.status).toBe(409);

  const refusal = await failure(response);

  expect(refusal).toMatchObject({ kind: "store", code: "path-taken", path });
  expect(await listing(place.temp)).toEqual(before);

  return refusal;
}

async function installsTo(install: Tree["install"], folder: string): Promise<void> {
  expect((await success<WorkflowInstall>(await install())).data).toEqual({ result: "installed", folder });
}

describe("POST /workflows/{workflow}/install", () => {
  it("writes the documents and the shipped workflow.yml into the workflow folder, and nothing beside the tree", async () => {
    const { temp, root, server, install } = await tree();
    const folder = workflowDir(root, "dev");

    const response = await install();

    expect(response.status).toBe(200);
    expect(await success<WorkflowInstall>(response)).toEqual({ data: { result: "installed", folder }, diagnostics: [] });
    expect(await readdir(temp)).toEqual([".tasma"]);

    const documents = await baseDocuments();

    expect(documents).toContain("instructions.md");
    expect(await listing(folder)).toEqual([...documents, "steps", "workflow.yml"].sort());

    for (const document of documents) {
      expect(await readFile(join(folder, document)), document).toEqual(await readFile(join(BASE_WORKFLOWS, "dev", document)));
    }

    expect(await readFile(workflowFile(root, "dev"), "utf8"))
      .toBe(await readFile(join(BASE_WORKFLOWS, "dev", "workflow.yml"), "utf8"));

    const base = (await openWorkflows({ path: BASE_WORKFLOWS }).read("dev")).workflow;
    const { data: stored } = await success<Workflow>(await get(server, "/workflows/dev"));
    const inFolder = (path: string) => path.replace(join(BASE_WORKFLOWS, "dev"), folder);

    expect(stored.file).toBe(workflowFile(root, "dev"));
    expect(stored.title).toBe(base.title);
    expect(stored.instructions).toEqual(base.instructions.map(inFolder));
    expect(stored.steps).toHaveLength(7);
    expect(stored.steps).toEqual(base.steps.map((step) => ({ ...step, file: inFolder(step.file) })));

    for (const path of [...stored.instructions, ...stored.steps.map((step) => step.file)]) {
      expect(documents.map((document) => join(folder, document)), path).toContain(path);
    }
  });

  it("reports exists on a second run, and a changed document keeps its change", async () => {
    const { root, install } = await tree();
    const document = join(workflowDir(root, "dev"), "instructions.md");

    await install();
    await writeFile(document, "Changed by the user.\n");

    const response = await install();

    expect(response.status).toBe(200);
    expect(await success<WorkflowInstall>(response)).toEqual({ data: { result: "exists" }, diagnostics: [] });
    expect(await readFile(document, "utf8")).toBe("Changed by the user.\n");
  });

  it("reports exists for a workflow.yml that does not load, and leaves it as it is", async () => {
    const { root, install } = await tree();
    const file = workflowFile(root, "dev");

    await plant(file, "steps: [\n");

    expect(await success<WorkflowInstall>(await install())).toEqual({ data: { result: "exists" }, diagnostics: [] });
    expect(await readFile(file, "utf8")).toBe("steps: [\n");
  });

  it("puts the documents in the workflow folder under a workflows_path outside the tree", async () => {
    const { temp, root, server, install } = await tree();
    const flows = join(temp, "shared", "flows");

    await mkdir(flows, { recursive: true });
    await setWorkflowsPath(root, flows);

    await installsTo(install, join(flows, "dev"));
    expect(await listing(join(flows, "dev"))).toContain("instructions.md");

    const { data: stored } = await success<Workflow>(await get(server, "/workflows/dev"));

    expect(stored.file).toBe(join(flows, "dev", "workflow.yml"));
    expect(stored.instructions).toEqual([join(flows, "dev", "instructions.md")]);
  });

  it("installs again after a delete", async () => {
    const { root, server, install } = await tree();

    await install();
    expect((await success<WorkflowReceipt>(await send(server, "DELETE", "/workflows/dev"))).data).toEqual({ name: "dev" });

    await installsTo(install, workflowDir(root, "dev"));
  });

  it("refuses a folder at the place of the workflow that holds no workflow.yml, and makes no copy", async () => {
    const place = await tree();
    const folder = workflowDir(place.root, "dev");

    await mkdir(folder, { recursive: true });

    expect((await refusesUnchanged(place, folder)).message).toContain("holds no workflow.yml");
  });

  it("treats a workflow.yml that is a folder as a folder that holds no workflow.yml", async () => {
    const place = await tree();
    const folder = workflowDir(place.root, "dev");

    await mkdir(join(folder, "workflow.yml"), { recursive: true });
    await refusesUnchanged(place, folder);
  });

  it("refuses a file or a link to nothing at the place of the workflow", async () => {
    const asFile = await tree();
    const file = workflowDir(asFile.root, "dev");

    await plant(file, "A file of the user.\n");
    await refusesUnchanged(asFile, file);

    const toNothing = await tree();
    const link = workflowDir(toNothing.root, "dev");

    await mkdir(join(toNothing.root, "workflows"));
    await symlink(join(toNothing.temp, "nowhere"), link);
    await refusesUnchanged(toNothing, link);
  });

  it("answers a workflows_path that is a file as internal, writes nothing, and a retry succeeds", async () => {
    const { temp, root, install } = await tree();
    const regularFile = join(temp, "flows");

    await writeFile(regularFile, "A file of the user.\n");
    await setWorkflowsPath(root, regularFile);

    const before = await listing(temp);
    const response = await install();

    expect(response.status).toBe(500);
    expect(await failure(response)).toMatchObject({ kind: "daemon", code: "internal" });
    expect(await listing(temp)).toEqual(before);

    await mkdir(join(temp, "elsewhere"));
    await setWorkflowsPath(root, join(temp, "elsewhere", "flows"));
    await installsTo(install, join(temp, "elsewhere", "flows", "dev"));
  });

  it("refuses a name no base workflow has, with no write", async () => {
    const { temp, install } = await tree();
    const before = await listing(temp);
    const response = await install("nope");

    expect(response.status).toBe(400);

    const refusal = await failure(response);

    expect(refusal).toMatchObject({ kind: "store", code: "workflow-unknown" });
    expect(refusal.message).toContain('"nope"');
    expect(await listing(temp)).toEqual(before);
  });

  it("refuses a broken config.yml, with no write", async () => {
    const { temp, root, install } = await tree();

    await plant(userConfig(root), "workflows_path: [\n");

    const before = await listing(temp);
    const response = await install();

    expect(response.status).toBe(422);
    expect(await failure(response)).toMatchObject({ kind: "store", code: "config-invalid" });
    expect(await listing(temp)).toEqual(before);
  });

  it("answers an unknown fault of the look at the workflow as internal", async () => {
    const { temp, root, install } = await tree();

    await symlink(join(temp, "loop"), join(temp, "loop"));
    await setWorkflowsPath(root, join(temp, "loop", "flows"));

    const response = await install();

    expect(response.status).toBe(500);
    expect(await failure(response)).toMatchObject({ kind: "daemon", code: "internal" });
  });

  it("answers one installed and one exists for two requests at the same time", async () => {
    const { install } = await tree();

    const answers = await Promise.all([install(), install()]);
    const bodies = await Promise.all(answers.map((answer) => success<WorkflowInstall>(answer)));
    const results = bodies.map((body) => body.data.result);

    expect(results.sort()).toEqual(["exists", "installed"]);
  });

  it("publishes one workflow event for installed and none for exists", async () => {
    const { events, install } = await tree();

    await install();
    expect(events).toEqual([{ kind: "workflow", name: "dev", change: "created" }]);

    await install();
    expect(events).toHaveLength(1);
  });

  it("refuses a query", async () => {
    const { server } = await tree();

    expect((await send(server, "POST", "/workflows/dev/install?force=1", {})).status).toBe(400);
  });
});

describe("installBaseWorkflow", () => {
  const baseFile = (name: string, path: string) => `../../base-workflows/${name}/${path}`;

  it("takes a new base folder, writes its workflow.yml unchanged, and makes each inner folder", async () => {
    const { root } = await tree();
    const folder = workflowDir(root, "flow-a");
    const definition = 'steps:\n  - {name: "one", file: a/b/one.md, owner: agent}\n  - {name: "two", file: a/two.md, owner: human}\n';

    const installed = await installBaseWorkflow("flow-a", {
      root,
      files: {
        [baseFile("flow-a", "workflow.yml")]: definition,
        [baseFile("flow-a", "a/b/one.md")]: "Do one.\n",
        [baseFile("flow-a", "a/two.md")]: "Do two.\n",
        [baseFile("flow-b", "workflow.yml")]: "steps: []\n",
      },
    });

    expect(installed).toEqual({ data: { result: "installed", folder }, diagnostics: [] });
    expect(await listing(folder)).toEqual(["a", "a/b", "a/b/one.md", "a/two.md", "workflow.yml"]);
    expect(await readFile(join(folder, "a", "b", "one.md"), "utf8")).toBe("Do one.\n");
    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toBe(definition);
    expect(await readdir(join(root, "workflows"))).toEqual(["flow-a"]);

    const { workflow } = await openWorkflows({ root }).read("flow-a");

    expect(workflow.title).toBeUndefined();
    expect(workflow.instructions).toEqual([]);
    expect(workflow.steps.map((step) => step.file)).toEqual([join(folder, "a", "b", "one.md"), join(folder, "a", "two.md")]);
  });

  it("passes a refusal of the engine on unchanged, and leaves no workflow folder", async () => {
    const { root } = await tree();

    await expect(installBaseWorkflow("flow-a", {
      root,
      files: {
        [baseFile("flow-a", "workflow.yml")]: 'steps:\n  - {name: "one", file: missing.md, owner: agent}\n',
        [baseFile("flow-a", "kept.md")]: "Kept.\n",
      },
    })).rejects.toMatchObject({ code: "workflow-change-invalid" });
    await expect(readdir(workflowDir(root, "flow-a"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a name that holds only documents and no workflow.yml", async () => {
    const { root } = await tree();

    await expect(installBaseWorkflow("flow-a", {
      root,
      files: { [baseFile("flow-a", "one.md")]: "Do one.\n" },
    })).rejects.toMatchObject({ code: "workflow-unknown", path: undefined });
  });
});
