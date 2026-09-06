import { chmod, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createProject,
  type CreateProjectInput,
  discoverProjects,
  openProject,
  type ProjectChange,
  readProject,
  removeProject,
  updateProject,
} from "@tasma/engine";
import {
  bareRoot,
  codes,
  plant,
  PROJECT,
  projectConfig,
  projectDir,
  projectsRoot,
  read,
  storeError,
  tempRoot,
} from "./helpers.js";

/** A directory a project can stand for, outside the tree that registers it. */
async function target(name = "tasma"): Promise<string> {
  const path = join(await bareRoot(), name);
  await mkdir(path);
  return path;
}

/** The entries of one directory, in a settled order. */
async function entries(path: string): Promise<string[]> {
  return (await readdir(path)).sort();
}

describe("registering a project", () => {
  it("writes the directory and a file stating the two keys, and answers with both", async () => {
    const root = await bareRoot();
    const folder = await target();

    await expect(createProject({ root, path: folder })).resolves.toEqual({
      tag: "TASM",
      name: "tasma",
      path: folder,
      diagnostics: [],
    });

    await expect(entries(projectDir(root))).resolves.toEqual(["config.yml"]);
    expect(await read(projectConfig(root))).toBe(`name: tasma\npath: ${folder}\n`);
  });

  it("takes the tag the caller states as it stands", async () => {
    const root = await bareRoot();

    await expect(createProject({ root, path: await target(), tag: "CLIB" })).resolves.toMatchObject({ tag: "CLIB" });
  });

  it("takes the name the caller states over the one the folder gives", async () => {
    const root = await bareRoot();

    await expect(createProject({ root, path: await target(), name: "Tasma" })).resolves.toMatchObject({
      name: "Tasma",
    });
  });

  it("states no name where the path names no folder at all", async () => {
    const root = await bareRoot();

    await expect(createProject({ root, path: "/", tag: "ROOT" })).resolves.toMatchObject({ name: undefined });
    expect(await read(projectConfig(root, "ROOT"))).toBe("path: /\n");
  });

  it("expands a path the caller states from the home directory", async () => {
    const root = await bareRoot();

    await expect(createProject({ root, path: "~/..", tag: "HOME", name: "Above" })).resolves.toMatchObject({
      path: dirname(homedir()),
    });
  });

  it("takes the name from the folder the path resolves to", async () => {
    const root = await bareRoot();

    await expect(createProject({ root, path: "~/..", tag: "HOME" })).resolves.toMatchObject({
      name: basename(dirname(homedir())),
    });
  });

  it("takes the tag from the folder the path resolves to", async () => {
    const root = await bareRoot();
    const folder = await target();

    await expect(createProject({ root, path: `${folder}/sub/..` })).resolves.toMatchObject({ tag: "TASM" });
  });

  it("refuses a name that is empty", async () => {
    const root = await bareRoot();

    expect((await storeError(createProject({ root, path: await target(), name: "" }))).code).toBe("field-required");
  });

  it("refuses a name that is no text, before anything is written", async () => {
    const root = await bareRoot();
    const input = { root, path: await target(), name: 5 } as unknown as CreateProjectInput;

    expect((await storeError(createProject(input))).code).toBe("field-required");
    await expect(entries(root)).resolves.toEqual([]);
  });

  it.each([
    ["states no path at all", {}],
    ["states a path with no value", { path: null }],
    ["states a path that is no text", { path: 5 }],
  ])("refuses a create that %s, before it reads one for a tag", async (_reason, stated) => {
    const root = await bareRoot();
    const input = { root, ...stated } as unknown as CreateProjectInput;

    expect((await storeError(createProject(input))).code).toBe("path-invalid");
    await expect(entries(root)).resolves.toEqual([]);
  });

  it("refuses a path that is no text where the caller states a tag of its own", async () => {
    const root = await bareRoot();
    const input = { root, path: 5, tag: "TASM" } as unknown as CreateProjectInput;

    expect((await storeError(createProject(input))).code).toBe("path-invalid");
    await expect(entries(root)).resolves.toEqual([]);
  });

  it.each([
    ["states no field of a create", { tags: "TASM" }],
    ["is no name at all", { [Symbol("tag")]: "TASM" }],
  ])("refuses a key that %s", async (_reason, stated) => {
    const root = await bareRoot();
    const input = { root, path: await target(), ...stated } as unknown as CreateProjectInput;

    expect((await storeError(createProject(input))).code).toBe("field-not-writable");
    await expect(entries(root)).resolves.toEqual([]);
  });

  it("refuses a tag outside the rule a project is created under", async () => {
    const root = await bareRoot();

    expect((await storeError(createProject({ root, path: await target(), tag: "t" }))).code).toBe("tag-invalid");
  });

  it("refuses a tag another project already stands under", async () => {
    const root = await projectsRoot("TASM");

    expect((await storeError(createProject({ root, path: await target(), tag: "TASM" }))).code).toBe("project-exists");
  });

  it("numbers a generated tag another project already stands under", async () => {
    const root = await projectsRoot("TASM");

    await expect(createProject({ root, path: await target() })).resolves.toMatchObject({ tag: "TASM2" });
  });

  it("numbers past a name the discovery could not see", async () => {
    const root = await projectsRoot("CLIB");
    // A symbolic link is no project, so the discovery leaves it out while the
    // exclusive create still finds the name taken.
    await symlink(projectDir(root, "CLIB"), projectDir(root, "TASM"));

    await expect(createProject({ root, path: await target() })).resolves.toMatchObject({ tag: "TASM2" });
  });

  it.each([
    ["is relative", async () => "projects/tasma"],
    ["names a file", async () => {
      const path = join(await bareRoot(), "tasma");
      await writeFile(path, "text", "utf8");
      return path;
    }],
    ["names nothing", async () => join(await bareRoot(), "tasma")],
    ["leads through something that is no directory", async () => {
      const file = join(await bareRoot(), "tasma");
      await writeFile(file, "text", "utf8");
      return join(file, "inside");
    }],
    ["loops", async () => {
      const parent = await bareRoot();
      await symlink(join(parent, "second"), join(parent, "tasma"));
      await symlink(join(parent, "tasma"), join(parent, "second"));
      return join(parent, "tasma");
    }],
    ["holds a byte no name on a filesystem carries", async () => "/tmp/a\0b"],
    ["is longer than any name a filesystem holds", async () => `/tmp/${"a".repeat(4096)}`],
  ])("refuses a path that %s", async (_reason, build) => {
    const root = await bareRoot();

    expect((await storeError(createProject({ root, path: await build() }))).code).toBe("path-invalid");
    await expect(entries(root)).resolves.toEqual([]);
  });

  it("passes on a fault of the path check that is no answer about the path", async () => {
    const root = await bareRoot();
    const parent = await bareRoot();
    await chmod(parent, 0o000);
    onTestFinished(() => chmod(parent, 0o700));

    await expect(createProject({ root, path: join(parent, "tasma") })).rejects.toMatchObject({ code: "EACCES" });
  });

  it("makes the tree and its projects directory where neither exists", async () => {
    const root = join(await bareRoot(), "tree");

    await expect(createProject({ root, path: await target() })).resolves.toMatchObject({ tag: "TASM" });

    await expect(entries(join(root, "projects"))).resolves.toEqual(["TASM"]);
  });

  it("passes on a fault of a tree it cannot make", async () => {
    const root = join(await bareRoot(), "missing", "tree");

    await expect(createProject({ root, path: await target() })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes on a fault of the directory create that is no collision", async () => {
    const root = await bareRoot();
    const projects = join(root, "projects");
    await mkdir(projects);
    const folder = await target();
    await chmod(projects, 0o500);
    onTestFinished(() => chmod(projects, 0o700));

    await expect(createProject({ root, path: folder })).rejects.toMatchObject({ code: "EACCES" });
  });

  it("removes the directory it made where the file cannot be written", async () => {
    const root = await bareRoot();
    await mkdir(join(root, "projects"));
    const folder = await target();
    // The directory the create makes takes a mode this umask narrows, so the
    // file inside it cannot be opened while the directory itself still can be
    // removed from the one above it.
    const umask = process.umask(0o200);
    onTestFinished(() => {
      process.umask(umask);
    });

    await expect(createProject({ root, path: folder })).rejects.toMatchObject({ code: "EACCES" });

    await expect(entries(join(root, "projects"))).resolves.toEqual([]);
  });
});

describe("reading a project", () => {
  it("answers with the tag, the name and the path its file states", async () => {
    const root = await tempRoot();
    const folder = await target();
    await plant(projectConfig(root), `name: Tasma\npath: ${folder}\n`);

    await expect(readProject({ project: PROJECT, root })).resolves.toEqual({
      tag: PROJECT,
      name: "Tasma",
      path: folder,
      diagnostics: [],
    });
  });

  it("answers with neither key for a project whose file states neither", async () => {
    const root = await tempRoot();

    await expect(readProject({ project: PROJECT, root })).resolves.toEqual({
      tag: PROJECT,
      name: undefined,
      path: undefined,
      diagnostics: [],
    });
  });

  it("reports a path that names no directory, leaving the project usable", async () => {
    const root = await tempRoot();
    const gone = join(await bareRoot(), "gone");
    await plant(projectConfig(root), `name: Tasma\npath: ${gone}\n`);

    const info = await readProject({ project: PROJECT, root });

    expect(info).toMatchObject({ tag: PROJECT, name: "Tasma", path: gone });
    expect(info.diagnostics).toEqual([
      { code: "path-missing", message: "the project path does not name a directory", path: gone },
    ]);
  });

  it("reports a path it is not allowed to reach as missing", async () => {
    const root = await tempRoot();
    const parent = await bareRoot();
    const folder = join(parent, "tasma");
    await mkdir(folder);
    await plant(projectConfig(root), `path: ${folder}\n`);
    await chmod(parent, 0o000);
    onTestFinished(() => chmod(parent, 0o700));

    expect(codes((await readProject({ project: PROJECT, root })).diagnostics)).toEqual(["path-missing"]);
  });

  it("reports what the read of the file found, which the listing drops", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "name: Tasma\nwanted: yes\n");

    expect(codes((await readProject({ project: PROJECT, root })).diagnostics)).toEqual(["config-key-unknown"]);
  });

  it("refuses a tag no directory of the tree stands under", async () => {
    const root = await projectsRoot();

    expect((await storeError(readProject({ project: PROJECT, root }))).code).toBe("project-not-found");
  });

  it("refuses a project directory that is a symbolic link", async () => {
    const root = await projectsRoot("CLIB");
    await symlink(projectDir(root, "CLIB"), projectDir(root));

    expect((await storeError(readProject({ project: PROJECT, root }))).code).toBe("project-invalid");
  });

  it("refuses a file this engine cannot parse", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "name: [Tasma\n");

    expect((await storeError(readProject({ project: PROJECT, root }))).code).toBe("config-invalid");
  });
});

/** A file whose `name` is lent to it by another mapping, so no key of it holds that text. */
const MERGED_NAME = "%YAML 1.1\n---\nshared: &s\n  name: Shared\n<<: *s\n";

/** A file whose `name` key is written as an alias, which resolves to the text its anchor holds. */
const ALIASED_NAME = "which: &k name\n*k : Tasma\n";

describe("writing what a project states", () => {
  it("sets the name", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "name: Tasma\n");

    await expect(updateProject({ project: PROJECT, root }, { name: "Renamed" })).resolves.toMatchObject({
      name: "Renamed",
    });
    expect(await read(projectConfig(root))).toBe("name: Renamed\n");
  });

  it("clears the name, so the reader falls back to the tag", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "name: Tasma\nstatuses:\n  - Backlog\n");

    await expect(updateProject({ project: PROJECT, root }, { name: null })).resolves.toMatchObject({
      name: undefined,
    });
    expect(await read(projectConfig(root))).toBe("statuses:\n  - Backlog\n");
  });

  it("clears the name for a key the change carries with no value at all", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "name: Tasma\nstatuses:\n  - Backlog\n");

    await expect(updateProject({ project: PROJECT, root }, { name: undefined })).resolves.toMatchObject({
      name: undefined,
    });
    expect(await read(projectConfig(root))).toBe("statuses:\n  - Backlog\n");
  });

  it("sets the path", async () => {
    const root = await tempRoot();
    const folder = await target();

    await expect(updateProject({ project: PROJECT, root }, { path: folder })).resolves.toMatchObject({ path: folder });
    expect(await read(projectConfig(root))).toBe(`path: ${folder}\n`);
  });

  it("refuses a name that is empty", async () => {
    const root = await tempRoot();

    expect((await storeError(updateProject({ project: PROJECT, root }, { name: "" }))).code).toBe("field-required");
  });

  it("refuses a path that is cleared, which every project states", async () => {
    const root = await tempRoot();
    const change = { path: null } as unknown as ProjectChange;

    expect((await storeError(updateProject({ project: PROJECT, root }, change))).code).toBe("field-required");
  });

  it("refuses a name that is no text, leaving the file as it stands", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "name: Tasma\n");
    const change = { name: 5 } as unknown as ProjectChange;

    expect((await storeError(updateProject({ project: PROJECT, root }, change))).code).toBe("field-required");
    expect(await read(projectConfig(root))).toBe("name: Tasma\n");
  });

  it("refuses a path that is no text, leaving the file as it stands", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "name: Tasma\n");
    const change = { path: 5 } as unknown as ProjectChange;

    expect((await storeError(updateProject({ project: PROJECT, root }, change))).code).toBe("path-invalid");
    expect(await read(projectConfig(root))).toBe("name: Tasma\n");
  });

  it("refuses a path the change carries with no value at all", async () => {
    const root = await tempRoot();

    expect((await storeError(updateProject({ project: PROJECT, root }, { path: undefined }))).code)
      .toBe("field-required");
  });

  it("refuses the tag, which no write of a project sets", async () => {
    const root = await tempRoot();
    const change = { tag: "CLIB" } as unknown as ProjectChange;

    const error = await storeError(updateProject({ project: PROJECT, root }, change));

    expect(error.code).toBe("field-not-writable");
    expect(error.message).toContain("tag");
  });

  it("refuses a key that is no name at all", async () => {
    const root = await tempRoot();
    const change = { [Symbol("wanted")]: "CLIB" } as unknown as ProjectChange;

    const error = await storeError(updateProject({ project: PROJECT, root }, change));

    expect(error.code).toBe("field-not-writable");
    expect(error.message).toContain("Symbol(wanted)");
  });

  it("refuses a path outside the two forms a project path takes", async () => {
    const root = await tempRoot();

    expect((await storeError(updateProject({ project: PROJECT, root }, { path: "tasma" }))).code).toBe("path-invalid");
  });

  it("refuses a path holding a byte no name on a filesystem carries", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "name: Tasma\n");

    expect((await storeError(updateProject({ project: PROJECT, root }, { path: "/tmp/a\0b" }))).code)
      .toBe("path-invalid");
    expect(await read(projectConfig(root))).toBe("name: Tasma\n");
  });

  it("keeps every other key and every comment the file carries", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "# What this project is.\nname: Tasma\nstatuses:\n  - Backlog\n");

    await updateProject({ project: PROJECT, root }, { name: "Renamed" });

    expect(await read(projectConfig(root))).toBe("# What this project is.\nname: Renamed\nstatuses:\n  - Backlog\n");
  });

  it("installs a file a project made by hand never had", async () => {
    const root = await tempRoot();

    await updateProject({ project: PROJECT, root }, { name: "Tasma" });

    expect(await read(projectConfig(root))).toBe("name: Tasma\n");
  });

  it.each([
    ["is a symbolic link, which the rename would replace", async (root: string) => {
      await plant(join(root, "elsewhere.yml"), "name: Tasma\n");
      await symlink(join(root, "elsewhere.yml"), projectConfig(root));
    }],
    ["holds a directory", async (root: string) => mkdir(projectConfig(root))],
    ["cannot be parsed", async (root: string) => plant(projectConfig(root), "name: [Tasma\n")],
    ["holds no mapping", async (root: string) => plant(projectConfig(root), "- Tasma\n- Other\n")],
    ["holds a null and nothing else", async (root: string) => plant(projectConfig(root), "null\n")],
    ["holds that null written as a tilde", async (root: string) => plant(projectConfig(root), "# A note.\n~\n")],
  ])("refuses a file that %s", async (_reason, plantFile) => {
    const root = await tempRoot();
    await plantFile(root);

    expect((await storeError(updateProject({ project: PROJECT, root }, { name: "Renamed" }))).code)
      .toBe("config-invalid");
  });

  it.each([
    ["clears a key", { name: null }],
    ["sets a path", { path: "~/" }],
  ])("refuses a file holding a null and nothing else for a change that %s", async (_reason, change) => {
    const root = await tempRoot();
    await plant(projectConfig(root), "null\n");

    expect((await storeError(updateProject({ project: PROJECT, root }, change))).code).toBe("config-invalid");
    expect(await read(projectConfig(root))).toBe("null\n");
  });

  it.each([
    ["the value it sets stands on", "name: &n Tasma\nother: *n\n", { name: "Renamed" }],
    ["the value it clears stands on", "name: &n Tasma\nother: *n\n", { name: null }],
    ["the key it clears carries", "&k name: Tasma\nother: *k\n", { name: null }],
    ["a value nested in the one it sets carries", "name:\n  full: &n Tasma\nother: *n\n", { name: "R" }],
  ])("refuses a change where an anchor %s is read elsewhere in the file", async (_reason, text, change) => {
    const root = await tempRoot();
    await plant(projectConfig(root), text);

    expect((await storeError(updateProject({ project: PROJECT, root }, change))).code).toBe("config-invalid");
    expect(await read(projectConfig(root))).toBe(text);
  });

  it("refuses a file holding an alias that resolves to no anchor", async () => {
    const root = await tempRoot();
    const text = "name: Tasma\nother: *n\n";
    await plant(projectConfig(root), text);

    expect((await storeError(updateProject({ project: PROJECT, root }, { name: "Renamed" }))).code)
      .toBe("config-invalid");
    expect(await read(projectConfig(root))).toBe(text);
  });

  it.each([
    ["a merge key lends", "sets it", MERGED_NAME, { name: "Renamed" }],
    ["a merge key lends", "clears it", MERGED_NAME, { name: null }],
    ["an alias key names", "sets it", ALIASED_NAME, { name: "Renamed" }],
    ["an alias key names", "clears it", ALIASED_NAME, { name: null }],
  ])("refuses a file where %s the name, for a change that %s", async (_shape, _how, text, change) => {
    const root = await tempRoot();
    await plant(projectConfig(root), text);

    expect((await storeError(updateProject({ project: PROJECT, root }, change))).code).toBe("config-invalid");
    expect(await read(projectConfig(root))).toBe(text);
  });

  it("takes the first key of a file that holds nothing but a comment", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "# Only a note.\n");

    await updateProject({ project: PROJECT, root }, { name: "Tasma" });

    expect(await read(projectConfig(root))).toBe("# Only a note.\n\nname: Tasma\n");
  });

  it("writes beside an anchor no value of the file reads", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "name: Tasma\nfirst: &s Backlog\nsecond: *s\n");

    await updateProject({ project: PROJECT, root }, { name: "Renamed" });

    expect(await read(projectConfig(root))).toBe("name: Renamed\nfirst: &s Backlog\nsecond: *s\n");
  });

  it.each([
    ["holds nothing but a comment", "# Only a note.\n"],
    ["states no name to begin with", "statuses:\n  - Backlog\n"],
  ])("leaves a file that %s as it stands where the change clears the name", async (_reason, text) => {
    const root = await tempRoot();
    await plant(projectConfig(root), text);

    await updateProject({ project: PROJECT, root }, { name: null });

    expect(await read(projectConfig(root))).toBe(text);
  });

  it("installs no file for a change that clears a key a hand-made project never stated", async () => {
    const root = await tempRoot();

    await expect(updateProject({ project: PROJECT, root }, { name: null })).resolves.toMatchObject({
      name: undefined,
    });

    await expect(entries(projectDir(root))).resolves.toEqual([]);
  });

  it("leaves the file as it stands for a change naming no key", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "# Kept.\nname: Tasma\n");

    await expect(updateProject({ project: PROJECT, root }, {})).resolves.toMatchObject({ name: "Tasma" });

    expect(await read(projectConfig(root))).toBe("# Kept.\nname: Tasma\n");
  });

  it("refuses a project no directory of the tree stands under, whatever the change states", async () => {
    const root = await projectsRoot();

    expect((await storeError(updateProject({ project: PROJECT, root }, {}))).code).toBe("project-not-found");
  });

  it("reports a path that names no directory once the write has landed", async () => {
    const root = await tempRoot();
    const gone = join(await bareRoot(), "gone");
    await plant(projectConfig(root), `path: ${gone}\n`);

    const info = await updateProject({ project: PROJECT, root }, { name: "Tasma" });

    expect(codes(info.diagnostics)).toEqual(["path-missing"]);
  });
});

describe("removing a project", () => {
  it("deletes the directory and everything below it", async () => {
    const root = await bareRoot();
    const { tag } = await createProject({ root, path: await target() });
    const handle = openProject({ project: tag, root });
    await handle.createTask({ title: "First" });
    await handle.createTask({ title: "Second" });

    await expect(removeProject({ project: tag, root })).resolves.toBeUndefined();

    await expect(entries(join(root, "projects"))).resolves.toEqual([]);
  });

  it("refuses a tag no directory of the tree stands under", async () => {
    const root = await projectsRoot();

    expect((await storeError(removeProject({ project: PROJECT, root }))).code).toBe("project-not-found");
  });

  it("refuses a project directory that is a symbolic link", async () => {
    const root = await projectsRoot("CLIB");
    await symlink(projectDir(root, "CLIB"), projectDir(root));

    expect((await storeError(removeProject({ project: PROJECT, root }))).code).toBe("project-invalid");
    await expect(entries(projectDir(root, "CLIB"))).resolves.toEqual([]);
  });

  it("deletes a project whose tasks directory no other call of this layer would open", async () => {
    const root = await tempRoot();
    await plant(join(projectDir(root), "tasks"), "not a directory");

    await removeProject({ project: PROJECT, root });

    await expect(entries(join(root, "projects"))).resolves.toEqual([]);
  });

  it("deletes a link it holds and leaves what the link points at alone", async () => {
    const root = await tempRoot();
    const outside = await target("keep");
    await plant(join(outside, "note.md"), "kept");
    await symlink(outside, join(projectDir(root), "elsewhere"));

    await removeProject({ project: PROJECT, root });

    await expect(entries(outside)).resolves.toEqual(["note.md"]);
  });

  it("frees the tag, which a create takes again with its task ids from one", async () => {
    const root = await bareRoot();
    const folder = await target();
    const { tag } = await createProject({ root, path: folder });
    await openProject({ project: tag, root }).createTask({ title: "First" });

    await removeProject({ project: tag, root });

    await expect(discoverProjects(root)).resolves.toEqual([]);
    await expect(createProject({ root, path: folder })).resolves.toMatchObject({ tag: "TASM" });
    await expect(openProject({ project: "TASM", root }).createTask({ title: "Again" })).resolves.toMatchObject({
      id: "TASM-1",
    });
  });
});

describe("a projects directory that is a symbolic link", () => {
  /** A tree whose `projects/` leads to the projects of another tree. */
  async function linkedRoot(): Promise<{ root: string; elsewhere: string }> {
    const elsewhere = await projectsRoot(PROJECT);
    await plant(projectConfig(elsewhere), "name: Tasma\n");
    const root = await bareRoot();
    await symlink(join(elsewhere, "projects"), join(root, "projects"));
    return { root, elsewhere };
  }

  it.each<[string, (root: string) => Promise<unknown>]>([
    ["a create", async (root) => createProject({ root, path: "/", tag: "CLIB" })],
    ["a read", async (root) => readProject({ project: PROJECT, root })],
    ["an update", async (root) => updateProject({ project: PROJECT, root }, { name: "Renamed" })],
    ["a remove", async (root) => removeProject({ project: PROJECT, root })],
  ])("refuses %s, so nothing outside the root the caller named is touched", async (_call, run) => {
    const { root, elsewhere } = await linkedRoot();

    expect((await storeError(run(root))).code).toBe("project-invalid");

    await expect(entries(join(elsewhere, "projects"))).resolves.toEqual([PROJECT]);
    expect(await read(projectConfig(elsewhere))).toBe("name: Tasma\n");
  });
});

describe("the project a create leaves behind", () => {
  it("is listed by the discovery and takes the first task of the store", async () => {
    const root = await bareRoot();
    const { tag } = await createProject({ root, path: await target() });

    await expect(discoverProjects(root)).resolves.toEqual([tag]);

    await expect(openProject({ project: tag, root }).createTask({ title: "First" })).resolves.toMatchObject({
      id: "TASM-1",
    });
    await expect(entries(projectDir(root, tag))).resolves.toEqual(["config.yml", "state.yml", "tasks"]);
  });
});
