import { readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { type ProjectChange, type ProjectInfo, type ResolvedConfig, updateProject } from "@tasma/engine";
import { plantWorkflow, stepsOnly } from "../workflow/helpers.js";
import {
  bareRoot,
  plant,
  project,
  PROJECT,
  projectConfig,
  projectDir,
  read,
  storeError,
  tempRoot,
  userConfig,
} from "./helpers.js";

/** The entries of one directory, in a settled order. */
async function entries(path: string): Promise<string[]> {
  return (await readdir(path)).sort();
}

/** One write of the configuration of the test project. */
function edit(root: string, change: ProjectChange): Promise<ProjectInfo> {
  return updateProject({ project: PROJECT, root }, change);
}

/** The configuration the test project resolves to. */
async function configOf(root: string): Promise<ResolvedConfig> {
  return (await project(root).config()).config;
}

/** A regular file outside the tree, which an instruction entry can name. */
async function document(name = "rules.md"): Promise<string> {
  const path = join(await bareRoot(), name);
  await writeFile(path, "# Rules\n");
  return path;
}

describe("writing the configuration of a project", () => {
  it.each<[string, ProjectChange, Partial<ResolvedConfig>]>([
    ["statuses", { statuses: ["New", "Doing", "Shipped"] }, { statuses: ["New", "Doing", "Shipped"] }],
    ["default_status", { default_status: "To Do" }, { default_status: "To Do" }],
    ["final_statuses", { final_statuses: ["Done", "Backlog"] }, { final_statuses: ["Done", "Backlog"] }],
    ["priorities", { priorities: ["urgent", "later"] }, { priorities: ["urgent", "later"] }],
  ])("sets %s, which the resolved configuration reads back", async (_key, change, expected) => {
    const root = await tempRoot();

    await edit(root, change);

    expect(await configOf(root)).toMatchObject(expected);
  });

  it("sets the workflows, in the order given", async () => {
    const root = await tempRoot();
    await plantWorkflow(root, "review", stepsOnly("check"));
    await plantWorkflow(root, "build", stepsOnly("make"));

    await edit(root, { workflows: ["review", "build"] });

    expect((await configOf(root)).workflows).toEqual(["review", "build"]);
    expect(await read(projectConfig(root))).toBe("workflows:\n  - review\n  - build\n");
  });

  it("sets the instructions, stored as given and resolved on read", async () => {
    const root = await tempRoot();
    const rules = await document();
    const notes = await document("notes.md");
    const fromHome = `~/${relative(homedir(), notes)}`;

    await edit(root, { instructions: [rules, fromHome] });

    expect((await configOf(root)).instructions).toEqual([rules, notes]);
    expect(await read(projectConfig(root))).toBe(`instructions:\n  - ${rules}\n  - ${fromHome}\n`);
  });

  it("replaces a stored list rather than merging the two", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "priorities:\n  - high\n  - low\n");

    await edit(root, { priorities: ["low", "urgent"] });

    expect(await read(projectConfig(root))).toBe("priorities:\n  - low\n  - urgent\n");
  });

  it("writes several keys of one change together", async () => {
    const root = await tempRoot();

    await edit(root, { statuses: ["New", "Shipped"], default_status: "New", final_statuses: ["Shipped"] });

    expect(await configOf(root)).toMatchObject({
      statuses: ["New", "Shipped"],
      default_status: "New",
      final_statuses: ["Shipped"],
    });
  });

  it("keeps every other key and every comment the file carries", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "# What this project is.\nname: Saga\n# The flow.\nstatuses:\n  - New\n");

    await edit(root, { statuses: ["New", "Shipped"] });

    expect(await read(projectConfig(root))).toBe(
      "# What this project is.\nname: Saga\n# The flow.\nstatuses:\n  - New\n  - Shipped\n",
    );
  });

  it("keeps the inline comment and the quotes of a scalar it overwrites", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), 'name: "Saga" # label\ndefault_status: Backlog # new tasks\n');

    await edit(root, { name: "Epic", default_status: "To Do" });

    expect(await read(projectConfig(root))).toBe('name: "Epic" # label\ndefault_status: To Do # new tasks\n');
  });

  // yaml writes the comment on the key line of a block list on a line of its
  // own, below the key, whichever key a write changes.
  it.each<[string, string, ProjectChange, string]>([
    [
      "on the key line of a block list",
      "priorities: # the order\n  - high\n",
      { priorities: ["low", "urgent"] },
      "priorities:\n  # the order\n  - low\n  - urgent\n",
    ],
    [
      "after a flow list",
      "priorities: [high] # the order\n",
      { priorities: ["low", "urgent"] },
      "priorities: [ low, urgent ] # the order\n",
    ],
    [
      "on the key line of a block list it overwrites with a scalar",
      "default_status: # new tasks\n  - Backlog\n",
      { default_status: "To Do" },
      "default_status:\n  # new tasks\n  To Do\n",
    ],
  ])("keeps the comment %s", async (_where, text, change, expected) => {
    const root = await tempRoot();
    await plant(projectConfig(root), text);

    await edit(root, change);

    expect(await read(projectConfig(root))).toBe(expected);
    expect(await configOf(root)).toMatchObject(change);
  });

  it("keeps an anchor no value reads on the value it overwrites", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "name: &n Saga\npriorities: &p [high]\n");

    await edit(root, { name: "Epic", priorities: ["low"] });

    expect(await read(projectConfig(root))).toBe("name: &n Epic\npriorities: &p [ low ]\n");
  });

  it("writes a list over a value written as an alias, and leaves its anchor alone", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "order: &p [high]\npriorities: *p # shared\n");

    await edit(root, { priorities: ["low"] });

    expect(await read(projectConfig(root))).toBe("order: &p [ high ]\npriorities:\n  - low\n  # shared\n");
  });

  it.each([
    ["a tag of another type", "default_status: !!int 3\n"],
    ["a string tag", "default_status: !!str Backlog\n"],
    ["a custom tag", "default_status: !state Backlog\n"],
  ])("drops %s of the scalar it overwrites, and stores the value given", async (_tag, text) => {
    const root = await tempRoot();
    await plant(projectConfig(root), text);

    await edit(root, { default_status: "To Do" });

    expect(await read(projectConfig(root))).toBe("default_status: To Do\n");
    expect((await configOf(root)).default_status).toBe("To Do");
  });

  it("writes a scalar over a stored value that is no scalar", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "default_status:\n  - Backlog\n");

    await edit(root, { default_status: "To Do" });

    expect(await read(projectConfig(root))).toBe("default_status: To Do\n");
  });

  it.each([
    ["statuses", "statuses:\n  - New\n  - Shipped\n", { statuses: ["Backlog", "To Do", "In Progress", "Done"] }],
    ["default_status", "default_status: Done\n", { default_status: "Backlog" }],
    ["final_statuses", "final_statuses:\n  - Backlog\n", { final_statuses: ["Done"] }],
    ["priorities", "priorities:\n  - urgent\n", { priorities: ["high", "medium", "low"] }],
    ["workflows", "workflows:\n  - review\n", { workflows: [] }],
    ["instructions", "instructions:\n  - /srv/rules.md\n", { instructions: [] }],
  ])("clears %s, which then takes the built-in default", async (key, text, expected) => {
    const root = await tempRoot();
    await plant(projectConfig(root), `name: Saga\n${text}`);

    await edit(root, { [key]: null });

    expect(await read(projectConfig(root))).toBe("name: Saga\n");
    expect(await configOf(root)).toMatchObject(expected);
  });

  it("clears the statuses keys, which then come from the main file", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "statuses: [Open, Closed]\ndefault_status: Open\nfinal_statuses: [Closed]\n");
    await plant(projectConfig(root), "statuses: [New, Shipped]\ndefault_status: New\nfinal_statuses: [Shipped]\n");

    await edit(root, { statuses: null, default_status: null, final_statuses: null });

    expect(await configOf(root)).toMatchObject({
      statuses: ["Open", "Closed"],
      default_status: "Open",
      final_statuses: ["Closed"],
    });
  });

  it.each<[string, ProjectChange]>([
    ["an empty statuses", { statuses: [] }],
    ["an empty final_statuses", { final_statuses: [] }],
    ["an empty priorities", { priorities: [] }],
    ["a duplicate status", { statuses: ["New", "New"] }],
    ["a duplicate workflow", { workflows: ["review", "review"] }],
    ["a duplicate instruction", { instructions: ["/srv/rules.md", "/srv/rules.md"] }],
    ["a list that is no list", { priorities: "high" as unknown as string[] }],
    ["an entry that is no text", { priorities: ["high", 5 as unknown as string] }],
    ["an entry that is empty", { workflows: [""] }],
    ["a default_status that is no text", { default_status: 5 as unknown as string }],
    ["a default_status that is empty", { default_status: "" }],
    ["a default_status not among the statuses", { default_status: "Shipped" }],
    ["a final status not among the statuses", { final_statuses: ["Shipped"] }],
    ["statuses that drop the stored default_status", { statuses: ["To Do", "Done"] }],
    ["statuses that drop the stored final status", { statuses: ["Backlog", "To Do"] }],
  ])("refuses %s, leaving the file as it stands", async (_reason, change) => {
    const root = await tempRoot();
    const text = "# Kept.\nstatuses: [Backlog, To Do, Done]\ndefault_status: Backlog\nfinal_statuses: [Done]\n";
    await plant(projectConfig(root), text);

    const error = await storeError(edit(root, change));

    expect(error.code).toBe("config-change-invalid");
    expect(await read(projectConfig(root))).toBe(text);
  });

  it("names the key in the message of a refusal", async () => {
    const root = await tempRoot();

    expect((await storeError(edit(root, { final_statuses: [] }))).message).toContain('"final_statuses"');
    expect((await storeError(edit(root, { statuses: ["A", "A"] }))).message).toContain('"statuses"');
    expect((await storeError(edit(root, { default_status: "" }))).message).toContain('"default_status"');
  });

  it("refuses statuses that drop a default_status the main file states", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "statuses: [Open, Closed]\ndefault_status: Open\n");

    expect((await storeError(edit(root, { statuses: ["Closed"] }))).code).toBe("config-change-invalid");
    await expect(entries(projectDir(root))).resolves.toEqual([]);
  });

  it("refuses a change whose conflict involves no key of it as a fault of the files on disk", async () => {
    const root = await tempRoot();
    const text = "statuses: [New, Doing]\ndefault_status: Shipped\n";
    await plant(projectConfig(root), text);

    expect((await storeError(edit(root, { priorities: ["urgent"] }))).code).toBe("config-invalid");
    expect(await read(projectConfig(root))).toBe(text);
  });

  it("refuses a change of default_status while the main file holds broken statuses", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "statuses: Backlog\n");

    const error = await storeError(edit(root, { default_status: "Backlog" }));

    expect(error.code).toBe("config-invalid");
    expect(error.path).toBe(userConfig(root));
  });

  it("refuses a clear of statuses that exposes broken statuses of the main file", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "statuses: Backlog\n");
    await plant(projectConfig(root), "statuses: [New]\n");

    expect((await storeError(edit(root, { statuses: null }))).code).toBe("config-invalid");
  });

  it("sets statuses while the main file holds broken statuses, which the project value hides", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "statuses: Backlog\n");

    await edit(root, { statuses: ["New", "Shipped"] });

    expect(await read(projectConfig(root))).toBe("statuses:\n  - New\n  - Shipped\n");
  });

  it("repairs a stored default_status that is not among the stored statuses", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "statuses: [New, Shipped]\ndefault_status: Doing\n");

    await edit(root, { default_status: "New" });

    expect((await configOf(root)).default_status).toBe("New");
  });

  it("repairs stored statuses that are no list", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "statuses: New\n");

    await edit(root, { statuses: ["New", "Done"] });

    expect((await configOf(root)).statuses).toEqual(["New", "Done"]);
  });

  it("writes statuses and default_status together where each alone would fail", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "default_status: Backlog\n");

    expect((await storeError(edit(root, { statuses: ["New", "Done"] }))).code).toBe("config-change-invalid");
    expect((await storeError(edit(root, { default_status: "New" }))).code).toBe("config-change-invalid");
    await edit(root, { statuses: ["New", "Done"], default_status: "New" });

    expect(await configOf(root)).toMatchObject({ statuses: ["New", "Done"], default_status: "New" });
  });

  it("refuses a workflow with no directory", async () => {
    const root = await tempRoot();

    expect((await storeError(edit(root, { workflows: ["missing"] }))).code).toBe("workflow-unknown");
  });

  it("refuses a workflow name of a bad form", async () => {
    const root = await tempRoot();

    expect((await storeError(edit(root, { workflows: ["../outside"] }))).code).toBe("workflow-unknown");
  });

  it("refuses a workflow whose file cannot be loaded", async () => {
    const root = await tempRoot();
    await plantWorkflow(root, "review", "steps: [\n");

    expect((await storeError(edit(root, { workflows: ["review"] }))).code).toBe("workflow-invalid");
    await expect(entries(projectDir(root))).resolves.toEqual([]);
  });

  it("reads the workflows from the directory the main file names", async () => {
    const root = await tempRoot();
    const flows = join(root, "elsewhere", "flows");
    await plant(userConfig(root), `workflows_path: ${flows}\n`);
    await plantWorkflow(root, "review", stepsOnly("check"), flows);

    await edit(root, { workflows: ["review"] });

    expect((await configOf(root)).workflows).toEqual(["review"]);
  });

  it("refuses a workflows change while the main file is broken", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "workflows_path: [\n");
    await plantWorkflow(root, "review", stepsOnly("check"));

    expect((await storeError(edit(root, { workflows: ["review"] }))).code).toBe("config-invalid");
  });

  it.each([
    ["is relative", async () => "rules.md"],
    ["names a directory", async () => bareRoot()],
    ["names nothing", async () => join(await bareRoot(), "gone.md")],
    ["holds a NUL byte", async () => "/srv/a\0b.md"],
  ])("refuses an instruction path that %s", async (_reason, stated) => {
    const root = await tempRoot();

    expect((await storeError(edit(root, { instructions: [await stated()] }))).code).toBe("path-invalid");
    await expect(entries(projectDir(root))).resolves.toEqual([]);
  });

  it.each<[string, string, ProjectChange]>([
    ["sets", "statuses: &s [New]\nother: *s\n", { statuses: ["New", "Done"] }],
    ["clears", "priorities: &p [urgent]\nother: *p\n", { priorities: null }],
  ])("refuses a change that %s a key whose anchor another value reads", async (_how, text, change) => {
    const root = await tempRoot();
    await plant(projectConfig(root), text);

    expect((await storeError(edit(root, change))).code).toBe("config-invalid");
    expect(await read(projectConfig(root))).toBe(text);
  });

  it("checks only the keys of the change", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "statuses: Backlog\n");
    await plant(projectConfig(root), "workflows:\n  - gone\ninstructions:\n  - /srv/gone.md\n");

    await edit(root, { name: "Saga" });

    expect(await read(projectConfig(root))).toBe("workflows:\n  - gone\ninstructions:\n  - /srv/gone.md\nname: Saga\n");
  });

  it("sets statuses in a file that holds nothing but a comment", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "# Only a note.\n");

    await edit(root, { statuses: ["New", "Done"] });

    expect(await read(projectConfig(root))).toBe("# Only a note.\n\nstatuses:\n  - New\n  - Done\n");
  });

  it("writes nothing for a clear of a key the file does not state", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "# Kept.\nname: Saga\n");

    await edit(root, { statuses: null, workflows: null });

    expect(await read(projectConfig(root))).toBe("# Kept.\nname: Saga\n");
  });

  it("leaves a task whose status the new list does not hold readable and writable", async () => {
    const root = await tempRoot();
    const { id } = await project(root).createTask({ title: "Planted", status: "In Progress" });

    await edit(root, { statuses: ["Backlog", "Done"] });
    await project(root).updateTask(id, { title: "Renamed" });

    expect((await project(root).readTask(id)).task.frontmatter).toMatchObject({
      title: "Renamed",
      status: "In Progress",
    });
  });
});
