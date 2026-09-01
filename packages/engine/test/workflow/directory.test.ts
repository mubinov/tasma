import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { bareRoot, codes, plant, storeError } from "../store/helpers.js";
import {
  outsideWorkflows,
  plantWorkflow,
  stepFile,
  stepsOnly,
  workflowDir,
  workflowFile,
  workflows,
} from "./helpers.js";

describe("a configured workflows directory", () => {
  it("lists the workflows it holds and none of those under the default", async () => {
    const root = await bareRoot();
    const path = outsideWorkflows(root);
    await plantWorkflow(root, "shared", stepsOnly("research"), path);
    await plantWorkflow(root, "dev", stepsOnly("research"));

    expect(await workflows(root, path).list()).toEqual({ names: ["shared"], diagnostics: [] });
  });

  it("reads a workflow from it, resolving a step file against the workflow's own directory", async () => {
    const root = await bareRoot();
    const path = outsideWorkflows(root);
    await plantWorkflow(root, "shared", stepsOnly("research"), path);
    await plant(stepFile(root, "shared", "research", path), "Research.\n");

    const { step, document } = await workflows(root, path).readStep("shared", "research");

    expect(step.file).toBe(join(path, "shared", "steps", "research.md"));
    expect(document.text).toBe("Research.\n");
  });

  it("names it in the fault for a workflow that is not there", async () => {
    const root = await bareRoot();
    const path = outsideWorkflows(root);
    await mkdir(path, { recursive: true });

    const error = await storeError(workflows(root, path).read("dev"));

    expect(error.code).toBe("workflow-unknown");
    expect(error.path).toBe(join(path, "dev"));
  });

  it("reports the entry rules of a listing whether the tree was configured or defaulted", async () => {
    const root = await bareRoot();
    const path = outsideWorkflows(root);
    await plantWorkflow(root, "Dev", stepsOnly("research"), path);
    await mkdir(join(path, "notes"), { recursive: true });

    const { names, diagnostics } = await workflows(root, path).list();

    expect(names).toEqual([]);
    expect(codes(diagnostics)).toEqual(["workflow-missing", "workflow-missing"]);
  });
});

describe("a workflows directory that cannot be used", () => {
  it("reports a configured directory that does not exist, where the default stays silent", async () => {
    const root = await bareRoot();
    const path = outsideWorkflows(root);

    const { names, diagnostics } = await workflows(root, path).list();

    expect(names).toEqual([]);
    expect(codes(diagnostics)).toEqual(["workflows-path-unusable"]);
    expect(diagnostics[0]?.path).toBe(path);
    expect(diagnostics[0]?.message).toBe("there is no directory under this name");
    expect(await workflows(root).list()).toEqual({ names: [], diagnostics: [] });
  });

  it("reports a configured name that holds a file", async () => {
    const root = await bareRoot();
    const path = outsideWorkflows(root);
    await plant(path, "a file where the directory belongs");

    const { names, diagnostics } = await workflows(root, path).list();

    expect(names).toEqual([]);
    expect(codes(diagnostics)).toEqual(["workflows-path-unusable"]);
    expect(diagnostics[0]?.message).toBe("this name holds no directory");
  });

  it("reports a directory the filesystem refuses to read, naming the reason", async () => {
    const root = await bareRoot();
    const path = outsideWorkflows(root);
    await mkdir(path, { recursive: true });
    // Restored so that the temp tree can be taken down.
    await chmod(path, 0o000);
    onTestFinished(() => chmod(path, 0o700));

    const { names, diagnostics } = await workflows(root, path).list();

    expect(names).toEqual([]);
    expect(codes(diagnostics)).toEqual(["workflows-path-unusable"]);
    expect(diagnostics[0]?.message).toContain("cannot be read");
  });

  it("still reads one workflow by name, because a read builds its own path", async () => {
    const root = await bareRoot();
    const path = outsideWorkflows(root);
    await plantWorkflow(root, "shared", stepsOnly("research"), path);
    await chmod(path, 0o000);
    onTestFinished(() => chmod(path, 0o700));

    // The directory above the workflow is unreadable, so the open of its file
    // fails rather than the name resolving to nothing.
    const error = await storeError(workflows(root, path).read("shared"));

    expect(error.code).toBe("workflow-invalid");
    expect(error.path).toBe(workflowFile(root, "shared", path));
  });
});

describe("the built-in default", () => {
  it("stands beside projects/ under the root when no file names a directory", async () => {
    const root = await bareRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));

    expect(workflows(root).directory).toBe(join(root, "workflows"));
    expect((await workflows(root).list()).names).toEqual(["dev"]);
    expect(workflowDir(root, "dev")).toBe(join(root, "workflows", "dev"));
  });
});
