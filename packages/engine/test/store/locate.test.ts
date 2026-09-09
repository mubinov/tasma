import { chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { locateProject } from "@tasma/engine";
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
    const root = await projectsRoot("TASM");
    const repo = await folderIn(root, "repo");
    await plant(projectConfig(root, "TASM"), `name: Tasma\npath: ${repo}\n`);
    const inside = await folderIn(repo, "packages", "engine");

    await expect(locateProject(inside, root)).resolves.toEqual({
      project: { tag: "TASM", name: "Tasma", path: repo },
      diagnostics: [],
    });
  });

  it("answers with the project whose path is the directory itself", async () => {
    const root = await projectsRoot("TASM");
    const repo = await folderIn(root, "repo");
    await declare(root, "TASM", repo);

    await expect(tagOf(repo, root)).resolves.toBe("TASM");
  });

  it("answers with no project for a directory under none of them", async () => {
    const root = await projectsRoot("TASM");
    await declare(root, "TASM", await folderIn(root, "repo"));

    await expect(locateProject(await folderIn(root, "elsewhere"), root)).resolves.toEqual({ diagnostics: [] });
  });

  it("compares whole segments, so a project does not hold a directory its path is a prefix of", async () => {
    const root = await projectsRoot("TASM");
    await declare(root, "TASM", await folderIn(root, "repo"));

    await expect(tagOf(await folderIn(root, "repository"), root)).resolves.toBeUndefined();
  });

  it("answers with the innermost project where one stands inside another", async () => {
    const root = await projectsRoot("TASM", "CLIB");
    const outer = await folderIn(root, "outer");
    await declare(root, "TASM", outer);
    await declare(root, "CLIB", join(outer, "inner"));

    await expect(tagOf(await folderIn(outer, "inner", "src"), root)).resolves.toBe("CLIB");
  });

  it("answers with the lowest tag where two projects declare one path", async () => {
    const root = await projectsRoot("TASM", "CLIB");
    const repo = await folderIn(root, "repo");
    await declare(root, "TASM", repo);
    await declare(root, "CLIB", repo);

    await expect(tagOf(repo, root)).resolves.toBe("CLIB");
  });

  it("passes over a project that declares no path, which stands for no folder", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "name: Tasma\n");

    await expect(tagOf(await folderIn(root, "repo"), root)).resolves.toBeUndefined();
  });

  it("answers with no project over a tree that holds none", async () => {
    const root = await bareRoot();

    await expect(locateProject(await folderIn(root, "repo"), root)).resolves.toEqual({ diagnostics: [] });
  });

  it("answers with a project that declares the root of a filesystem, which holds every directory", async () => {
    const root = await projectsRoot("TASM");
    await declare(root, "TASM", "/");

    await expect(tagOf(await folderIn(root, "repo"), root)).resolves.toBe("TASM");
  });

  it("resolves a project registered through a symbolic link for a caller standing on the folder itself", async () => {
    const root = await projectsRoot("TASM");
    const physical = await folderIn(root, "physical", "repo");
    await symlink(join(root, "physical"), join(root, "link"));
    await declare(root, "TASM", join(root, "link", "repo"));

    await expect(tagOf(physical, root)).resolves.toBe("TASM");
  });

  it("keeps a project whose folder is gone in the comparison, where it disturbs nobody", async () => {
    const root = await projectsRoot("TASM", "CLIB");
    const repo = await folderIn(root, "repo");
    await declare(root, "TASM", join(root, "gone"));
    await declare(root, "CLIB", repo);

    await expect(locateProject(repo, root)).resolves.toEqual({
      project: { tag: "CLIB", name: undefined, path: repo },
      diagnostics: [],
    });
  });

  it("leaves out a project whose configuration is no YAML, naming the file, and answers for the rest", async () => {
    const root = await projectsRoot("TASM", "CLIB");
    const repo = await folderIn(root, "repo");
    await plant(projectConfig(root, "TASM"), "name: [Tasma\n");
    await declare(root, "CLIB", repo);

    const result = await locateProject(repo, root);

    expect(result.project?.tag).toBe("CLIB");
    expect(result.diagnostics).toEqual([
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- every asymmetric matcher is typed `any`.
      { code: "config-unreadable", message: expect.stringContaining("was refused"), path: projectConfig(root, "TASM") },
    ]);
  });

  it("names the folder a refusal concerns, which is not the configuration where the tasks directory is a link", async () => {
    const root = await projectsRoot("TASM", "CLIB");
    const repo = await folderIn(root, "repo");
    await declare(root, "CLIB", repo);
    await symlink(await folderIn(root, "elsewhere"), tasksDir(root, "TASM"));

    const result = await locateProject(repo, root);

    expect(result.project?.tag).toBe("CLIB");
    expect(result.diagnostics).toEqual([
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- every asymmetric matcher is typed `any`.
      { code: "config-unreadable", message: expect.stringContaining("was refused"), path: tasksDir(root, "TASM") },
    ]);
  });

  it("leaves out a project whose directory cannot be read, and says which of the two happened", async () => {
    const root = await projectsRoot("TASM", "CLIB");
    const repo = await folderIn(root, "repo");
    const directory = projectDir(root, "TASM");
    await declare(root, "CLIB", repo);
    await chmod(directory, 0o000);
    onTestFinished(() => chmod(directory, 0o755));

    const result = await locateProject(repo, root);

    expect(result.project?.tag).toBe("CLIB");
    expect(codes(result.diagnostics)).toEqual(["config-unreadable"]);
    expect(result.diagnostics[0]?.message).toContain("could not be read");
  });

  it("takes a path against the home directory rather than refusing it", async () => {
    const root = await projectsRoot("TASM");
    await declare(root, "TASM", await folderIn(root, "repo"));

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

describe("a directory a resolution refuses", () => {
  it.each([
    ["a relative path, which stands against nothing the caller meant", "repo"],
    ["a path holding a NUL byte, which no name on a filesystem holds", "/srv/re\0po"],
  ])("refuses %s", async (_name, directory) => {
    const root = await projectsRoot("TASM");

    expect((await storeError(locateProject(directory, root))).code).toBe("path-invalid");
  });

  it("refuses a path that names no directory, so both sides of the comparison are canonical", async () => {
    const root = await projectsRoot("TASM");

    expect((await storeError(locateProject(join(root, "gone"), root))).code).toBe("path-invalid");
  });

  it("refuses the whole call over a tree whose projects directory is a symbolic link", async () => {
    const root = await bareRoot();
    const repo = await folderIn(root, "repo");
    await symlink(await folderIn(root, "elsewhere"), join(root, "projects"));

    expect((await storeError(locateProject(repo, root))).code).toBe("project-invalid");
  });
});
