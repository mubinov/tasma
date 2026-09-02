import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverProjects, readProjectDeclaration } from "@tasma/engine";
import { bareRoot, plant, projectConfig, projectDir, projectsRoot, storeError, userConfig } from "./helpers.js";

describe("the projects of a tree", () => {
  it("answers with every project directory, by tag ascending", async () => {
    const root = await projectsRoot("TASM", "CLIB", "P2");

    await expect(discoverProjects(root)).resolves.toEqual(["CLIB", "P2", "TASM"]);
  });

  it("reads a tree with no projects directory as holding none", async () => {
    const root = await bareRoot();

    await expect(discoverProjects(root)).resolves.toEqual([]);
  });

  it.each([
    ["a lowercase name", "tasma"],
    ["a name holding a dash", "TAS-MA"],
  ])("leaves out %s, which no project stands under", async (_name, entry) => {
    const root = await projectsRoot("TASM");
    await mkdir(join(root, "projects", entry), { recursive: true });

    await expect(discoverProjects(root)).resolves.toEqual(["TASM"]);
  });

  it("leaves out a file, whatever it is named", async () => {
    const root = await projectsRoot("TASM");
    await writeFile(join(root, "projects", "NOTES"), "text", "utf8");

    await expect(discoverProjects(root)).resolves.toEqual(["TASM"]);
  });

  it("leaves out a symbolic link, whichever project directory it points at", async () => {
    const root = await projectsRoot("TASM");
    await symlink(projectDir(root, "TASM"), join(root, "projects", "LINKED"));

    await expect(discoverProjects(root)).resolves.toEqual(["TASM"]);
  });

  it("refuses a projects name that is a symbolic link, whichever tree it points at", async () => {
    const elsewhere = await projectsRoot("TASM");
    const root = await bareRoot();
    await symlink(join(elsewhere, "projects"), join(root, "projects"));

    expect((await storeError(discoverProjects(root))).code).toBe("project-invalid");
  });

  it("throws for a projects name that holds no directory, so an absent one alone reads as empty", async () => {
    const root = await bareRoot();
    await writeFile(join(root, "projects"), "text", "utf8");

    const error = await discoverProjects(root).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: "ENOTDIR" });
  });
});

describe("what a project states about itself", () => {
  it("answers with the name and the path its own file states", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "name: Tasma\npath: /srv/tasma\n");

    await expect(readProjectDeclaration({ project: "TASM", root })).resolves.toEqual({
      name: "Tasma",
      path: "/srv/tasma",
    });
  });

  it("answers with neither for a project whose file states neither", async () => {
    const root = await projectsRoot("TASM");

    await expect(readProjectDeclaration({ project: "TASM", root })).resolves.toEqual({
      name: undefined,
      path: undefined,
    });
  });

  it("leaves the shared user file unread, which can state neither key", async () => {
    const root = await projectsRoot("TASM");
    await plant(userConfig(root), "name: Shared\npath: /srv/shared\n");

    await expect(readProjectDeclaration({ project: "TASM", root })).resolves.toEqual({
      name: undefined,
      path: undefined,
    });
  });

  it("answers over a shared user file this engine cannot read, which decides nothing here", async () => {
    const root = await projectsRoot("TASM");
    await plant(userConfig(root), "statuses: [\n");
    await plant(projectConfig(root, "TASM"), "name: Tasma\n");

    await expect(readProjectDeclaration({ project: "TASM", root })).resolves.toMatchObject({ name: "Tasma" });
  });

  it("refuses a tag no directory of the tree stands under", async () => {
    const root = await projectsRoot();

    expect((await storeError(readProjectDeclaration({ project: "TASM", root }))).code).toBe("project-not-found");
  });

  it("refuses a project file this engine cannot read", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "name: [Tasma\n");

    expect((await storeError(readProjectDeclaration({ project: "TASM", root }))).code).toBe("config-invalid");
  });
});
