import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { diffTree, readTree, type TreeArea, type TreeChange, type TreeState, watchedFolders, WHOLE_TREE } from "../../src/tree/state.js";
import {
  bareRoot,
  chatsDir,
  plant,
  projectConfig,
  projectDir,
  projectsRoot,
  statePath,
  tasksDir,
  userConfig,
} from "../store/helpers.js";
import { outsideWorkflows, plantWorkflow, plantWorkflowsPath, workflowDir, workflowFile } from "../workflow/helpers.js";

/** The changes one edit of the tree makes, read back through one area. */
async function changesOf(
  root: string,
  edit: () => Promise<unknown>,
  area: TreeArea = WHOLE_TREE,
): Promise<TreeChange[]> {
  const before = await readTree(root);
  await edit();
  return diffTree(before, await readTree(root, area, before));
}

/** The same, from a state the test already read. */
async function changesFrom(root: string, before: TreeState, area: TreeArea = WHOLE_TREE): Promise<TreeChange[]> {
  return diffTree(before, await readTree(root, area, before));
}

function project(tag: string, change: "created" | "changed" | "deleted"): TreeChange {
  return { kind: "project", tag, change };
}

function workflow(name: string, change: "created" | "changed" | "deleted"): TreeChange {
  return { kind: "workflow", name, change };
}

describe("the state of a tree", () => {
  it("diffs to nothing when nothing changed", async () => {
    const root = await projectsRoot("SAGA");
    await plant(userConfig(root), "priorities: [high]\n");
    await plant(projectConfig(root), "name: Saga\n");
    await plantWorkflow(root, "flow", "steps: []\n");

    await expect(changesOf(root, async () => {})).resolves.toEqual([]);
  });

  it("reads an empty root, with no projects/ and no workflows/", async () => {
    const root = await bareRoot();

    await expect(changesOf(root, async () => {})).resolves.toEqual([]);
  });
});

describe("the diff of two states", () => {
  it("reports an edit of the root config.yml", async () => {
    const root = await projectsRoot("SAGA");
    await plant(userConfig(root), "priorities: [high]\n");

    await expect(changesOf(root, () => writeFile(userConfig(root), "priorities: [high, low]\n"))).resolves.toEqual([
      { kind: "config" },
    ]);
  });

  it("reports a root config.yml that is created and one that is removed", async () => {
    const root = await projectsRoot("SAGA");

    await expect(changesOf(root, () => plant(userConfig(root), "priorities: [high]\n"))).resolves.toEqual([
      { kind: "config" },
    ]);
    await expect(changesOf(root, () => rm(userConfig(root)))).resolves.toEqual([{ kind: "config" }]);
  });

  it("reports a project folder that is made and one that is removed", async () => {
    const root = await projectsRoot("SAGA");

    await expect(changesOf(root, () => mkdir(projectDir(root, "ACME")))).resolves.toEqual([project("ACME", "created")]);
    await expect(changesOf(root, () => rm(projectDir(root, "SAGA"), { recursive: true }))).resolves.toEqual([
      project("SAGA", "deleted"),
    ]);
  });

  it("reports the first project folder of a tree that had no projects/", async () => {
    const root = await bareRoot();

    await expect(changesOf(root, () => mkdir(projectDir(root, "SAGA"), { recursive: true }))).resolves.toEqual([
      project("SAGA", "created"),
    ]);
  });

  it("passes over a folder whose name is no tag", async () => {
    const root = await projectsRoot("SAGA");

    await expect(changesOf(root, () => mkdir(projectDir(root, "notes")))).resolves.toEqual([]);
  });

  it("reports a hand rename of a project folder as a delete and a create", async () => {
    const root = await projectsRoot("SAGA");

    await expect(changesOf(root, () => rename(projectDir(root, "SAGA"), projectDir(root, "ACME")))).resolves.toEqual([
      project("ACME", "created"),
      project("SAGA", "deleted"),
    ]);
  });

  it("reports an edit of a project config.yml", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root), "name: Saga\n");

    await expect(changesOf(root, () => writeFile(projectConfig(root), "name: Saga two\n"))).resolves.toEqual([
      project("SAGA", "changed"),
    ]);
  });

  it("reports one change for a config.yml saved through a temporary file and a rename", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root), "name: Saga\n");
    const temp = join(projectDir(root), ".config.yml.0a1b.tmp");

    const changes = await changesOf(root, async () => {
      await writeFile(temp, "name: Saved\n");
      await rename(temp, projectConfig(root));
    });

    expect(changes).toEqual([project("SAGA", "changed")]);
  });

  it("reports a tasks folder that comes, and one that goes", async () => {
    const root = await projectsRoot("SAGA");

    await expect(changesOf(root, () => mkdir(tasksDir(root)))).resolves.toEqual([project("SAGA", "changed")]);
    await expect(changesOf(root, () => rm(tasksDir(root), { recursive: true }))).resolves.toEqual([
      project("SAGA", "changed"),
    ]);
  });

  it("reports a tasks entry that is a file and then becomes a folder", async () => {
    const root = await projectsRoot("SAGA");
    await writeFile(tasksDir(root), "not a folder\n");

    const changes = await changesOf(root, async () => {
      await rm(tasksDir(root));
      await mkdir(tasksDir(root));
    });

    expect(changes).toEqual([project("SAGA", "changed")]);
  });

  it("reports a chmod of a project folder", async () => {
    const root = await projectsRoot("SAGA");
    onTestFinished(() => chmod(projectDir(root), 0o755));

    await expect(changesOf(root, () => chmod(projectDir(root), 0o700))).resolves.toEqual([project("SAGA", "changed")]);
  });

  it("reports a chmod that makes a project config.yml readable again", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root), "name: Saga\n");
    await chmod(projectConfig(root), 0o000);
    onTestFinished(() => chmod(projectConfig(root), 0o644));

    await expect(changesOf(root, () => chmod(projectConfig(root), 0o644))).resolves.toEqual([
      project("SAGA", "changed"),
    ]);
  });

  it("passes over a task write, state.yml, a temporary file and a new chats folder", async () => {
    const root = await projectsRoot("SAGA");
    await mkdir(tasksDir(root));

    const changes = await changesOf(root, async () => {
      await plant(join(tasksDir(root), "SAGA-1.md"), "---\nid: SAGA-1\n---\n");
      await plant(statePath(root), "next_id: 2\n");
      await plant(join(projectDir(root), ".state.yml.0a1b.tmp"), "next_id: 2\n");
      await mkdir(chatsDir(root));
    });

    expect(changes).toEqual([]);
  });

  it("reports a workflow that is made, edited and removed", async () => {
    const root = await projectsRoot();

    await expect(changesOf(root, () => plantWorkflow(root, "flow", "steps: []\n"))).resolves.toEqual([
      workflow("flow", "created"),
    ]);
    await expect(changesOf(root, () => writeFile(workflowFile(root, "flow"), "title: Flow\nsteps: []\n"))).resolves.toEqual([
      workflow("flow", "changed"),
    ]);
    await expect(changesOf(root, () => rm(workflowDir(root, "flow"), { recursive: true }))).resolves.toEqual([
      workflow("flow", "deleted"),
    ]);
  });

  it("lists a workflow folder only while it holds a workflow.yml", async () => {
    const root = await projectsRoot();

    await expect(changesOf(root, () => mkdir(workflowDir(root, "flow"), { recursive: true }))).resolves.toEqual([]);
    await expect(changesOf(root, () => writeFile(workflowFile(root, "flow"), "steps: []\n"))).resolves.toEqual([
      workflow("flow", "created"),
    ]);
    await expect(changesOf(root, () => rm(workflowFile(root, "flow")))).resolves.toEqual([workflow("flow", "deleted")]);
    await expect(changesOf(root, () => writeFile(workflowFile(root, "flow"), "steps: []\n"))).resolves.toEqual([
      workflow("flow", "created"),
    ]);
  });

  it("lists a workflow folder that is a link to a folder, and passes over one whose name is no workflow name", async () => {
    const root = await projectsRoot();
    const elsewhere = join(root, "elsewhere", "flow");
    await plant(join(elsewhere, "workflow.yml"), "steps: []\n");

    const changes = await changesOf(root, async () => {
      await mkdir(join(root, "workflows"));
      await symlink(elsewhere, workflowDir(root, "linked"));
      await plantWorkflow(root, "Not.A.Name", "steps: []\n");
    });

    expect(changes).toEqual([workflow("linked", "created")]);
  });

  it("compares the workflows of a new workflows_path by name, and reports the config", async () => {
    const root = await projectsRoot();
    const outside = outsideWorkflows(root);
    await plantWorkflow(root, "one", "steps: []\n");
    await plantWorkflow(root, "three", "steps: []\n");
    await plantWorkflow(root, "one", "title: Other one\nsteps: []\n", outside);
    await plantWorkflow(root, "two", "steps: []\n", outside);

    const changes = await changesOf(root, () => plantWorkflowsPath(root, outside));

    expect(changes).toEqual([
      { kind: "config" },
      workflow("one", "changed"),
      workflow("three", "deleted"),
      workflow("two", "created"),
    ]);
  });

  it("orders the changes: the config, then the projects by tag, then the workflows by name", async () => {
    const root = await projectsRoot();

    const changes = await changesOf(root, async () => {
      await plantWorkflow(root, "beta", "steps: []\n");
      await plantWorkflow(root, "alpha", "steps: []\n");
      await mkdir(projectDir(root, "ZED"), { recursive: true });
      await mkdir(projectDir(root, "ACME"));
      await plant(userConfig(root), "priorities: [high]\n");
    });

    expect(changes).toEqual([
      { kind: "config" },
      project("ACME", "created"),
      project("ZED", "created"),
      workflow("alpha", "created"),
      workflow("beta", "created"),
    ]);
  });

  it("lists no project while projects/ is a symbolic link, and every one again once it is removed", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const moved = join(root, "moved");
    const before = await readTree(root);

    await rename(join(root, "projects"), moved);
    await symlink(moved, join(root, "projects"));
    const linked = await readTree(root, WHOLE_TREE, before);
    await rm(join(root, "projects"));
    await rename(moved, join(root, "projects"));

    expect(diffTree(before, linked)).toEqual([project("ACME", "deleted"), project("SAGA", "deleted")]);
    await expect(changesFrom(root, linked)).resolves.toEqual([project("ACME", "created"), project("SAGA", "created")]);
  });

  it("lists no project while projects/ cannot be read, and never throws", async () => {
    const root = await projectsRoot("SAGA");
    const projects = join(root, "projects");
    onTestFinished(() => chmod(projects, 0o755));

    await expect(changesOf(root, () => chmod(projects, 0o000))).resolves.toEqual([project("SAGA", "deleted")]);
  });
});

describe("a read of one area", () => {
  it("reads the marks of one project and leaves every other one as it was", async () => {
    const root = await projectsRoot("SAGA", "ACME");

    const changes = await changesOf(
      root,
      async () => {
        await plant(projectConfig(root, "SAGA"), "name: Saga\n");
        await plant(projectConfig(root, "ACME"), "name: Acme\n");
      },
      { kind: "project", tag: "SAGA" },
    );

    expect(changes).toEqual([project("SAGA", "changed")]);
  });

  it("reads the project list when the folder of the project is gone, so a removal is a delete", async () => {
    const root = await projectsRoot("SAGA", "ACME");

    const changes = await changesOf(root, () => rm(projectDir(root, "SAGA"), { recursive: true }), {
      kind: "project",
      tag: "SAGA",
    });

    expect(changes).toEqual([project("SAGA", "deleted")]);
  });

  it("reads the project list and every project in it", async () => {
    const root = await projectsRoot("SAGA");

    const changes = await changesOf(
      root,
      async () => {
        await mkdir(projectDir(root, "ACME"));
        await plant(projectConfig(root, "SAGA"), "name: Saga\n");
        await plant(userConfig(root), "priorities: [high]\n");
      },
      { kind: "projects" },
    );

    expect(changes).toEqual([project("ACME", "created"), project("SAGA", "changed")]);
  });

  it("reads one workflow and leaves every other one as it was", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "one", "steps: []\n");
    await plantWorkflow(root, "two", "steps: []\n");

    const changes = await changesOf(
      root,
      async () => {
        await writeFile(workflowFile(root, "one"), "title: One\nsteps: []\n");
        await writeFile(workflowFile(root, "two"), "title: Two\nsteps: []\n");
      },
      { kind: "workflow", name: "one" },
    );

    expect(changes).toEqual([workflow("one", "changed")]);
  });

  it("reads the workflow list when the folder of the workflow is gone", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "one", "steps: []\n");

    const changes = await changesOf(root, () => rm(workflowDir(root, "one"), { recursive: true }), {
      kind: "workflow",
      name: "one",
    });

    expect(changes).toEqual([workflow("one", "deleted")]);
  });

  it("reads the workflow list when the folder of the workflow is no longer a folder", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "one", "steps: []\n");

    const changes = await changesOf(
      root,
      async () => {
        await rm(workflowDir(root, "one"), { recursive: true });
        await writeFile(workflowDir(root, "one"), "not a folder\n");
      },
      { kind: "workflow", name: "one" },
    );

    expect(changes).toEqual([workflow("one", "deleted")]);
  });

  it("reads the workflows folder and every workflow in it", async () => {
    const root = await projectsRoot();
    await plantWorkflow(root, "one", "steps: []\n");

    const changes = await changesOf(
      root,
      async () => {
        await plantWorkflow(root, "two", "steps: []\n");
        await writeFile(workflowFile(root, "one"), "title: One\nsteps: []\n");
        await mkdir(projectDir(root, "SAGA"), { recursive: true });
      },
      { kind: "workflows" },
    );

    expect(changes).toEqual([workflow("one", "changed"), workflow("two", "created")]);
  });
});

describe("the folders of a state", () => {
  it("lists no workflow whose workflow.yml is a folder, and watches its folder", async () => {
    const root = await projectsRoot();

    const changes = await changesOf(root, () => mkdir(workflowFile(root, "flow"), { recursive: true }));

    expect(changes).toEqual([]);
    const folders = watchedFolders(root, await readTree(root));
    expect(folders.get(workflowDir(root, "flow"))?.area).toEqual({ kind: "workflow", name: "flow" });
  });

  it("orders the lists first, then the projects by tag, then the workflow folders by name", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    await plantWorkflow(root, "zeta", "steps: []\n");
    await plantWorkflow(root, "alpha", "steps: []\n");

    const folders = watchedFolders(root, await readTree(root));

    expect([...folders.keys()]).toEqual([
      root,
      join(root, "projects"),
      join(root, "workflows"),
      projectDir(root, "ACME"),
      projectDir(root, "SAGA"),
      workflowDir(root, "alpha"),
      workflowDir(root, "zeta"),
    ]);
  });

  it("reads the whole tree at an event of a folder that two areas name", async () => {
    const root = await projectsRoot("SAGA");
    await plantWorkflowsPath(root, root);

    const folders = watchedFolders(root, await readTree(root));

    expect(folders.get(root)?.area).toEqual(WHOLE_TREE);
    expect(folders.get(projectDir(root))?.area).toEqual({ kind: "project", tag: "SAGA" });
  });
});
