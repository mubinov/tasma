import { chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { locateProject } from "@tasma/engine";
import { pathHolder } from "../../src/store/locate.js";
import {
  bareRoot,
  codes,
  folderIn,
  plant,
  projectConfig,
  projectDir,
  projectsRoot,
  storeError,
  tasksDir,
} from "./helpers.js";

/** The tag one resolution answered with, or `undefined` where no project holds the directory. */
async function tagOf(directory: string, root: string): Promise<string | undefined> {
  return (await locateProject(directory, root)).project?.tag;
}

/** Registers what one project of a temp tree declares about the folder it stands for. */
function declare(root: string, tag: string, path: string): Promise<void> {
  return plant(projectConfig(root, tag), `path: ${path}\n`);
}

describe("the project that holds a directory", () => {
  it("answers with the project, its name and its path, for a directory below it", async () => {
    const root = await projectsRoot("SAGA");
    const repo = await folderIn(root, "repo");
    await plant(projectConfig(root, "SAGA"), `name: Saga\npath: ${repo}\n`);
    const inside = await folderIn(repo, "packages", "engine");

    await expect(locateProject(inside, root)).resolves.toEqual({
      project: { tag: "SAGA", name: "Saga", path: repo },
      diagnostics: [],
    });
  });

  it("answers with the project whose path is the directory itself", async () => {
    const root = await projectsRoot("SAGA");
    const repo = await folderIn(root, "repo");
    await declare(root, "SAGA", repo);

    await expect(tagOf(repo, root)).resolves.toBe("SAGA");
  });

  it("answers with no project for a directory under none of them", async () => {
    const root = await projectsRoot("SAGA");
    await declare(root, "SAGA", await folderIn(root, "repo"));

    await expect(locateProject(await folderIn(root, "elsewhere"), root)).resolves.toEqual({ diagnostics: [] });
  });

  it("compares whole segments, so a project does not hold a directory its path is a prefix of", async () => {
    const root = await projectsRoot("SAGA");
    await declare(root, "SAGA", await folderIn(root, "repo"));

    await expect(tagOf(await folderIn(root, "repository"), root)).resolves.toBeUndefined();
  });

  it("answers with the innermost project where one stands inside another", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const outer = await folderIn(root, "outer");
    await declare(root, "SAGA", outer);
    await declare(root, "ACME", join(outer, "inner"));

    await expect(tagOf(await folderIn(outer, "inner", "src"), root)).resolves.toBe("ACME");
  });

  it("answers with the lowest tag where two projects declare one path", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const repo = await folderIn(root, "repo");
    await declare(root, "SAGA", repo);
    await declare(root, "ACME", repo);

    await expect(tagOf(repo, root)).resolves.toBe("ACME");
  });

  it("passes over a project that declares no path, which stands for no folder", async () => {
    const root = await projectsRoot("SAGA");
    await plant(projectConfig(root, "SAGA"), "name: Saga\n");

    await expect(tagOf(await folderIn(root, "repo"), root)).resolves.toBeUndefined();
  });

  it("answers with no project over a tree that holds none", async () => {
    const root = await bareRoot();

    await expect(locateProject(await folderIn(root, "repo"), root)).resolves.toEqual({ diagnostics: [] });
  });

  it("answers with a project that declares the root of a filesystem, which holds every directory", async () => {
    const root = await projectsRoot("SAGA");
    await declare(root, "SAGA", "/");

    await expect(tagOf(await folderIn(root, "repo"), root)).resolves.toBe("SAGA");
  });

  it("resolves a project registered through a symbolic link for a caller standing on the folder itself", async () => {
    const root = await projectsRoot("SAGA");
    const physical = await folderIn(root, "physical", "repo");
    await symlink(join(root, "physical"), join(root, "link"));
    await declare(root, "SAGA", join(root, "link", "repo"));

    await expect(tagOf(physical, root)).resolves.toBe("SAGA");
  });

  it("keeps a project whose folder is gone in the comparison, where it disturbs nobody", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const repo = await folderIn(root, "repo");
    await declare(root, "SAGA", join(root, "gone"));
    await declare(root, "ACME", repo);

    await expect(locateProject(repo, root)).resolves.toEqual({
      project: { tag: "ACME", name: undefined, path: repo },
      diagnostics: [],
    });
  });

  it("leaves out a project whose configuration is no YAML, naming the file, and answers for the rest", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const repo = await folderIn(root, "repo");
    await plant(projectConfig(root, "SAGA"), "name: [Saga\n");
    await declare(root, "ACME", repo);

    const result = await locateProject(repo, root);

    expect(result.project?.tag).toBe("ACME");
    expect(result.diagnostics).toEqual([
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- every asymmetric matcher is typed `any`.
      { code: "config-unreadable", message: expect.stringContaining("was refused"), path: projectConfig(root, "SAGA") },
    ]);
  });

  it("names the folder a refusal concerns, which is not the configuration where the tasks directory is a link", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const repo = await folderIn(root, "repo");
    await declare(root, "ACME", repo);
    await symlink(await folderIn(root, "elsewhere"), tasksDir(root, "SAGA"));

    const result = await locateProject(repo, root);

    expect(result.project?.tag).toBe("ACME");
    expect(result.diagnostics).toEqual([
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- every asymmetric matcher is typed `any`.
      { code: "config-unreadable", message: expect.stringContaining("was refused"), path: tasksDir(root, "SAGA") },
    ]);
  });

  it("leaves out a project whose directory cannot be read, and says which of the two happened", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const repo = await folderIn(root, "repo");
    const directory = projectDir(root, "SAGA");
    await declare(root, "ACME", repo);
    await chmod(directory, 0o000);
    onTestFinished(() => chmod(directory, 0o755));

    const result = await locateProject(repo, root);

    expect(result.project?.tag).toBe("ACME");
    expect(codes(result.diagnostics)).toEqual(["config-unreadable"]);
    expect(result.diagnostics[0]?.message).toContain("could not be read");
  });

  it("takes a path against the home directory rather than refusing it", async () => {
    const root = await projectsRoot("SAGA");
    await declare(root, "SAGA", await folderIn(root, "repo"));

    await expect(locateProject("~/..", root)).resolves.toEqual({ diagnostics: [] });
  });

  it("keeps the findings in the order of the tree however many projects it reads at a time", async () => {
    const tags = ["A1", "B2", "C3", "D4", "E5", "F6", "G7", "H8", "I9", "J10", "K11"];
    const unreadable = ["B2", "E5", "I9", "K11"];
    const root = await projectsRoot(...tags);
    const outer = await folderIn(root, "outer");
    for (const tag of unreadable) await plant(projectConfig(root, tag), "name: [Broken\n");
    await declare(root, "A1", outer);
    await declare(root, "J10", join(outer, "inner"));

    const result = await locateProject(await folderIn(outer, "inner", "src"), root);

    expect(result.project?.tag).toBe("J10");
    expect(result.diagnostics.map((finding) => finding.path)).toEqual(
      unreadable.map((tag) => projectConfig(root, tag)),
    );
  });
});

describe("the project that stands at exactly a directory", () => {
  it("answers with the project whose path is the directory", async () => {
    const root = await projectsRoot("SAGA");
    const repo = await folderIn(root, "repo");
    await declare(root, "SAGA", repo);

    await expect(pathHolder(repo, root)).resolves.toBe("SAGA");
  });

  it("answers with no project for a directory inside a project or around one", async () => {
    const root = await projectsRoot("SAGA");
    const repo = await folderIn(root, "outer", "repo");
    await declare(root, "SAGA", repo);

    await expect(pathHolder(await folderIn(repo, "inner"), root)).resolves.toBeUndefined();
    await expect(pathHolder(join(root, "outer"), root)).resolves.toBeUndefined();
  });

  it("answers with no project over a tree that holds none", async () => {
    const root = await bareRoot();

    await expect(pathHolder(await folderIn(root, "repo"), root)).resolves.toBeUndefined();
  });

  it("answers with the lowest tag where two projects stand at the directory", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const repo = await folderIn(root, "repo");
    await declare(root, "SAGA", repo);
    await declare(root, "ACME", repo);

    await expect(pathHolder(repo, root)).resolves.toBe("ACME");
  });

  it("passes over the project it is told to leave out", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const repo = await folderIn(root, "repo");
    await declare(root, "SAGA", repo);
    await declare(root, "ACME", repo);

    await expect(pathHolder(repo, root, "ACME")).resolves.toBe("SAGA");
    await expect(pathHolder(repo, root, "SAGA")).resolves.toBe("ACME");
  });

  it("compares the canonical paths, so a project declared through a symbolic link stands at the folder", async () => {
    const root = await projectsRoot("SAGA");
    const physical = await folderIn(root, "physical", "repo");
    await symlink(join(root, "physical"), join(root, "link"));
    await declare(root, "SAGA", join(root, "link", "repo"));

    await expect(pathHolder(physical, root)).resolves.toBe("SAGA");
  });

  it("passes over a project that declares no path and one whose configuration is no YAML", async () => {
    const root = await projectsRoot("SAGA", "ACME");
    const repo = await folderIn(root, "repo");
    await plant(projectConfig(root, "ACME"), "name: Acme\n");
    await plant(projectConfig(root, "SAGA"), `path: ${repo}\nname: [Saga\n`);

    await expect(pathHolder(repo, root)).resolves.toBeUndefined();
  });
});

describe("a directory a resolution refuses", () => {
  it.each([
    ["a relative path, which stands against nothing the caller meant", "repo"],
    ["a path holding a NUL byte, which no name on a filesystem holds", "/srv/re\0po"],
  ])("refuses %s", async (_name, directory) => {
    const root = await projectsRoot("SAGA");

    expect((await storeError(locateProject(directory, root))).code).toBe("path-invalid");
  });

  it("refuses a path that names no directory, so both sides of the comparison are canonical", async () => {
    const root = await projectsRoot("SAGA");

    expect((await storeError(locateProject(join(root, "gone"), root))).code).toBe("path-invalid");
  });

  it("refuses the whole call over a tree whose projects directory is a symbolic link", async () => {
    const root = await bareRoot();
    const repo = await folderIn(root, "repo");
    await symlink(await folderIn(root, "elsewhere"), join(root, "projects"));

    expect((await storeError(locateProject(repo, root))).code).toBe("project-invalid");
  });
});
