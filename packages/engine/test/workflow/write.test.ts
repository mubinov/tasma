import { existsSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkflow,
  openWritableWorkflows,
  removeWorkflow,
  type StepInput,
  updateWorkflow,
  type WorkflowChange,
  type WorkflowInput,
} from "@tasma/engine";
import { bareRoot, plant, projectConfig, storeError, tempRoot, userConfig } from "../store/helpers.js";
import {
  outsideWorkflows,
  plantWorkflow,
  plantWorkflowsPath,
  workflowDir,
  workflowFile,
  workflows,
  workflowsDir,
} from "./helpers.js";

/** A step document outside the workflows tree, which a step entry can name. */
async function stepDocument(root: string, name: string): Promise<string> {
  const path = join(root, "docs", `${name}.md`);
  await plant(path, `Do ${name}.\n`);
  return path;
}

/** Steps whose documents stand on disk, each owned by an agent. */
async function steps(root: string, ...names: string[]): Promise<StepInput[]> {
  return Promise.all(names.map(async (name) => ({ name, owner: "agent" as const, file: await stepDocument(root, name) })));
}

function create(root: string, name: string, input: WorkflowInput) {
  return createWorkflow(workflows(root), name, input);
}

function edit(root: string, name: string, change: WorkflowChange) {
  return updateWorkflow(workflows(root), name, change);
}

describe("creating a workflow", () => {
  it("writes a file the reader loads back", async () => {
    const root = await tempRoot();
    const rules = await stepDocument(root, "rules");
    const input = { title: "Flow A", instructions: [rules], steps: await steps(root, "a:one", "a:two") };

    const { workflow } = await create(root, "flow-a", input);

    expect(workflow).toMatchObject({ name: "flow-a", title: "Flow A", instructions: [rules] });
    expect(workflow.steps.map((step) => step.name)).toEqual(["a:one", "a:two"]);
    expect((await workflows(root).read("flow-a")).workflow).toEqual(workflow);
  });

  it("states title, instructions and steps in that order, each step as a flow mapping", async () => {
    const root = await tempRoot();
    const rules = await stepDocument(root, "rules");
    const [one] = await steps(root, "a:one");

    await create(root, "flow-a", { steps: [one!], instructions: [rules], title: "Flow A" });

    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toBe(
      `title: Flow A\ninstructions:\n  - ${rules}\nsteps:\n  - { name: a:one, file: ${one!.file}, owner: agent }\n`,
    );
  });

  it("stores a ~/ path as stated", async () => {
    const root = await tempRoot();
    await plant(join(process.env.HOME!, "flow-a-step.md"), "Do it.\n");

    await create(root, "flow-a", { steps: [{ name: "one", owner: "human", file: "~/flow-a-step.md" }] });

    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toContain("file: ~/flow-a-step.md");
  });

  it("creates the built-in workflows directory when it is not there", async () => {
    const root = await tempRoot();

    await create(root, "flow-a", { steps: await steps(root, "one") });

    expect(await readdir(workflowsDir(root))).toEqual(["flow-a"]);
  });

  it.each<[string, (root: string) => Promise<WorkflowInput>, string]>([
    ["a step name that breaks the rule", async (root) => ({ steps: await steps(root, "Bad Name") }), "Bad Name"],
    ["a duplicate step name", async (root) => ({ steps: await steps(root, "one", "one") }), "more than once"],
    [
      "an unknown owner",
      async (root) => ({ steps: [{ ...(await steps(root, "one"))[0]!, owner: "robot" as never }] }),
      '"owner"',
    ],
    ["zero steps", () => Promise.resolve({ steps: [] }), "at least one entry"],
    ["no steps", () => Promise.resolve({} as WorkflowInput), '"steps"'],
    ["an empty title", async (root) => ({ title: "", steps: await steps(root, "one") }), '"title"'],
    ["a cleared title", async (root) => ({ title: null as never, steps: await steps(root, "one") }), "cleared"],
    ["an unknown field", async (root) => ({ steps: await steps(root, "one"), colour: "red" } as never), '"colour"'],
    [
      "an unknown step key",
      async (root) => ({ steps: [{ ...(await steps(root, "one"))[0]!, retries: 2 } as never] }),
      '"retries"',
    ],
    ["a step without a file", () => Promise.resolve({ steps: [{ name: "one", owner: "agent" } as never] }), '"file"'],
    ["a step that is no mapping", () => Promise.resolve({ steps: ["one"] as never }), "mapping"],
    ["steps that are no list", () => Promise.resolve({ steps: "one" as never }), "list"],
    ["instructions that are no list", async (root) => ({ instructions: "x" as never, steps: await steps(root, "one") }), "list"],
    ["an empty instruction", async (root) => ({ instructions: [""], steps: await steps(root, "one") }), "not empty"],
    ["an input that is no mapping", () => Promise.resolve(null as never), "mapping"],
  ])("refuses %s with workflow-change-invalid and leaves no directory", async (_case, input, fragment) => {
    const root = await tempRoot();

    const error = await storeError(create(root, "flow-a", await input(root)));

    expect(error.code).toBe("workflow-change-invalid");
    expect(error.description).toContain(fragment);
    await expect(readdir(workflowDir(root, "flow-a"))).rejects.toThrow();
  });

  it.each<[string, (root: string) => Promise<WorkflowInput>]>([
    ["a missing step document", () => Promise.resolve({ steps: [{ name: "one", owner: "agent", file: "/nowhere/one.md" }] })],
    ["a relative step document", () => Promise.resolve({ steps: [{ name: "one", owner: "agent", file: "one.md" }] })],
    ["a step document that is a directory", async (root) => ({ steps: [{ name: "one", owner: "agent", file: root }] })],
    [
      "a missing instruction document",
      async (root) => ({ instructions: ["/nowhere/rules.md"], steps: await steps(root, "one") }),
    ],
  ])("refuses %s with path-invalid", async (_case, input) => {
    const root = await tempRoot();

    const error = await storeError(create(root, "flow-a", await input(root)));

    expect(error.code).toBe("path-invalid");
    await expect(readdir(workflowDir(root, "flow-a"))).rejects.toThrow();
  });

  it("refuses a bad workflow name with workflow-unknown", async () => {
    const root = await tempRoot();

    const error = await storeError(create(root, "../flow", { steps: await steps(root, "one") }));

    expect(error.code).toBe("workflow-unknown");
  });

  it("refuses a name that exists with workflow-exists and leaves the file alone", async () => {
    const root = await tempRoot();
    await plantWorkflow(root, "flow-a", "# kept\nsteps: []\n");

    const error = await storeError(create(root, "flow-a", { steps: await steps(root, "one") }));

    expect(error.code).toBe("workflow-exists");
    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toBe("# kept\nsteps: []\n");
  });

  it("passes on a fault of the filesystem other than an existing name", async () => {
    const root = await tempRoot();
    await plant(workflowsDir(root), "not a directory\n");

    await expect(create(root, "flow-a", { steps: await steps(root, "one") })).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("removes the directory when the file cannot be written", async () => {
    const root = await tempRoot();
    const input = { steps: await steps(root, "one") };
    const store = workflows(root);
    const failing = { ...store, pathsOf: (name: string) => ({ ...store.pathsOf(name), file: join(root, "no", "dir", "workflow.yml") }) };

    await expect(createWorkflow(failing, "flow-a", input)).rejects.toThrow();

    await expect(readdir(workflowDir(root, "flow-a"))).rejects.toThrow();
  });

  it("keeps the new directory when another writer put a file in it", async () => {
    const root = await tempRoot();
    const input = { steps: await steps(root, "one") };
    const store = workflows(root);
    const directory = workflowDir(root, "flow-a");
    // The file is named once the directory stands, so another writer's file lands between the two.
    const pathsOf = (name: string) => ({
      directory: store.pathsOf(name).directory,
      get file() {
        if (existsSync(directory)) writeFileSync(join(directory, "other.md"), "Written by another process.\n");
        return join(root, "no", "dir", "workflow.yml");
      },
    });

    await expect(createWorkflow({ ...store, pathsOf }, "flow-a", input)).rejects.toThrow();

    expect(await readdir(workflowDir(root, "flow-a"))).toEqual(["other.md"]);
  });
});

/** A workflow file written by hand, with everything a write has to keep. */
const HAND_WRITTEN = (one: string, two: string) => `# The flow of the saga team.
title: Flow A # the display name
steps:
  - {name: "a:one", file: ${one}, owner: agent, retries: 2}
  - {name: "a:two", file: ${two}, owner: human}
transitions:
  "a:one": [{to: "a:two"}]
colour: red
`;

async function handWritten(root: string): Promise<{ one: StepInput; two: StepInput }> {
  const [one, two] = await steps(root, "a:one", "a:two");
  await plantWorkflow(root, "flow-a", HAND_WRITTEN(one!.file, two!.file));
  return { one: one!, two: { ...two!, owner: "human" } };
}

describe("editing a workflow", () => {
  it("sets the title and keeps comments, key order, transitions and unknown keys", async () => {
    const root = await tempRoot();
    await handWritten(root);

    const { workflow } = await edit(root, "flow-a", { title: "Flow B" });

    const text = await readFile(workflowFile(root, "flow-a"), "utf8");
    expect(workflow.title).toBe("Flow B");
    expect(text).toContain("# The flow of the saga team.\ntitle: Flow B # the display name\nsteps:");
    expect(text).toContain('transitions:\n  "a:one": [ { to: "a:two" } ]\ncolour: red\n');
  });

  it("keeps the custom keys of a kept step and drops those of a renamed step", async () => {
    const root = await tempRoot();
    const { one, two } = await handWritten(root);

    const kept = await edit(root, "flow-a", { steps: [one, two] });
    expect(kept.workflow.steps[0]!.custom).toEqual({ retries: 2 });
    expect(kept.removedSteps).toEqual([]);

    const renamed = await edit(root, "flow-a", { steps: [{ ...one, name: "a:first" }, two] });
    expect(renamed.workflow.steps[0]!.custom).toBeUndefined();
    expect(renamed.removedSteps).toEqual(["a:one"]);
  });

  it("writes each step as a flow mapping and keeps the style of a flow list", async () => {
    const root = await tempRoot();
    const [one] = await steps(root, "one");
    await plantWorkflow(root, "flow-a", `steps: [{name: one, file: ${one!.file}, owner: agent}]\n`);

    await edit(root, "flow-a", { steps: [{ ...one!, owner: "human" }] });

    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toBe(
      `steps: [ { name: one, file: ${one!.file}, owner: human } ]\n`,
    );
  });

  it("sets and removes the instructions", async () => {
    const root = await tempRoot();
    await handWritten(root);
    const rules = await stepDocument(root, "rules");

    expect((await edit(root, "flow-a", { instructions: [rules] })).workflow.instructions).toEqual([rules]);
    expect((await edit(root, "flow-a", { instructions: null })).workflow.instructions).toEqual([]);
    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).not.toContain("instructions");
  });

  it.each([
    ["no list", "steps: broken\n"],
    ["entries with no name", "steps: [broken, {file: /x.md}]\n"],
  ])("repairs a file whose steps are %s", async (_case, text) => {
    const root = await tempRoot();
    const [one] = await steps(root, "one");
    await plantWorkflow(root, "flow-a", text);

    const { workflow, removedSteps } = await edit(root, "flow-a", { steps: [one!] });

    expect(workflow.steps.map((step) => step.name)).toEqual(["one"]);
    expect(removedSteps).toEqual([]);
  });

  it("removes the title", async () => {
    const root = await tempRoot();
    await handWritten(root);

    const { workflow } = await edit(root, "flow-a", { title: null });

    expect(workflow.title).toBeUndefined();
    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).not.toContain("title");
  });

  it("writes a value equal to the stored one", async () => {
    const root = await tempRoot();
    await handWritten(root);

    const { workflow } = await edit(root, "flow-a", { title: "Flow A" });

    expect(workflow.title).toBe("Flow A");
  });

  it("writes nothing for a change that states no field", async () => {
    const root = await tempRoot();
    const { one, two } = await handWritten(root);

    const result = await edit(root, "flow-a", {});

    expect(result.removedSteps).toEqual([]);
    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toBe(HAND_WRITTEN(one.file, two.file));
  });

  it.each<[string, WorkflowChange, string]>([
    ["cleared steps", { steps: null as never }, "cleared"],
    ["an empty step file", { steps: [{ name: "x", owner: "agent", file: "" }] }, '"file"'],
  ])("refuses %s with workflow-change-invalid", async (_case, change, fragment) => {
    const root = await tempRoot();
    await handWritten(root);

    const error = await storeError(edit(root, "flow-a", change));

    expect(error.code).toBe("workflow-change-invalid");
    expect(error.description).toContain(fragment);
  });

  it("refuses a change the reader would refuse and leaves the file alone", async () => {
    const root = await tempRoot();
    const { one, two } = await handWritten(root);

    const error = await storeError(edit(root, "flow-a", { steps: [one, { ...two, name: "a:one" }] }));

    expect(error.code).toBe("workflow-change-invalid");
    expect(error.description).toContain('"a:one" is declared more than once');
    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toBe(HAND_WRITTEN(one.file, two.file));
  });

  it("refuses a symlinked workflow.yml with workflow-invalid", async () => {
    const root = await tempRoot();
    const { one } = await handWritten(root);
    const target = join(await bareRoot(), "workflow.yml");
    await writeFile(target, `steps: [{name: one, file: ${one.file}, owner: agent}]\n`);
    await mkdir(workflowDir(root, "flow-b"), { recursive: true });
    await symlink(target, workflowFile(root, "flow-b"));

    const error = await storeError(edit(root, "flow-b", { title: "Flow B" }));

    expect(error.code).toBe("workflow-invalid");
  });

  it("follows a symlinked workflow directory", async () => {
    const root = await tempRoot();
    const { one } = await handWritten(root);
    const target = join(await bareRoot(), "flow-b");
    await plant(join(target, "workflow.yml"), `steps: [{name: one, file: ${one.file}, owner: agent}]\n`);
    await mkdir(workflowsDir(root), { recursive: true });
    await symlink(target, workflowDir(root, "flow-b"));

    await edit(root, "flow-b", { title: "Flow B" });

    expect(await readFile(join(target, "workflow.yml"), "utf8")).toContain("title: Flow B");
  });

  it("refuses a missing workflow with workflow-unknown", async () => {
    const root = await tempRoot();

    expect((await storeError(edit(root, "flow-a", { title: "Flow A" }))).code).toBe("workflow-unknown");
  });

  it("refuses a directory with no workflow.yml with workflow-invalid", async () => {
    const root = await tempRoot();
    await mkdir(workflowDir(root, "flow-a"), { recursive: true });

    expect((await storeError(edit(root, "flow-a", { title: "Flow A" }))).code).toBe("workflow-invalid");
  });

  it("refuses a key whose anchor another value reads", async () => {
    const root = await tempRoot();
    const [one] = await steps(root, "one");
    await plantWorkflow(root, "flow-a", `title: &name Flow A\nsteps: [{name: one, file: ${one!.file}, owner: agent}]\ncolour: *name\n`);

    const error = await storeError(edit(root, "flow-a", { title: "Flow B" }));

    expect(error.code).toBe("workflow-invalid");
    expect(error.description).toContain("anchor");
  });

  it("refuses a missing step document with path-invalid", async () => {
    const root = await tempRoot();
    await handWritten(root);

    const error = await storeError(edit(root, "flow-a", { steps: [{ name: "one", owner: "agent", file: "/nowhere.md" }] }));

    expect(error.code).toBe("path-invalid");
  });
});

describe("deleting a workflow", () => {
  it("removes the directory", async () => {
    const root = await bareRoot();
    await handWritten(root);

    await removeWorkflow("flow-a", { root });

    expect(await readdir(workflowsDir(root))).toEqual([]);
  });

  it("removes only the link of a symlinked directory", async () => {
    const root = await bareRoot();
    const target = join(await bareRoot(), "flow-b");
    await plant(join(target, "workflow.yml"), "steps: []\n");
    await mkdir(workflowsDir(root), { recursive: true });
    await symlink(target, workflowDir(root, "flow-b"));

    await removeWorkflow("flow-b", { root });

    expect(await readdir(workflowsDir(root))).toEqual([]);
    expect(await readdir(target)).toEqual(["workflow.yml"]);
  });

  it("refuses a workflow that projects list with workflow-in-use", async () => {
    const root = await tempRoot();
    await handWritten(root);
    await plant(projectConfig(root), "workflows: [flow-a]\n");
    await plant(projectConfig(root, "BETA"), "workflows: [flow-b, flow-a]\n");

    const error = await storeError(removeWorkflow("flow-a", { root }));

    expect(error.code).toBe("workflow-in-use");
    expect(error.description).toBe('the workflow "flow-a" is listed by the projects BETA, SAGA');
    expect(await readdir(workflowsDir(root))).toEqual(["flow-a"]);
  });

  it("refuses when a project configuration cannot be read", async () => {
    const root = await tempRoot();
    await handWritten(root);
    await plant(projectConfig(root), "workflows: [unclosed\n");

    const error = await storeError(removeWorkflow("flow-a", { root }));

    expect(error.code).toBe("workflow-in-use");
    expect(error.description).toBe('the configuration of the project SAGA cannot be read, so it may list the workflow "flow-a"');
  });

  it("refuses when a discovered project holds no configuration file, and keeps the workflow", async () => {
    const root = await tempRoot();
    await handWritten(root);

    const error = await storeError(removeWorkflow("flow-a", { root }));

    expect(error.code).toBe("workflow-in-use");
    expect(error.description).toBe('the configuration of the project SAGA cannot be read, so it may list the workflow "flow-a"');
    expect(await readdir(workflowsDir(root))).toEqual(["flow-a"]);
  });

  it("passes over a project that lists other workflows", async () => {
    const root = await tempRoot();
    await handWritten(root);
    await plant(projectConfig(root), "workflows: [flow-b]\n");

    await removeWorkflow("flow-a", { root });

    expect(await readdir(workflowsDir(root))).toEqual([]);
  });

  it("refuses a missing workflow with workflow-unknown", async () => {
    const root = await tempRoot();

    expect((await storeError(removeWorkflow("flow-a", { root }))).code).toBe("workflow-unknown");
  });

  it("refuses a directory with no workflow.yml and leaves what it holds", async () => {
    const root = await tempRoot();
    await plant(join(workflowDir(root, "notes"), "draft.md"), "Keep me.\n");

    const error = await storeError(removeWorkflow("notes", { root }));

    expect(error.code).toBe("workflow-invalid");
    expect(await readdir(workflowDir(root, "notes"))).toEqual(["draft.md"]);
  });

  it("removes the workflow from the directory the user's configuration names", async () => {
    const root = await bareRoot();
    const path = outsideWorkflows(root);
    await plantWorkflowsPath(root, path);
    await plantWorkflow(root, "flow-a", "steps: []\n", path);

    await removeWorkflow("flow-a", { root });

    expect(await readdir(path)).toEqual([]);
  });
});

describe("the workflows of a tree for a write", () => {
  it("stands on the directory the user's configuration names", async () => {
    const root = await bareRoot();
    const path = outsideWorkflows(root);
    await plantWorkflowsPath(root, path);

    expect((await openWritableWorkflows(root)).directory).toBe(path);
  });

  it("stands on the built-in directory when no configuration names one", async () => {
    const root = await bareRoot();

    expect((await openWritableWorkflows(root)).directory).toBe(workflowsDir(root));
  });

  it("refuses a configuration it cannot resolve rather than degrading", async () => {
    const root = await bareRoot();
    await plant(userConfig(root), "workflows_path: [\n");

    expect((await storeError(openWritableWorkflows(root))).code).toBe("config-invalid");
  });
});
