import { chmod, mkdir, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { bareRoot, codes, plant, storeError, storeFault } from "../store/helpers.js";
import {
  plantFixture,
  plantWorkflow,
  stepsOnly,
  workflowDir,
  workflowFile,
  workflows,
  workflowsDir,
} from "./helpers.js";

describe("read", () => {
  it("returns the steps in the order the file declares them, with every path resolved", async () => {
    const root = await bareRoot();
    await plantFixture(root, "dev", "valid", "full.yml");

    const { workflow, diagnostics } = await workflows(root).read("dev");

    expect(diagnostics).toEqual([]);
    expect(workflow.name).toBe("dev");
    expect(workflow.title).toBe("Engineering task flow");
    expect(workflow.steps.map((step) => step.name)).toEqual(["dev:research", "dev:implement", "user:review"]);
    expect(workflow.steps.map((step) => step.file)).toEqual([
      join(workflowDir(root, "dev"), "steps", "research.md"),
      join(workflowDir(root, "dev"), "steps", "implement.md"),
      "/srv/flows/shared/user-review.md",
    ]);
    expect(workflow.instructions).toEqual([
      join(workflowDir(root, "dev"), "common.md"),
      join(homedir(), "notes", "house-rules.md"),
    ]);
  });

  it("keeps a key of a step entry this format does not define, under custom", async () => {
    const root = await bareRoot();
    await plantFixture(root, "dev", "valid", "full.yml");

    const { steps } = (await workflows(root).read("dev")).workflow;

    expect(steps[0]?.custom).toEqual({ owner: "agent" });
    // An entry that states nothing beyond the two keys carries no custom at all.
    expect(steps[1]?.custom).toBeUndefined();
  });

  it("returns transitions exactly as read and consults nothing in them", async () => {
    const root = await bareRoot();
    await plantFixture(root, "dev", "valid", "full.yml");

    expect((await workflows(root).read("dev")).workflow.transitions).toEqual({
      "dev:research": [{ to: "dev:implement" }],
      "dev:implement": [{ to: "user:review" }],
    });
  });

  it("accepts an edge that names a step the workflow does not declare", async () => {
    const root = await bareRoot();
    await plantWorkflow(root, "dev", `${stepsOnly("research")}transitions:\n  research: [{to: gone}]\n`);

    expect((await workflows(root).read("dev")).workflow.transitions).toEqual({ research: [{ to: "gone" }] });
  });

  it("leaves title, instructions and transitions out of a file that declares steps alone", async () => {
    const root = await bareRoot();
    await plantFixture(root, "dev", "valid", "minimal.yml");

    const { workflow } = await workflows(root).read("dev");

    expect(workflow.title).toBeUndefined();
    expect(workflow.transitions).toBeUndefined();
    expect(workflow.instructions).toEqual([]);
  });

  it("reads a workflow whose whole directory is a symbolic link", async () => {
    const root = await bareRoot();
    const outside = join(root, "outside");
    await plant(join(outside, "workflow.yml"), stepsOnly("research"));
    await mkdir(workflowsDir(root), { recursive: true });
    await symlink(outside, workflowDir(root, "dev"));

    expect((await workflows(root).read("dev")).workflow.steps[0]?.name).toBe("research");
  });
});

describe("the unknown-key diagnostic", () => {
  it("loads the file and names the misspelled key", async () => {
    const root = await bareRoot();
    await plantFixture(root, "dev", "warn", "unknown-key.yml");

    const { workflow, diagnostics } = await workflows(root).read("dev");

    expect(workflow.steps.map((step) => step.name)).toEqual(["research"]);
    expect(codes(diagnostics)).toEqual(["workflow-key-unknown"]);
    expect(diagnostics[0]?.path).toBe(workflowFile(root, "dev"));
    expect(diagnostics[0]?.message).toContain("stpes");
  });
});

describe("a file the loader refuses", () => {
  it.each([
    ["not valid YAML", "not-yaml.yml", "YAML"],
    ["not a mapping", "not-mapping.yml", "mapping"],
    ["missing steps", "steps-missing.yml", '"steps"'],
    ["steps that are not a list", "steps-not-list.yml", '"steps"'],
    ["an empty steps list", "steps-empty.yml", "at least one"],
    ["a step entry that is not a mapping", "step-not-mapping.yml", "must be a mapping"],
    ["a step with no name", "step-name-missing.yml", '"name"'],
    ["a step name that is not a string", "step-name-type.yml", '"name"'],
    ["a step name of another form", "step-name-form.yml", "dev:"],
    ["two steps under one name", "step-name-duplicate.yml", "more than once"],
    ["a step with no file", "step-file-missing.yml", '"file"'],
    ["a step file that is not a string", "step-file-type.yml", '"file"'],
    ["instructions that are not a list", "instructions-not-list.yml", '"instructions"'],
    ["an instructions entry that is not a string", "instructions-entry-type.yml", '"instructions"'],
    ["a title that is not a string", "title-type.yml", '"title"'],
    ["a key that addresses the object model", "unwritable-key.yml", "__proto__"],
    ["a value that contains itself", "unwritable-self.yml", "contain itself"],
  ])("reports workflow-invalid for %s, naming the file", async (_name, file, expected) => {
    const root = await bareRoot();
    await plantFixture(root, "dev", "invalid", file);

    const error = await storeError(workflows(root).read("dev"));

    expect(error.code).toBe("workflow-invalid");
    expect(error.path).toBe(workflowFile(root, "dev"));
    expect(error.message).toContain(expected);
  });

  it("carries the line a YAML fault stands on", async () => {
    const root = await bareRoot();
    await plantFixture(root, "dev", "invalid", "not-yaml.yml");

    expect((await storeError(workflows(root).read("dev"))).message).toContain("line 2");
  });

  it("names the file alone for a YAML fault that reports no position", async () => {
    const root = await bareRoot();
    await plantFixture(root, "dev", "invalid", "alias-unresolved.yml");

    const error = await storeError(workflows(root).read("dev"));

    expect(error.code).toBe("workflow-invalid");
    expect(error.message).not.toContain("line");
  });

  it("reports a directory that holds no workflow.yml", async () => {
    const root = await bareRoot();
    await mkdir(workflowDir(root, "dev"), { recursive: true });

    const error = await storeError(workflows(root).read("dev"));

    expect(error.code).toBe("workflow-invalid");
    expect(error.path).toBe(workflowFile(root, "dev"));
  });

  it("reports a workflow.yml that holds no regular file", async () => {
    const root = await bareRoot();
    await mkdir(workflowFile(root, "dev"), { recursive: true });

    const error = await storeError(workflows(root).read("dev"));

    expect(error.code).toBe("workflow-invalid");
    expect(error.message).toContain("regular file");
  });

  it("reports a workflow.yml the filesystem refuses to open at all", async () => {
    const root = await bareRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));
    // Restored so that the temp tree can be taken down.
    await chmod(workflowDir(root, "dev"), 0o000);
    onTestFinished(() => chmod(workflowDir(root, "dev"), 0o700));

    const error = await storeError(workflows(root).read("dev"));

    expect(error.code).toBe("workflow-invalid");
    expect(error.path).toBe(workflowFile(root, "dev"));
    expect(error.message).toContain("cannot be read");
  });
});

describe("the workflow name rule", () => {
  it.each(["../../../x", "Dev", "dev/research", "dev.research", "dev:research", "-dev", "dev-", "", "."])(
    "refuses %j before any path is built",
    async (name) => {
      const root = await bareRoot();
      await plantWorkflow(root, "dev", stepsOnly("research"));

      const error = await storeError(workflows(root).read(name));

      expect(error.code).toBe("workflow-unknown");
      expect(error.path).toBe(workflowsDir(root));
    },
  );

  it("refuses a name longer than one path component holds, before any path is built", async () => {
    const root = await bareRoot();

    const error = await storeError(workflows(root).read("a".repeat(256)));

    expect(error.code).toBe("workflow-unknown");
    expect(error.path).toBe(workflowsDir(root));
  });

  it("refuses a name of another form from pathsOf, which is where every path is built", async () => {
    const root = await bareRoot();

    const error = storeFault(() => workflows(root).pathsOf("../../../etc"));

    expect(error.code).toBe("workflow-unknown");
    expect(error.path).toBe(workflowsDir(root));
  });

  it.each(["dev", "d", "0", "design-flow", "design_flow", "v2"])("accepts %j", async (name) => {
    const root = await bareRoot();
    await plantWorkflow(root, name, stepsOnly("research"));

    expect((await workflows(root).read(name)).workflow.name).toBe(name);
  });
});

describe("a name that reaches no workflow directory", () => {
  it("reports a directory that does not exist", async () => {
    const root = await bareRoot();

    const error = await storeError(workflows(root).read("dev"));

    expect(error.code).toBe("workflow-unknown");
    expect(error.path).toBe(workflowDir(root, "dev"));
  });

  it("reports a name whose workflows directory holds a file", async () => {
    const root = await bareRoot();
    await plant(workflowsDir(root), "a file where the directory belongs");

    expect((await storeError(workflows(root).read("dev"))).code).toBe("workflow-unknown");
  });
});

describe("the step name rule", () => {
  it.each(["research", "dev:research", "dev:research-2", "a_b", "0", "user:crit"])("accepts %j", async (name) => {
    const root = await bareRoot();
    await plantWorkflow(root, "dev", `steps:\n  - {name: "${name}", file: step.md}\n`);

    expect((await workflows(root).read("dev")).workflow.steps[0]?.name).toBe(name);
  });

  it.each(["Dev", "dev/research", "dev.research", ":research", "research:", "-research", "research-", ""])(
    "refuses %j",
    async (name) => {
      const root = await bareRoot();
      await plantWorkflow(root, "dev", `steps:\n  - {name: "${name}", file: step.md}\n`);

      expect((await storeError(workflows(root).read("dev"))).code).toBe("workflow-invalid");
    },
  );
});

describe("readStep", () => {
  it("resolves a step file through a symbolic link to a directory outside the tree", async () => {
    const root = await bareRoot();
    const outside = join(root, "outside");
    await plant(join(outside, "research.md"), "Research.\n");
    await mkdir(workflowDir(root, "dev"), { recursive: true });
    await symlink(outside, join(workflowDir(root, "dev"), "steps"));
    await plantWorkflow(root, "dev", stepsOnly("research"));

    const { document } = await workflows(root).readStep("dev", "research");

    expect(document.text).toBe("Research.\n");
  });

  it("returns the step entry and the text of its own file", async () => {
    const root = await bareRoot();
    await plantWorkflow(root, "dev", stepsOnly("dev:research"));
    await plant(join(workflowDir(root, "dev"), "steps", "dev-research.md"), "Ask first.\n");

    const { step, document, diagnostics } = await workflows(root).readStep("dev", "dev:research");

    expect(step.name).toBe("dev:research");
    expect(document).toEqual({ path: join(workflowDir(root, "dev"), "steps", "dev-research.md"), text: "Ask first.\n" });
    expect(diagnostics).toEqual([]);
  });

  it("reports a step the workflow does not declare, naming the workflow file", async () => {
    const root = await bareRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));

    const error = await storeError(workflows(root).readStep("dev", "implement"));

    expect(error.code).toBe("step-unknown");
    expect(error.path).toBe(workflowFile(root, "dev"));
  });

  it("reports a step file that does not exist", async () => {
    const root = await bareRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));

    const error = await storeError(workflows(root).readStep("dev", "research"));

    expect(error.code).toBe("step-file-unreadable");
    expect(error.path).toBe(join(workflowDir(root, "dev"), "steps", "research.md"));
  });

  it("reports a step file that holds no regular file", async () => {
    const root = await bareRoot();
    await plantWorkflow(root, "dev", stepsOnly("research"));
    await mkdir(join(workflowDir(root, "dev"), "steps", "research.md"), { recursive: true });

    const error = await storeError(workflows(root).readStep("dev", "research"));

    expect(error.code).toBe("step-file-unreadable");
    expect(error.message).toContain("regular file");
  });

  it("reports a step file the filesystem refuses to open at all", async () => {
    const root = await bareRoot();
    await plantWorkflow(root, "dev", "steps:\n  - {name: research, file: notes/research.md}\n");
    await plant(join(workflowDir(root, "dev"), "notes"), "a file where the directory belongs");

    const error = await storeError(workflows(root).readStep("dev", "research"));

    expect(error.code).toBe("step-file-unreadable");
    expect(error.message).toContain("cannot be read");
  });

  it("raises the faults of read before it looks at the step", async () => {
    const root = await bareRoot();
    await plantFixture(root, "dev", "invalid", "steps-empty.yml");

    expect((await storeError(workflows(root).readStep("dev", "research"))).code).toBe("workflow-invalid");
  });

  it("carries the diagnostics of the load with the step", async () => {
    const root = await bareRoot();
    await plantWorkflow(root, "dev", `stpes: []\n${stepsOnly("research")}`);
    await plant(join(workflowDir(root, "dev"), "steps", "research.md"), "Text.\n");

    expect(codes((await workflows(root).readStep("dev", "research")).diagnostics)).toEqual(["workflow-key-unknown"]);
  });
});

describe("list", () => {
  it("reads a missing workflows directory as an empty list", async () => {
    const root = await bareRoot();

    expect(await workflows(root).list()).toEqual({ names: [], diagnostics: [] });
  });

  it("returns the names it holds, ascending", async () => {
    const root = await bareRoot();
    await plantWorkflow(root, "design", stepsOnly("brief"));
    await plantWorkflow(root, "dev", stepsOnly("research"));

    expect((await workflows(root).list()).names).toEqual(["design", "dev"]);
  });

  it("lists a workflow whose file does not load, because it does not open one", async () => {
    const root = await bareRoot();
    await plantFixture(root, "dev", "invalid", "steps-empty.yml");

    expect((await workflows(root).list()).names).toEqual(["dev"]);
  });

  it("reports a directory that holds no workflow.yml and leaves it out", async () => {
    const root = await bareRoot();
    await mkdir(workflowDir(root, "dev"), { recursive: true });

    const { names, diagnostics } = await workflows(root).list();

    expect(names).toEqual([]);
    expect(codes(diagnostics)).toEqual(["workflow-missing"]);
    expect(diagnostics[0]?.path).toBe(workflowDir(root, "dev"));
  });

  it("reports a directory whose name breaks the rule and leaves it out", async () => {
    const root = await bareRoot();
    await plantWorkflow(root, "Dev", stepsOnly("research"));

    const { names, diagnostics } = await workflows(root).list();

    expect(names).toEqual([]);
    expect(codes(diagnostics)).toEqual(["workflow-missing"]);
    expect(diagnostics[0]?.message).toContain("no workflow name");
  });

  it("passes over a name that holds no directory", async () => {
    const root = await bareRoot();
    await plant(join(workflowsDir(root), "notes.md"), "Text.\n");

    expect(await workflows(root).list()).toEqual({ names: [], diagnostics: [] });
  });

  it("follows a symbolic link to a directory and passes over one that points at nothing", async () => {
    const root = await bareRoot();
    const outside = join(root, "outside");
    await plant(join(outside, "workflow.yml"), stepsOnly("research"));
    await mkdir(workflowsDir(root), { recursive: true });
    await symlink(outside, workflowDir(root, "dev"));
    await symlink(join(root, "nowhere"), workflowDir(root, "gone"));

    expect((await workflows(root).list()).names).toEqual(["dev"]);
  });

  it("passes over a link that closes a loop rather than following it", async () => {
    const root = await bareRoot();
    await mkdir(workflowsDir(root), { recursive: true });
    await symlink(workflowDir(root, "b"), workflowDir(root, "a"));
    await symlink(workflowDir(root, "a"), workflowDir(root, "b"));

    expect(await workflows(root).list()).toEqual({ names: [], diagnostics: [] });
  });

  it("reports a default directory that holds a file, where a missing one is silent", async () => {
    const root = await bareRoot();
    await plant(workflowsDir(root), "a file where the directory belongs");

    const { names, diagnostics } = await workflows(root).list();

    expect(names).toEqual([]);
    expect(codes(diagnostics)).toEqual(["workflows-path-unusable"]);
    expect(diagnostics[0]?.path).toBe(workflowsDir(root));
    expect(diagnostics[0]?.message).toBe("this name holds no directory");
  });
});
