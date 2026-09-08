import { chmod, mkdir, readdir, readlink, rename, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as after } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";
import { discoverProjects, renameProject } from "@tasma/engine";
import type { FileIdentity } from "../../src/store/atomic.js";
import { readWithIdentity } from "../../src/store/atomic.js";
import type { ProjectPaths } from "../../src/store/paths.js";
import { pathsUnder, projectPaths } from "../../src/store/paths.js";
import { publish, reconcile } from "../../src/store/rename.js";
import type { StoreDiagnostic } from "../../src/store/types.js";
import { fixture } from "../format/fixtures.js";
import {
  bareRoot,
  codes,
  plant,
  plantProject,
  PROJECT,
  projectConfig,
  projectDir,
  read,
  statePath,
  storeError,
  tasksDir,
  TIMESTAMP,
} from "./helpers.js";

const NEW = "NEW";

/** A project whose three tasks name one another, carrying what a rewrite must not touch. */
const TASKS: Record<string, string> = {
  "TASM-1.md": `---
id: TASM-1
title: First
status: To Do
created: "${TIMESTAMP}"
updated: "${TIMESTAMP}"
next_comment_id: 1
# What this one is for.
release: soon
---

The first body.
`,
  "TASM-2.md": `---
id: TASM-2
title: Second
status: To Do
created: "${TIMESTAMP}"
updated: "${TIMESTAMP}"
next_comment_id: 1
parent: TASM-1
---

The second body.
`,
  "TASM-3.md": `---
id: TASM-3
title: Third
status: To Do
created: "${TIMESTAMP}"
updated: "${TIMESTAMP}"
next_comment_id: 2
blocked_by: [TASM-1, TASM-2]
---

Held by TASM-1 until it is done.

<!-- task:comment {id: 1, title: "On TASM-1", created: "${TIMESTAMP}", collapsed: true} -->

Still waiting on TASM-1.
`,
};

const CONFIG = "name: Tasma\n# What it stands for.\npath: /srv/tasma\n";
const STATE = "next_task_id: 4\n";

/**
 * How many task files a project needs for its copy to still be running once a
 * test has reached the tree behind it. Each file is written with a flush of its
 * own, so this many stand for tens of milliseconds of copying.
 */
const COPIED_TASKS = 30;

/** A project of `count` task files, each naming itself. */
function tasksOf(tag: string, count: number): Record<string, string> {
  const tasks: Record<string, string> = {};
  for (let number = 1; number <= count; number += 1) {
    const id = `${tag}-${number}`;
    tasks[`${id}.md`] = TASKS["TASM-1.md"]!.replace("id: TASM-1", `id: ${id}`);
  }
  return tasks;
}

/** A tree holding the three tasks, what the project states and its counter. */
async function planted(root: string): Promise<void> {
  await plantProject(root, PROJECT, TASKS);
  await plant(projectConfig(root, PROJECT), CONFIG);
  await plant(statePath(root, PROJECT), STATE);
}

/** The entries of one directory in a settled order: `readdir` answers in the order the directory holds. */
async function entriesOf(path: string): Promise<string[]> {
  return (await readdir(path)).sort();
}

/** Every name under `projects/`, hidden ones included, so a leftover is visible. */
function projectEntries(root: string): Promise<string[]> {
  return entriesOf(join(root, "projects"));
}

/**
 * Waits until a rename has claimed the staging directory it copies into, which
 * is the one moment a test can name: the target check has passed and no entry
 * of the copy has been written yet. A delay would instead race the copy itself
 * and fail on the test's own setup wherever the machine ran the rename first.
 */
async function copying(root: string): Promise<void> {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    if ((await projectEntries(root)).some((name) => name.startsWith(".") && name.endsWith(".tmp"))) return;
    await after(0);
  }
  throw new Error("the rename never claimed a staging directory");
}

/** The whole tree of one project, as `<relative path>` → text, so a test compares two of them. */
async function treeOf(directory: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    tree[path.slice(directory.length)] = await read(path);
  }
  return tree;
}

describe("renaming a project", () => {
  it("carries every task under the new tag, rewriting the ids and nothing else", async () => {
    const root = await bareRoot();
    await planted(root);

    await renameProject({ project: PROJECT, root }, { tag: NEW });

    await expect(projectEntries(root)).resolves.toEqual([NEW]);
    await expect(entriesOf(tasksDir(root, NEW))).resolves.toEqual(["NEW-1.md", "NEW-2.md", "NEW-3.md"]);
    await expect(read(join(tasksDir(root, NEW), "NEW-1.md"))).resolves.toBe(
      TASKS["TASM-1.md"]!.replace("id: TASM-1", "id: NEW-1"),
    );
    await expect(read(join(tasksDir(root, NEW), "NEW-2.md"))).resolves.toBe(
      TASKS["TASM-2.md"]!.replace("id: TASM-2", "id: NEW-2").replace("parent: TASM-1", "parent: NEW-1"),
    );
  });

  it("rewrites blocked_by and leaves the body and the comment that name a task as text alone", async () => {
    const root = await bareRoot();
    await planted(root);

    await renameProject({ project: PROJECT, root }, { tag: NEW });

    const text = await read(join(tasksDir(root, NEW), "NEW-3.md"));
    expect(text).toContain("id: NEW-3");
    expect(text).toContain("- NEW-1");
    expect(text).toContain("- NEW-2");
    expect(text).toContain("Held by TASM-1 until it is done.");
    expect(text).toContain("Still waiting on TASM-1.");
    expect(text).toContain(`<!-- task:comment {id: 1, title: "On TASM-1", created: "${TIMESTAMP}", collapsed: true} -->`);
    expect(text).toContain(`updated: "${TIMESTAMP}"`);
  });

  it("copies what the project states and its counter byte for byte", async () => {
    const root = await bareRoot();
    await planted(root);

    await renameProject({ project: PROJECT, root }, { tag: NEW });

    await expect(read(projectConfig(root, NEW))).resolves.toBe(CONFIG);
    await expect(read(statePath(root, NEW))).resolves.toBe(STATE);
  });

  it("answers with the new tag, what the project states, and no finding", async () => {
    const root = await bareRoot();
    await planted(root);

    await expect(renameProject({ project: PROJECT, root }, { tag: NEW })).resolves.toEqual({
      tag: NEW,
      name: "Tasma",
      path: "/srv/tasma",
      diagnostics: [],
    });
  });

  it("rewrites an id that names the project under another number, and keeps the digits verbatim", async () => {
    const root = await bareRoot();
    await plantProject(root, PROJECT, {
      "TASM-3.md": TASKS["TASM-3.md"]!.replace("id: TASM-3", "id: TASM-7").replace("blocked_by: [TASM-1, TASM-2]", ""),
      "TASM-007.md": TASKS["TASM-1.md"]!.replace("id: TASM-1", "id: TASM-007"),
    });

    await renameProject({ project: PROJECT, root }, { tag: NEW });

    await expect(entriesOf(tasksDir(root, NEW))).resolves.toEqual(["NEW-007.md", "NEW-3.md"]);
    expect(await read(join(tasksDir(root, NEW), "NEW-3.md"))).toContain("id: NEW-7");
    expect(await read(join(tasksDir(root, NEW), "NEW-007.md"))).toContain("id: NEW-007");
  });

  it("carries a project that has no tasks directory at all", async () => {
    const root = await bareRoot();
    await mkdir(projectDir(root, PROJECT), { recursive: true });
    await plant(projectConfig(root, PROJECT), CONFIG);

    await expect(renameProject({ project: PROJECT, root }, { tag: NEW })).resolves.toMatchObject({ tag: NEW });

    await expect(projectEntries(root)).resolves.toEqual([NEW]);
  });
});

describe("what a rename carries without rewriting", () => {
  it("copies every entry that is no task file of the project, and reports the ones a scan names", async () => {
    const root = await bareRoot();
    await plantProject(root, PROJECT, {
      "TASM-1.md": TASKS["TASM-1.md"]!,
      ".TASM-2.md.7.tmp": "a write that did not finish",
      "notes.md": "not a task file",
      "TASM-4.md": TASKS["TASM-1.md"]!.replace("id: TASM-1", "id: OTHER-4"),
      "plan.txt": "no task file either",
    });
    await mkdir(join(tasksDir(root, PROJECT), "drafts"));
    await symlink(join(root, "projects"), join(tasksDir(root, PROJECT), "link"));

    const answer = await renameProject({ project: PROJECT, root }, { tag: NEW });

    const tasks = tasksDir(root, NEW);
    await expect(entriesOf(tasks)).resolves.toEqual(
      [".TASM-2.md.7.tmp", "NEW-1.md", "NEW-4.md", "drafts", "link", "notes.md", "plan.txt"],
    );
    expect(codes(answer.diagnostics).sort()).toEqual(["task-file-foreign", "task-file-unexpected", "temp-file-left"]);
    expect(answer.diagnostics.map((finding) => finding.path).sort()).toEqual(
      [join(tasks, ".TASM-2.md.7.tmp"), join(tasks, "NEW-4.md"), join(tasks, "notes.md")].sort(),
    );
  });

  it("keeps the id a foreign task file carries", async () => {
    const root = await bareRoot();
    await plantProject(root, PROJECT, {
      "TASM-4.md": TASKS["TASM-1.md"]!.replace("id: TASM-1", "id: OTHER-4"),
    });

    await renameProject({ project: PROJECT, root }, { tag: NEW });

    expect(await read(join(tasksDir(root, NEW), "NEW-4.md"))).toContain("id: OTHER-4");
  });

  it("carries what a hand added beside the two files the store writes", async () => {
    const root = await bareRoot();
    await planted(root);
    await plant(join(projectDir(root, PROJECT), "notes.md"), "a note beside the project");

    await renameProject({ project: PROJECT, root }, { tag: NEW });

    await expect(read(join(projectDir(root, NEW), "notes.md"))).resolves.toBe("a note beside the project");
  });

  it("keeps a mode a hand narrowed on the two files the store writes, and widens neither", async () => {
    const root = await bareRoot();
    await planted(root);
    await chmod(projectConfig(root, PROJECT), 0o400);
    await chmod(statePath(root, PROJECT), 0o644);

    await renameProject({ project: PROJECT, root }, { tag: NEW });

    expect((await stat(projectConfig(root, NEW))).mode & 0o777).toBe(0o400);
    expect((await stat(statePath(root, NEW))).mode & 0o777).toBe(0o600);
  });

  it("carries a declaration the user placed as a link as the link it is", async () => {
    const root = await bareRoot();
    await plantProject(root, PROJECT, {});
    const outside = join(root, "outside.yml");
    await plant(outside, CONFIG);
    await symlink(outside, projectConfig(root, PROJECT));

    await expect(renameProject({ project: PROJECT, root }, { tag: NEW })).resolves.toMatchObject({ name: "Tasma" });

    await expect(readlink(projectConfig(root, NEW))).resolves.toBe(outside);
  });

  it("leaves a parent that names another project alone", async () => {
    const root = await bareRoot();
    await plantProject(root, PROJECT, {
      "TASM-2.md": TASKS["TASM-2.md"]!.replace("parent: TASM-1", "parent: OTHER-9"),
    });

    await renameProject({ project: PROJECT, root }, { tag: NEW });

    expect(await read(join(tasksDir(root, NEW), "NEW-2.md"))).toContain("parent: OTHER-9");
  });
});

describe("a rename this engine refuses", () => {
  it.each([
    ["a tag the create rule does not accept", { tag: "tasm" }, "tag-invalid"],
    ["a tag of one letter", { tag: "T" }, "tag-invalid"],
    ["a tag of nine characters", { tag: "ABCDEFGHI" }, "tag-invalid"],
    ["a tag that is no string", { tag: 5 }, "tag-invalid"],
    ["the tag the project already carries", { tag: PROJECT }, "project-exists"],
    ["a key no rename states", { tag: NEW, name: "Tasma" }, "field-not-writable"],
    ["a body naming no tag", {}, "field-required"],
    ["a tag cleared to nothing", { tag: undefined }, "field-required"],
  ])("refuses %s", async (_name, input, code) => {
    const root = await bareRoot();
    await planted(root);
    const before = await treeOf(projectDir(root, PROJECT));

    expect((await storeError(renameProject({ project: PROJECT, root }, input as { tag: string }))).code).toBe(code);

    await expect(projectEntries(root)).resolves.toEqual([PROJECT]);
    await expect(treeOf(projectDir(root, PROJECT))).resolves.toEqual(before);
  });

  it.each([
    ["a directory", async (path: string) => mkdir(path)],
    ["a directory holding a project", async (path: string) => plant(join(path, "config.yml"), CONFIG)],
    ["a plain file", async (path: string) => plant(path, "not a project")],
    ["a symbolic link", async (path: string) => symlink("/tmp", path)],
  ])("refuses a target the new tag already names as %s", async (_name, build) => {
    const root = await bareRoot();
    await planted(root);
    await build(projectDir(root, NEW));
    const before = await treeOf(projectDir(root, PROJECT));

    expect((await storeError(renameProject({ project: PROJECT, root }, { tag: NEW }))).code).toBe("project-exists");

    await expect(treeOf(projectDir(root, PROJECT))).resolves.toEqual(before);
    await expect(projectEntries(root)).resolves.toEqual([NEW, PROJECT]);
  });

  it("refuses a source the tree does not hold", async () => {
    const root = await bareRoot();
    await mkdir(join(root, "projects"), { recursive: true });

    expect((await storeError(renameProject({ project: PROJECT, root }, { tag: NEW }))).code).toBe("project-not-found");
  });

  it("refuses a source tag no path rule accepts", async () => {
    const root = await bareRoot();
    await planted(root);

    expect((await storeError(renameProject({ project: "tasm", root }, { tag: NEW }))).code).toBe("project-invalid");
  });

  it.each([
    ["the projects directory", (root: string) => join(root, "projects")],
    ["the project directory", (root: string) => projectDir(root, PROJECT)],
    ["the tasks directory", (root: string) => tasksDir(root, PROJECT)],
  ])("refuses a symbolic link at %s", async (_name, at) => {
    const root = await bareRoot();
    await planted(root);
    const path = at(root);
    const moved = `${path}.real`;
    await mkdir(join(root, "projects"), { recursive: true });

    await rename(path, moved);
    await symlink(moved, path);

    expect((await storeError(renameProject({ project: PROJECT, root }, { tag: NEW }))).code).toBe("project-invalid");
  });

  it.each([
    ["a file beside the task of that number", async (tasks: string) => plant(join(tasks, "NEW-3.md"), "stray")],
    ["a file alone", async (tasks: string) => plant(join(tasks, "NEW-9.md"), "stray")],
    ["a symbolic link", async (tasks: string) => symlink("/tmp", join(tasks, "NEW-9.md"))],
    ["a directory", async (tasks: string) => mkdir(join(tasks, "NEW-9.md"))],
  ])("refuses an entry of the old tasks directory named after the new project: %s", async (_name, build) => {
    const root = await bareRoot();
    await planted(root);
    await build(tasksDir(root, PROJECT));
    const before = await treeOf(projectDir(root, PROJECT));

    const error = await storeError(renameProject({ project: PROJECT, root }, { tag: NEW }));

    expect(error.code).toBe("task-exists");
    expect(error.path).toMatch(/NEW-[39]\.md$/);
    await expect(projectEntries(root)).resolves.toEqual([PROJECT]);
    await expect(treeOf(projectDir(root, PROJECT))).resolves.toEqual(before);
  });

  it("stops on a task file the format layer cannot read, and renames nothing", async () => {
    const root = await bareRoot();
    await planted(root);
    await plant(join(tasksDir(root, PROJECT), "TASM-2.md"), fixture("invalid/frontmatter-unterminated.md"));
    const before = await treeOf(projectDir(root, PROJECT));

    await expect(renameProject({ project: PROJECT, root }, { tag: NEW })).rejects.toMatchObject({
      name: "TaskParseError",
      code: "frontmatter-unterminated",
      filename: join(tasksDir(root, PROJECT), "TASM-2.md"),
      line: expect.any(Number) as number,
    });

    await expect(projectEntries(root)).resolves.toEqual([PROJECT]);
    await expect(treeOf(projectDir(root, PROJECT))).resolves.toEqual(before);
  });

  it("stops on a frontmatter the serializer cannot address, and renames nothing", async () => {
    const root = await bareRoot();
    await planted(root);
    await plant(
      join(tasksDir(root, PROJECT), "TASM-2.md"),
      TASKS["TASM-2.md"]!.replace("id: TASM-2", "id: &tag TASM-2").replace("parent: TASM-1", "custom: {of: *tag}"),
    );
    const before = await treeOf(projectDir(root, PROJECT));

    await expect(renameProject({ project: PROJECT, root }, { tag: NEW })).rejects.toMatchObject({
      name: "TaskSerializeError",
      code: "anchor-aliased",
    });

    await expect(projectEntries(root)).resolves.toEqual([PROJECT]);
    await expect(treeOf(projectDir(root, PROJECT))).resolves.toEqual(before);
  });
});

describe("the staging directory a rename builds beside the project", () => {
  it("carries a name no listing of the tree reports", async () => {
    const root = await bareRoot();
    await planted(root);
    await mkdir(join(root, "projects", ".NEW.7d3f.tmp"));

    await expect(discoverProjects(root)).resolves.toEqual([PROJECT]);
  });

  it("gives up the name it claimed when the move onto it fails", async () => {
    const root = await bareRoot();
    await mkdir(join(root, "projects"), { recursive: true });
    const renamed = projectPaths({ project: NEW, root });
    const staging = pathsUnder({ project: NEW, root, directory: join(root, "projects", ".NEW.7d3f.tmp") });
    // Nothing a directory rename can install, so the move fails once the name
    // is claimed and the claim is the only thing standing under the new tag.
    await plant(staging.directory, "no directory to install");

    await expect(publish(staging, renamed)).rejects.toMatchObject({ code: "EISDIR" });

    await expect(projectEntries(root)).resolves.toEqual([]);
  });
});

type Staged = { frozen: ProjectPaths; renamed: ProjectPaths; identities: Map<string, FileIdentity> };

/**
 * A frozen project and the project published from it, as the copy step leaves
 * the two: every planted task carried under the new tag, and the identity of
 * each recorded.
 */
async function staged(root: string, tasks: Record<string, string>): Promise<Staged> {
  await plantProject(root, PROJECT, tasks);
  await plant(projectConfig(root, PROJECT), CONFIG);
  await plantProject(root, NEW, {});
  const identities = new Map<string, FileIdentity>();
  for (const [name, text] of Object.entries(tasks)) {
    const carried = await readWithIdentity(join(tasksDir(root, PROJECT), name));
    if (typeof carried === "string") throw new Error(`${name} could not be read`);
    identities.set(name, carried.identity);
    await plant(join(tasksDir(root, NEW), name.replace(PROJECT, NEW)), text.replaceAll(`${PROJECT}-`, `${NEW}-`));
  }
  return {
    frozen: projectPaths({ project: PROJECT, root }),
    renamed: projectPaths({ project: NEW, root }),
    identities,
  };
}

describe("the reconcile that follows a publish", () => {
  it("rewrites a file that changed during the copy", async () => {
    const root = await bareRoot();
    const { frozen, renamed, identities } = await staged(root, { "TASM-2.md": TASKS["TASM-2.md"]! });
    await plant(join(frozen.tasks, "TASM-2.md"), TASKS["TASM-2.md"]!.replace("Second", "Rewritten"));

    await reconcile(frozen, renamed, identities, new Map());

    const text = await read(join(renamed.tasks, "NEW-2.md"));
    expect(text).toContain("title: Rewritten");
    expect(text).toContain("parent: NEW-1");
  });

  it("adds a file the copy never saw", async () => {
    const root = await bareRoot();
    const { frozen, renamed, identities } = await staged(root, {});
    await plant(join(frozen.tasks, "TASM-2.md"), TASKS["TASM-2.md"]!);

    await reconcile(frozen, renamed, identities, new Map());

    expect(await read(join(renamed.tasks, "NEW-2.md"))).toContain("id: NEW-2");
  });

  it("takes away a file the copy carried and the project no longer holds", async () => {
    const root = await bareRoot();
    const { frozen, renamed, identities } = await staged(root, { "TASM-2.md": TASKS["TASM-2.md"]! });

    await rm(join(frozen.tasks, "TASM-2.md"));

    await reconcile(frozen, renamed, identities, new Map());

    await expect(entriesOf(renamed.tasks)).resolves.toEqual([]);
  });

  it("carries a file that broke after the copy as it stands, and reports it", async () => {
    const root = await bareRoot();
    const { frozen, renamed, identities } = await staged(root, { "TASM-2.md": TASKS["TASM-2.md"]! });
    const broken = fixture("invalid/frontmatter-unterminated.md");
    await plant(join(frozen.tasks, "TASM-2.md"), broken);
    const findings = new Map<string, StoreDiagnostic>();

    await reconcile(frozen, renamed, identities, findings);

    await expect(read(join(renamed.tasks, "NEW-2.md"))).resolves.toBe(broken);
    expect([...findings.values()]).toEqual([
      {
        code: "task-file-unreadable",
        message: expect.any(String) as string,
        path: join(renamed.tasks, "NEW-2.md"),
        line: expect.any(Number) as number,
      },
    ]);
  });

  it("copies the counter and what the project states again", async () => {
    const root = await bareRoot();
    const { frozen, renamed, identities } = await staged(root, {});
    await plant(frozen.state, "next_task_id: 12\n");
    await plant(frozen.projectConfig, "name: Renamed\npath: /srv/tasma\n");

    await reconcile(frozen, renamed, identities, new Map());

    await expect(read(renamed.state)).resolves.toBe("next_task_id: 12\n");
    await expect(read(renamed.projectConfig)).resolves.toBe("name: Renamed\npath: /srv/tasma\n");
  });

  it("leaves an absent counter absent", async () => {
    const root = await bareRoot();
    const { frozen, renamed, identities } = await staged(root, {});

    await reconcile(frozen, renamed, identities, new Map());

    await expect(entriesOf(renamed.directory)).resolves.toEqual(["config.yml", "tasks"]);
  });
});

describe("what the reconcile does with a file the copy already carried", () => {
  it("reports a foreign id the write of the copy window left behind", async () => {
    const root = await bareRoot();
    const foreign = TASKS["TASM-2.md"]!.replace("id: TASM-2", "id: OTHER-2");
    const { frozen, renamed, identities } = await staged(root, { "TASM-2.md": TASKS["TASM-2.md"]! });
    await plant(join(frozen.tasks, "TASM-2.md"), foreign);
    const findings = new Map<string, StoreDiagnostic>();

    await reconcile(frozen, renamed, identities, findings);

    expect([...findings.values()]).toEqual([
      { code: "task-file-foreign", message: expect.any(String) as string, path: join(renamed.tasks, "NEW-2.md") },
    ]);
    expect(await read(join(renamed.tasks, "NEW-2.md"))).toContain("id: OTHER-2");
  });

  it("takes no finding of the copy forward for a file it rewrote", async () => {
    const root = await bareRoot();
    const foreign = TASKS["TASM-2.md"]!.replace("id: TASM-2", "id: OTHER-2");
    const { frozen, renamed, identities } = await staged(root, { "TASM-2.md": foreign });
    await plant(join(frozen.tasks, "TASM-2.md"), TASKS["TASM-2.md"]!);
    const findings = new Map([["NEW-2.md", { code: "task-file-foreign" as const, message: "from the copy", path: "old" }]]);

    await reconcile(frozen, renamed, identities, findings);

    expect([...findings.values()]).toEqual([]);
  });

  it("tolerates a file the copy recorded whose name the new project never took", async () => {
    const root = await bareRoot();
    const { frozen, renamed, identities } = await staged(root, {});
    identities.set("TASM-9.md", { ino: 1, size: 1, mtimeMs: 1 });
    const findings = new Map([["NEW-9.md", { code: "task-file-foreign" as const, message: "from the copy", path: "old" }]]);

    await expect(reconcile(frozen, renamed, identities, findings)).resolves.toBeUndefined();

    expect([...findings.values()]).toEqual([]);
  });

  it("passes on a fault of the removal that is not a file already gone", async () => {
    const root = await bareRoot();
    const { frozen, renamed, identities } = await staged(root, { "TASM-2.md": TASKS["TASM-2.md"]! });
    await rm(join(frozen.tasks, "TASM-2.md"));
    await chmod(renamed.tasks, 0o500);
    onTestFinished(() => chmod(renamed.tasks, 0o700));

    await expect(reconcile(frozen, renamed, identities, new Map())).rejects.toMatchObject({ code: "EACCES" });
  });

  it("passes on a fault of the rewrite that is no fault of the file", async () => {
    const root = await bareRoot();
    const { frozen, renamed, identities } = await staged(root, { "TASM-2.md": TASKS["TASM-2.md"]! });
    await plant(join(frozen.tasks, "TASM-2.md"), TASKS["TASM-2.md"]!.replace("Second", "Rewritten"));
    await chmod(renamed.tasks, 0o500);
    onTestFinished(() => chmod(renamed.tasks, 0o700));

    await expect(reconcile(frozen, renamed, identities, new Map())).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("a fault the rename passes on as it stands", () => {
  it("passes on a tasks directory it cannot read", async () => {
    const root = await bareRoot();
    await planted(root);
    await chmod(tasksDir(root, PROJECT), 0o000);
    onTestFinished(() => chmod(tasksDir(root, PROJECT), 0o700));

    await expect(renameProject({ project: PROJECT, root }, { tag: NEW })).rejects.toMatchObject({ code: "EACCES" });

    await expect(projectEntries(root)).resolves.toEqual([PROJECT]);
  });

  it("passes on a fault of the copy that is no entry already gone", async () => {
    const root = await bareRoot();
    await planted(root);
    const closed = join(tasksDir(root, PROJECT), "drafts");
    await mkdir(closed);
    await plant(join(closed, "one.md"), "a draft");
    await chmod(closed, 0o000);
    onTestFinished(() => chmod(closed, 0o700));

    await expect(renameProject({ project: PROJECT, root }, { tag: NEW })).rejects.toMatchObject({ code: "EACCES" });

    await expect(projectEntries(root)).resolves.toEqual([PROJECT]);
  });
});

describe("another hand reaching the tree while the copy runs", () => {
  it("refuses a target a directory took after the check, rather than publishing over it", async () => {
    const root = await bareRoot();
    await plantProject(root, PROJECT, tasksOf(PROJECT, COPIED_TASKS));

    const renaming = renameProject({ project: PROJECT, root }, { tag: NEW });
    await copying(root);
    // What a create leaves between its exclusive directory and the declaration
    // it writes into it. A publish onto the name would take the directory over
    // and let that create answer success for a project it never made.
    await mkdir(join(root, "projects", NEW));

    expect((await storeError(renaming)).code).toBe("project-exists");
    await expect(projectEntries(root)).resolves.toEqual([NEW, PROJECT]);
  });

  it("refuses the rename that lost the race to the target name, and leaves nothing hidden behind", async () => {
    const root = await bareRoot();
    // The slow one passes the target check first and reaches for the name long
    // after the quick one, so its own claim is what meets the name taken.
    await plantProject(root, "SLOW", tasksOf("SLOW", COPIED_TASKS));
    await plantProject(root, "QUICK", {});
    await plant(projectConfig(root, "QUICK"), CONFIG);

    const answers = await Promise.allSettled([
      renameProject({ project: "SLOW", root }, { tag: NEW }),
      renameProject({ project: "QUICK", root }, { tag: NEW }),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual(["rejected", "fulfilled"]);
    expect((answers[0] as PromiseRejectedResult).reason).toMatchObject({ code: "project-exists" });
    await expect(projectEntries(root)).resolves.toEqual(["NEW", "SLOW"]);
  });

  it("skips a task file that goes away between the listing and the copy", async () => {
    const root = await bareRoot();
    await plantProject(root, PROJECT, tasksOf(PROJECT, COPIED_TASKS));

    const renaming = renameProject({ project: PROJECT, root }, { tag: NEW });
    await copying(root);
    await rm(join(tasksDir(root, PROJECT), `${PROJECT}-${COPIED_TASKS}.md`));

    await expect(renaming).resolves.toMatchObject({ tag: NEW });
    await expect(entriesOf(tasksDir(root, NEW))).resolves.toHaveLength(COPIED_TASKS - 1);
  });

  it("carries on when an entry it listed goes away before the copy reaches it", async () => {
    const root = await bareRoot();
    await plantProject(root, PROJECT, { ...tasksOf(PROJECT, COPIED_TASKS), "notes.md": "not a task file" });

    const renaming = renameProject({ project: PROJECT, root }, { tag: NEW });
    await copying(root);
    await rm(join(tasksDir(root, PROJECT), "notes.md"));

    await expect(renaming).resolves.toMatchObject({ tag: NEW });
    await expect(projectEntries(root)).resolves.toEqual([NEW]);
    await expect(entriesOf(tasksDir(root, NEW))).resolves.toHaveLength(COPIED_TASKS);
  });
});
