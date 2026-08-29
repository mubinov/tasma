import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectPaths, scanTasks, taskPath, tempPath } from "../../src/store/paths.js";
import { plant, PROJECT, read, storeFault, tasksDir, taskText, tempRoot } from "./helpers.js";

function paths(root: string) {
  return projectPaths({ project: PROJECT, root });
}

describe("projectPaths", () => {
  it("puts every file of a project under the root it is given", () => {
    const built = projectPaths({ project: PROJECT, root: "/tmp/tree" });

    expect(built.userConfig).toBe("/tmp/tree/config.yml");
    expect(built.directory).toBe("/tmp/tree/projects/TASM");
    expect(built.projectConfig).toBe("/tmp/tree/projects/TASM/config.yml");
    expect(built.state).toBe("/tmp/tree/projects/TASM/state.yml");
    expect(built.tasks).toBe("/tmp/tree/projects/TASM/tasks");
  });

  it("defaults the root to ~/.tasma, expanded once", () => {
    expect(projectPaths({ project: PROJECT }).root).toBe(join(homedir(), ".tasma"));
  });

  it("resolves a relative root against the working directory", () => {
    expect(projectPaths({ project: PROJECT, root: "tree" }).root).toBe(join(process.cwd(), "tree"));
  });

  it.each([
    ["~/.tasma", join(homedir(), ".tasma")],
    ["~", homedir()],
  ])("expands the home directory a root of %s names", (root, expanded) => {
    expect(projectPaths({ project: PROJECT, root }).root).toBe(expanded);
  });

  it.each(["..", ".", "a/b", "a\\b", "tasm", "TASM-1", "TA SM", ""])("rejects the tag %s", (project) => {
    expect(storeFault(() => projectPaths({ project, root: "/tmp/tree" })).code).toBe("project-invalid");
  });

  it.each(["TASM", "T", "A1", "0"])("accepts the tag %s", (project) => {
    expect(projectPaths({ project, root: "/tmp/tree" }).project).toBe(project);
  });
});

describe("taskPath", () => {
  it("names the file of a task", () => {
    expect(taskPath(paths("/tmp/tree"), "TASM-7")).toBe("/tmp/tree/projects/TASM/tasks/TASM-7.md");
  });

  it.each(["TASM-1/../../x", "../TASM-1", "TASM-x", "OTHER-1", "TASM-", "TASM-1.md", "tasm-1"])(
    "reports %s as no task of this project",
    (id) => {
      expect(storeFault(() => taskPath(paths("/tmp/tree"), id)).code).toBe("task-not-found");
    },
  );
});

describe("tempPath", () => {
  it("puts the temp file beside its target, so the rename stays on one filesystem", () => {
    const temp = tempPath("/tmp/tree/projects/TASM/tasks/TASM-7.md");

    expect(temp.startsWith("/tmp/tree/projects/TASM/tasks/.TASM-7.md.")).toBe(true);
    expect(temp.endsWith(".tmp")).toBe(true);
  });

  it("gives each writer a temp file of its own", () => {
    expect(tempPath("/a/b.md")).not.toBe(tempPath("/a/b.md"));
  });
});

describe("scanTasks", () => {
  it("reads a directory that does not exist as an empty project", async () => {
    const root = await tempRoot();

    await expect(scanTasks(paths(root))).resolves.toEqual({ entries: [], diagnostics: [] });
  });

  it("returns the task files in the order of their number", async () => {
    const root = await tempRoot();
    for (const id of ["TASM-10", "TASM-2", "TASM-1"]) {
      await plant(join(tasksDir(root), `${id}.md`), taskText(id));
    }

    const scan = await scanTasks(paths(root));

    expect(scan.entries.map((entry) => entry.id)).toEqual(["TASM-1", "TASM-2", "TASM-10"]);
    expect(scan.entries.map((entry) => entry.number)).toEqual([1, 2, 10]);
    expect(scan.diagnostics).toEqual([]);
  });

  it("reports a markdown file whose name is not a task name", async () => {
    const root = await tempRoot();
    await plant(join(tasksDir(root), "notes.md"), "notes");

    const scan = await scanTasks(paths(root));

    expect(scan.entries).toEqual([]);
    expect(scan.diagnostics).toEqual([
      { code: "task-file-unexpected", message: expect.any(String), path: join(tasksDir(root), "notes.md") },
    ]);
  });

  it("reports a leftover temp file and deletes nothing", async () => {
    const root = await tempRoot();
    const temp = join(tasksDir(root), ".TASM-1.md.a1b2c3.tmp");
    await plant(temp, "half a file");

    const scan = await scanTasks(paths(root));

    expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["temp-file-left"]);
    expect(scan.diagnostics[0]?.path).toBe(temp);
    await expect(read(temp)).resolves.toBe("half a file");
  });

  it.each(["TASM-1.md.bak", "TASM-1.txt", "README", "TASM-1"])("passes over %s in silence", async (name) => {
    const root = await tempRoot();
    await plant(join(tasksDir(root), name), "not a task file");

    const scan = await scanTasks(paths(root));

    expect(scan).toEqual({ entries: [], diagnostics: [] });
  });

  it("passes over a directory that carries a task name", async () => {
    const root = await tempRoot();
    await plant(join(tasksDir(root), "TASM-1.md", "inside"), "a directory, not a file");

    await expect(scanTasks(paths(root))).resolves.toEqual({ entries: [], diagnostics: [] });
  });

  it("names a file of another project as unexpected, because the rule carries the tag", async () => {
    const root = await tempRoot();
    await plant(join(tasksDir(root), "OTHER-1.md"), taskText("OTHER-1"));

    const scan = await scanTasks(paths(root));

    expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["task-file-unexpected"]);
  });
});

describe("a fault that is not a missing directory", () => {
  it("reaches the caller as it stands", async () => {
    const root = await tempRoot();
    await plant(tasksDir(root), "a file where the directory belongs");

    await expect(scanTasks(paths(root))).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
