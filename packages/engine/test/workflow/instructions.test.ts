import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codes, plant, project, projectConfig, projectDir, storeError, tempRoot } from "../store/helpers.js";
import { plantSteps, plantWorkflow, stepFile, stepsOnly, workflowDir, workflowFile } from "./helpers.js";

/** A project declaring `dev`, whose one step `research` has a file on disk. */
async function researchTree(): Promise<string> {
  const root = await tempRoot();
  await plant(projectConfig(root), "workflows: [dev]\n");
  await plantSteps(root, "dev", "research");
  return root;
}

describe("the order of the documents", () => {
  it("is the workflow, then the project, then the step's own file", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\ninstructions: [house.md]\n");
    await plant(join(projectDir(root), "house.md"), "House rules.\n");
    await plantWorkflow(root, "dev", `instructions:\n  - common.md\n${stepsOnly("research")}`);
    await plant(join(workflowDir(root, "dev"), "common.md"), "Every step.\n");
    await plant(stepFile(root, "dev", "research"), "This step.\n");

    const { documents, diagnostics } = await project(root).stepInstructions("dev", "research");

    expect(documents.map((document) => document.text)).toEqual(["Every step.\n", "House rules.\n", "This step.\n"]);
    expect(documents.map((document) => document.path)).toEqual([
      join(workflowDir(root, "dev"), "common.md"),
      join(projectDir(root), "house.md"),
      stepFile(root, "dev", "research"),
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("holds the step's own file alone when neither list is declared", async () => {
    const root = await researchTree();

    expect((await project(root).stepInstructions("dev", "research")).documents).toEqual([
      { path: stepFile(root, "dev", "research"), text: "Do research.\n" },
    ]);
  });
});

describe("the text of a document", () => {
  it("is the whole file, with nothing parsed and nothing normalized", async () => {
    const root = await researchTree();
    await plant(stepFile(root, "dev", "research"), "---\r\nnot: frontmatter\r\n---\r\n");

    expect((await project(root).stepInstructions("dev", "research")).documents[0]?.text).toBe(
      "---\r\nnot: frontmatter\r\n---\r\n",
    );
  });

  it("is empty for an empty file, which is a legal document", async () => {
    const root = await researchTree();
    await plant(stepFile(root, "dev", "research"), "");

    expect((await project(root).stepInstructions("dev", "research")).documents[0]?.text).toBe("");
  });
});

describe("an instructions entry that cannot be read", () => {
  it("is a diagnostic naming that path, and the other documents are still returned", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\ninstructions: [house.md, gone.md]\n");
    await plant(join(projectDir(root), "house.md"), "House rules.\n");
    await plantSteps(root, "dev", "research");

    const { documents, diagnostics } = await project(root).stepInstructions("dev", "research");

    expect(documents.map((document) => document.text)).toEqual(["House rules.\n", "Do research.\n"]);
    expect(codes(diagnostics)).toEqual(["instruction-file-unreadable"]);
    expect(diagnostics[0]?.path).toBe(join(projectDir(root), "gone.md"));
  });

  it("reports an entry that holds no regular file", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\ninstructions: [notes]\n");
    await mkdir(join(projectDir(root), "notes"), { recursive: true });
    await plantSteps(root, "dev", "research");

    const { diagnostics } = await project(root).stepInstructions("dev", "research");

    expect(codes(diagnostics)).toEqual(["instruction-file-unreadable"]);
    expect(diagnostics[0]?.message).toContain("regular file");
  });

  it("reports an entry the filesystem refuses to open at all", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\ninstructions: [notes/house.md]\n");
    await plant(join(projectDir(root), "notes"), "a file where the directory belongs");
    await plantSteps(root, "dev", "research");

    const { diagnostics } = await project(root).stepInstructions("dev", "research");

    expect(codes(diagnostics)).toEqual(["instruction-file-unreadable"]);
    expect(diagnostics[0]?.message).toContain("cannot be read");
  });

  it("reports an entry of the workflow list the same way", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\n");
    await plantWorkflow(root, "dev", `instructions: [gone.md]\n${stepsOnly("research")}`);
    await plant(stepFile(root, "dev", "research"), "Do research.\n");

    const { documents, diagnostics } = await project(root).stepInstructions("dev", "research");

    expect(documents).toHaveLength(1);
    expect(codes(diagnostics)).toEqual(["instruction-file-unreadable"]);
    expect(diagnostics[0]?.path).toBe(join(workflowDir(root, "dev"), "gone.md"));
  });
});

describe("the step's own file", () => {
  it("refuses the call when it cannot be read, because it is what the caller asked for", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\n");
    await plantWorkflow(root, "dev", stepsOnly("research"));

    const error = await storeError(project(root).stepInstructions("dev", "research"));

    expect(error.code).toBe("step-file-unreadable");
    expect(error.path).toBe(stepFile(root, "dev", "research"));
  });
});

describe("the project the call sits on", () => {
  it("refuses a workflow the project does not declare, which readStep cannot check", async () => {
    const root = await tempRoot();
    await plantSteps(root, "dev", "research");

    const error = await storeError(project(root).stepInstructions("dev", "research"));

    expect(error.code).toBe("workflow-unknown");
    expect(error.path).toBe(workflowDir(root, "dev"));
    expect(error.message).toContain("declares no workflow");
  });
});

describe("a workflow or a step the call cannot reach", () => {
  it("refuses a workflow name of another form before any path is built", async () => {
    const root = await tempRoot();

    const error = await storeError(project(root).stepInstructions("../../../x", "research"));

    expect(error.code).toBe("workflow-unknown");
    expect(error.path).toBe(join(root, "workflows"));
  });

  it("refuses a workflow whose directory is missing", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\n");

    expect((await storeError(project(root).stepInstructions("dev", "research"))).code).toBe("workflow-unknown");
  });

  it("refuses a workflow whose file does not load", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\n");
    await plantWorkflow(root, "dev", "steps: []\n");

    const error = await storeError(project(root).stepInstructions("dev", "research"));

    expect(error.code).toBe("workflow-invalid");
    expect(error.path).toBe(workflowFile(root, "dev"));
  });

  it("refuses a step the workflow does not declare, naming the workflow file", async () => {
    const root = await researchTree();

    const error = await storeError(project(root).stepInstructions("dev", "implement"));

    expect(error.code).toBe("step-unknown");
    expect(error.path).toBe(workflowFile(root, "dev"));
  });
});

describe("the diagnostics of the load", () => {
  it("are carried with the documents", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [dev]\n");
    await plantWorkflow(root, "dev", `stpes: []\n${stepsOnly("research")}`);
    await plant(stepFile(root, "dev", "research"), "Do research.\n");

    expect(codes((await project(root).stepInstructions("dev", "research")).diagnostics)).toEqual([
      "workflow-key-unknown",
    ]);
  });
});
