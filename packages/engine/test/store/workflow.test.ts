import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { plantWorkflow, stepsOnly, workflowDir, workflowFile } from "../workflow/helpers.js";
import { codes, plant, project, projectConfig, storeError, taskFile, taskText, tempRoot } from "./helpers.js";

/** A project declaring `dev`, whose workflow declares the named steps and no step files. */
async function declaredTree(...steps: string[]): Promise<string> {
  const root = await tempRoot();
  await plant(projectConfig(root), "workflows: [dev]\n");
  await plantWorkflow(root, "dev", stepsOnly(...(steps.length === 0 ? ["research", "implement"] : steps)));
  return root;
}

/** A task file already carrying a workflow and a step. */
function onStep(id: string, workflow: string, step: string): string {
  return taskText(id, `workflow: ${workflow}\nstep: ${step}\n`);
}

describe("a write that states a workflow", () => {
  it("accepts one the project declares whose directory holds a workflow that loads", async () => {
    const root = await declaredTree();

    await project(root).createTask({ title: "First", workflow: "dev", step: "research" });

    const { task, diagnostics } = await project(root).readTask("TASM-1");
    expect(task.frontmatter.workflow).toBe("dev");
    expect(task.frontmatter.step).toBe("research");
    expect(diagnostics).toEqual([]);
  });

  it("refuses one the project does not declare", async () => {
    const root = await tempRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));

    const error = await storeError(project(root).createTask({ title: "First", workflow: "dev" }));

    expect(error.code).toBe("workflow-unknown");
    expect(error.path).toBe(workflowDir(root, "dev"));
    expect(error.message).toContain("declares no workflow");
  });

  it("refuses one the project declares but whose directory is missing", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\n");

    const error = await storeError(project(root).createTask({ title: "First", workflow: "dev" }));

    expect(error.code).toBe("workflow-unknown");
    expect(error.message).toContain("no directory");
  });

  it("refuses one whose form the name rule rejects, before any path is built", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [../../../Documents]\n");

    const error = await storeError(project(root).createTask({ title: "First", workflow: "../../../Documents" }));

    expect(error.code).toBe("workflow-unknown");
    expect(error.path).toBe(join(root, "workflows"));
  });

  it("refuses one whose directory is present but whose file does not load", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\n");
    await plantWorkflow(root, "dev", "steps: []\n");

    const error = await storeError(project(root).createTask({ title: "First", workflow: "dev" }));

    expect(error.code).toBe("workflow-invalid");
    expect(error.path).toBe(workflowFile(root, "dev"));
  });

  it("refuses a value that is not a string", async () => {
    const root = await declaredTree();

    expect((await storeError(project(root).createTask({ title: "First", workflow: 3 }))).code).toBe("workflow-unknown");
  });

  it("carries the diagnostics of the workflow it loaded", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\n");
    await plantWorkflow(root, "dev", `stpes: []\n${stepsOnly("research")}`);

    const { diagnostics } = await project(root).createTask({ title: "First", workflow: "dev" });

    expect(codes(diagnostics)).toEqual(["workflow-key-unknown"]);
  });
});

describe("a write that states a step", () => {
  it("accepts one the effective workflow declares, without restating the workflow", async () => {
    const root = await declaredTree();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", "workflow: dev\n"));

    await project(root).updateTask("TASM-1", { step: "implement" });

    expect((await project(root).readTask("TASM-1")).task.frontmatter.step).toBe("implement");
  });

  it("refuses one the effective workflow does not declare, naming the workflow file", async () => {
    const root = await declaredTree();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", "workflow: dev\n"));

    const error = await storeError(project(root).updateTask("TASM-1", { step: "review" }));

    expect(error.code).toBe("step-unknown");
    expect(error.path).toBe(workflowFile(root, "dev"));
  });

  it("refuses one when the task names no workflow", async () => {
    const root = await declaredTree();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    const error = await storeError(project(root).updateTask("TASM-1", { step: "research" }));

    expect(error.code).toBe("step-unknown");
    expect(error.path).toBe(taskFile(root, "TASM-1"));
  });

  it("refuses one on create when the same call states no workflow", async () => {
    const root = await declaredTree();

    expect((await storeError(project(root).createTask({ title: "First", step: "research" }))).code).toBe(
      "step-unknown",
    );
  });

  it("refuses one when the change clears the workflow in the same call", async () => {
    const root = await declaredTree();
    await plant(taskFile(root, "TASM-1"), onStep("TASM-1", "dev", "research"));

    expect(
      (await storeError(project(root).updateTask("TASM-1", { workflow: undefined, step: "implement" }))).code,
    ).toBe("step-unknown");
  });

  it("refuses a value that is not a string", async () => {
    const root = await declaredTree();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", "workflow: dev\n"));

    expect((await storeError(project(root).updateTask("TASM-1", { step: 3 }))).code).toBe("step-unknown");
  });

  it("matches exactly, unlike a status", async () => {
    const root = await declaredTree();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", "workflow: dev\n"));

    expect((await storeError(project(root).updateTask("TASM-1", { step: "Research" }))).code).toBe("step-unknown");
  });

  it("refuses one against a stored workflow that no longer loads", async () => {
    const root = await declaredTree();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", "workflow: dev\n"));
    await plantWorkflow(root, "dev", "steps: []\n");

    expect((await storeError(project(root).updateTask("TASM-1", { step: "research" }))).code).toBe("workflow-invalid");
  });

  it("accepts one against a stored workflow the project has since dropped", async () => {
    const root = await declaredTree();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", "workflow: dev\n"));
    await plant(projectConfig(root), "workflows: []\n");

    await project(root).updateTask("TASM-1", { step: "implement" });

    expect((await project(root).readTask("TASM-1")).task.frontmatter.step).toBe("implement");
  });

  it("accepts a step cleared", async () => {
    const root = await declaredTree();
    await plant(taskFile(root, "TASM-1"), onStep("TASM-1", "dev", "research"));

    const { diagnostics } = await project(root).updateTask("TASM-1", { step: undefined });

    expect(diagnostics).toEqual([]);
    expect((await project(root).readTask("TASM-1")).task.frontmatter.step).toBeUndefined();
  });
});

describe("a stored step the change does not state", () => {
  it("is accepted and reported when the new workflow does not declare it", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev, design]\n");
    await plantWorkflow(root, "dev", stepsOnly("research"));
    await plantWorkflow(root, "design", stepsOnly("brief"));
    await plant(taskFile(root, "TASM-1"), onStep("TASM-1", "dev", "research"));

    const { diagnostics } = await project(root).updateTask("TASM-1", { workflow: "design" });

    expect(codes(diagnostics)).toEqual(["step-stale"]);
    expect(diagnostics[0]?.path).toBe(taskFile(root, "TASM-1"));
    expect((await project(root).readTask("TASM-1")).task.frontmatter.step).toBe("research");
  });

  it("is accepted and reported when the workflow is cleared", async () => {
    const root = await declaredTree();
    await plant(taskFile(root, "TASM-1"), onStep("TASM-1", "dev", "research"));

    const { diagnostics } = await project(root).updateTask("TASM-1", { workflow: undefined });

    expect(codes(diagnostics)).toEqual(["step-stale"]);
    expect(diagnostics[0]?.message).toContain("names no workflow");
  });

  it("is silent when the new workflow declares it too", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev, design]\n");
    await plantWorkflow(root, "dev", stepsOnly("research"));
    await plantWorkflow(root, "design", stepsOnly("research"));
    await plant(taskFile(root, "TASM-1"), onStep("TASM-1", "dev", "research"));

    expect((await project(root).updateTask("TASM-1", { workflow: "design" })).diagnostics).toEqual([]);
  });
});

describe("a write that touches neither field", () => {
  it("is accepted while the workflow the task names is missing", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\n");
    await plant(taskFile(root, "TASM-1"), onStep("TASM-1", "dev", "research"));

    const { diagnostics } = await project(root).updateTask("TASM-1", { title: "Renamed" });

    expect(diagnostics).toEqual([]);
  });

  it("is accepted on create in a project that declares no workflow", async () => {
    const root = await tempRoot();

    expect((await project(root).createTask({ title: "First" })).diagnostics).toEqual([]);
  });
});

describe("a read", () => {
  it("reports a workflow that does not exist, naming its directory", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), onStep("TASM-1", "dev", "research"));

    const { diagnostics } = await project(root).readTask("TASM-1");

    expect(codes(diagnostics)).toEqual(["workflow-missing"]);
    expect(diagnostics[0]?.path).toBe(workflowDir(root, "dev"));
  });

  it("reports a workflow that does not load", async () => {
    const root = await tempRoot();
    await plantWorkflow(root, "dev", "steps: []\n");
    await plant(taskFile(root, "TASM-1"), onStep("TASM-1", "dev", "research"));

    const { diagnostics } = await project(root).readTask("TASM-1");

    expect(codes(diagnostics)).toEqual(["workflow-missing"]);
    expect(diagnostics[0]?.path).toBe(workflowFile(root, "dev"));
  });

  it("reports a workflow whose name breaks the rule", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", "workflow: ../../../Documents\n"));

    expect(codes((await project(root).readTask("TASM-1")).diagnostics)).toEqual(["workflow-missing"]);
  });

  it("reports a step the workflow dropped, naming the task file", async () => {
    const root = await declaredTree("implement");
    await plant(taskFile(root, "TASM-1"), onStep("TASM-1", "dev", "research"));

    const { diagnostics } = await project(root).readTask("TASM-1");

    expect(codes(diagnostics)).toEqual(["step-stale"]);
    expect(diagnostics[0]?.path).toBe(taskFile(root, "TASM-1"));
  });

  it("reports a step left behind when the workflow was cleared, and reads no workflow file", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", "step: research\n"));

    const { diagnostics } = await project(root).readTask("TASM-1");

    expect(codes(diagnostics)).toEqual(["step-stale"]);
    expect(diagnostics[0]?.message).toContain("names no workflow");
  });

  it("does not consult the list the project declares", async () => {
    const root = await tempRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));
    await plant(taskFile(root, "TASM-1"), onStep("TASM-1", "dev", "research"));

    expect((await project(root).readTask("TASM-1")).diagnostics).toEqual([]);
  });

  it("stays readable while the configuration of the project is broken", async () => {
    const root = await tempRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));
    await plant(projectConfig(root), "statuses: not a list\n");
    await plant(taskFile(root, "TASM-1"), onStep("TASM-1", "dev", "research"));

    expect((await project(root).readTask("TASM-1")).task.frontmatter.step).toBe("research");
  });

  it("says nothing about a task that names neither field", async () => {
    const root = await declaredTree();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    expect((await project(root).readTask("TASM-1")).diagnostics).toEqual([]);
  });

  it("reports a workflow the filesystem refuses to open, rather than refusing the read", async () => {
    const root = await tempRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));
    await plant(taskFile(root, "TASM-1"), onStep("TASM-1", "dev", "research"));
    // Restored so that the temp tree can be taken down.
    await chmod(workflowDir(root, "dev"), 0o000);
    onTestFinished(() => chmod(workflowDir(root, "dev"), 0o700));

    const { task, diagnostics } = await project(root).readTask("TASM-1");

    expect(task.frontmatter.step).toBe("research");
    expect(codes(diagnostics)).toEqual(["workflow-missing"]);
    expect(diagnostics[0]?.path).toBe(workflowFile(root, "dev"));
  });

  it("reports a workflow whose name is longer than one path component holds", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", `workflow: ${"a".repeat(256)}\n`));

    const { diagnostics } = await project(root).readTask("TASM-1");

    expect(codes(diagnostics)).toEqual(["workflow-missing"]);
    expect(diagnostics[0]?.path).toBe(join(root, "workflows"));
  });

  it("says nothing about the workflow file beyond whether the task fits it", async () => {
    const root = await tempRoot();
    await plantWorkflow(root, "dev", `stpes: []\n${stepsOnly("research")}`);
    await plant(taskFile(root, "TASM-1"), onStep("TASM-1", "dev", "research"));

    expect((await project(root).readTask("TASM-1")).diagnostics).toEqual([]);
  });
});

describe("the configuration keys", () => {
  it("reads workflows and instructions from the project file alone", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\ninstructions: [house.md, ~/away.md, /tmp/x.md]\n");

    const { config } = await project(root).config();

    expect(config.workflows).toEqual(["dev"]);
    expect(config.instructions[0]).toBe(join(root, "projects", "TASM", "house.md"));
    expect(config.instructions[2]).toBe("/tmp/x.md");
  });

  it("reads an explicitly empty list as the absent key", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: []\ninstructions: []\n");

    const { config, diagnostics } = await project(root).config();

    expect(config.workflows).toEqual([]);
    expect(config.instructions).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("refuses a value that is not a list of strings", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: dev\n");

    expect((await storeError(project(root).config())).code).toBe("config-invalid");
  });

  it("does not recognize either key in the user file", async () => {
    const root = await tempRoot();
    await plant(join(root, "config.yml"), "workflows: [dev]\n");

    const { config, diagnostics } = await project(root).config();

    expect(config.workflows).toEqual([]);
    expect(codes(diagnostics)).toEqual(["config-key-unknown"]);
  });
});

describe("the workflow of one operation", () => {
  it("is read once when the write states both fields, which its diagnostic shows", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\n");
    await plantWorkflow(root, "dev", `stpes: []\n${stepsOnly("research")}`);
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    const { diagnostics } = await project(root).updateTask("TASM-1", { workflow: "dev", step: "research" });

    expect(codes(diagnostics)).toEqual(["workflow-key-unknown"]);
  });
});
